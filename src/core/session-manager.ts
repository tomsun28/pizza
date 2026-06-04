import type { AgentMessage } from "./agent/types.js";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { readdir } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { v7 as uuidv7 } from "uuid";
import { getAgentDir as getDefaultAgentDir } from "../config.js";
import { SqliteEventStore } from "./event-store/sqlite-store.js";
import {
	deriveWorkspaceId,
	ensureWorkspaceMeta,
	getEventDatabasePath,
	getWorkspaceDir,
	getWorkspaceMetaPath,
} from "./event-store/workspace.js";
import type { EventBase } from "./event-store/types.js";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.js";

export const CURRENT_SESSION_VERSION = 3;
const SESSION_REF_PREFIX = "event-session:";

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

interface SessionCreatedPayload {
	session_id: string;
	name?: string;
	created_by?: "user_explicit" | "auto_inferred" | "fork";
	cwd?: string;
	timestamp?: string;
	parentSession?: string;
}

interface SessionEntryAppendedPayload {
	session_id: string;
	entry: SessionEntry;
	leaf_id?: string | null;
}

function createSessionId(): string {
	return uuidv7();
}

function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return { messages: [], thinkingLevel: "off", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}
	if (!leaf) {
		return { messages: [], thinkingLevel: "off", model: null };
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			messages.push(createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp));
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction!.id);

		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i]!;
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry);
			}
		}

		for (let i = compactionIdx + 1; i < path.length; i++) {
			appendMessage(path[i]!);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, model };
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getLastActivityTime(entries: SessionEntry[]): number | undefined {
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const msgTimestamp = (message as { timestamp?: number }).timestamp;
		if (typeof msgTimestamp === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
			continue;
		}

		const t = new Date(entry.timestamp).getTime();
		if (!Number.isNaN(t)) {
			lastActivityTime = Math.max(lastActivityTime ?? 0, t);
		}
	}

	return lastActivityTime;
}

function makeSessionRef(workspaceId: string, sessionId: string): string {
	return `${SESSION_REF_PREFIX}${workspaceId}:${sessionId}`;
}

function parseSessionRef(ref: string): { workspaceId?: string; sessionId: string } {
	if (ref.endsWith(".jsonl") || ref.includes("/") || ref.includes("\\")) {
		throw new Error("Legacy JSONL session files are no longer supported; sessions now live in events.sqlite.");
	}
	if (!ref.startsWith(SESSION_REF_PREFIX)) {
		return { sessionId: ref };
	}
	const rest = ref.slice(SESSION_REF_PREFIX.length);
	const [workspaceId, sessionId] = rest.split(":");
	if (!sessionId) {
		throw new Error(`Invalid session reference: ${ref}`);
	}
	return { workspaceId, sessionId };
}

function getAgentDirFromSessionDir(sessionDir?: string): string {
	if (!sessionDir) return getDefaultAgentDir();
	return basename(sessionDir) === "sessions" ? dirname(sessionDir) : sessionDir;
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const workspaceId = deriveWorkspaceId(cwd);
	return getWorkspaceDir(workspaceId, agentDir);
}

function createStoreForCwd(cwd: string, agentDir: string, runtimeId = "session_manager"): SqliteEventStore {
	const workspaceId = deriveWorkspaceId(cwd);
	ensureWorkspaceMeta(workspaceId, cwd, agentDir);
	return new SqliteEventStore(workspaceId, getEventDatabasePath(workspaceId, agentDir), runtimeId);
}

function createStoreForWorkspace(workspaceId: string, agentDir: string, runtimeId = "session_manager"): SqliteEventStore {
	return new SqliteEventStore(workspaceId, getEventDatabasePath(workspaceId, agentDir), runtimeId);
}

function readWorkspaceCwd(workspaceId: string, agentDir: string, fallback: string): string {
	const metaPath = getWorkspaceMetaPath(workspaceId, agentDir);
	if (!existsSync(metaPath)) return fallback;
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cwd?: string };
		return meta.cwd ?? fallback;
	} catch {
		return fallback;
	}
}

function getSessionEvents(store: SqliteEventStore, sessionId: string): EventBase[] {
	return store.query({ types: ["SESSION_ENTRY_APPENDED"] }).filter((event) => {
		const payload = event.payload as Partial<SessionEntryAppendedPayload>;
		return payload.session_id === sessionId;
	});
}

function getSessionCreatedEvents(store: SqliteEventStore): EventBase[] {
	return store.query({ types: ["SESSION_CREATED"] });
}

function entryFromEvent(event: EventBase): SessionEntry | undefined {
	const payload = event.payload as Partial<SessionEntryAppendedPayload>;
	return payload.entry;
}

function buildSessionInfoFromEntries(
	workspaceId: string,
	header: SessionHeader,
	entries: SessionEntry[],
	modifiedFallback: Date,
): SessionInfo {
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	let name: string | undefined;

	for (const entry of entries) {
		if (entry.type === "session_info") {
			name = entry.name?.trim() || undefined;
		}

		if (entry.type !== "message") continue;
		messageCount++;

		const message = entry.message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const textContent = extractTextContent(message);
		if (!textContent) continue;

		allMessages.push(textContent);
		if (!firstMessage && message.role === "user") {
			firstMessage = textContent;
		}
	}

	const lastActivity = getLastActivityTime(entries);
	const modified = typeof lastActivity === "number" ? new Date(lastActivity) : modifiedFallback;

	return {
		path: makeSessionRef(workspaceId, header.id),
		id: header.id,
		cwd: header.cwd,
		name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
	};
}

export type SessionListProgress = (loaded: number, total: number) => void;

export class SessionManager {
	private sessionId = "";
	private sessionRef: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private store: SqliteEventStore | undefined;
	private agentDir: string;
	private workspaceId: string;

	private constructor(
		cwd: string,
		agentDir: string,
		sessionRef: string | undefined,
		persist: boolean,
		workspaceIdOverride?: string,
		autoCreate = true,
	) {
		this.cwd = cwd;
		this.persist = persist;
		this.agentDir = agentDir;
		this.workspaceId = workspaceIdOverride ?? deriveWorkspaceId(cwd);
		this.sessionDir = persist ? getWorkspaceDir(this.workspaceId, agentDir) : "";
		if (persist) {
			if (workspaceIdOverride) {
				this.store = createStoreForWorkspace(workspaceIdOverride, agentDir);
			} else {
				this.store = createStoreForCwd(cwd, agentDir);
			}
		} else {
			this.store = new SqliteEventStore("in-memory", ":memory:");
		}

		if (sessionRef) {
			this.setSessionFile(sessionRef);
		} else if (autoCreate) {
			this.newSession();
		}
	}

	setSessionFile(sessionRef: string): void {
		const parsed = parseSessionRef(sessionRef);
		if (parsed.workspaceId && parsed.workspaceId !== this.workspaceId) {
			this.workspaceId = parsed.workspaceId;
			this.cwd = readWorkspaceCwd(parsed.workspaceId, this.agentDir, this.cwd);
			this.sessionDir = this.persist ? getWorkspaceDir(this.workspaceId, this.agentDir) : "";
			this.store?.close();
			this.store = createStoreForWorkspace(parsed.workspaceId, this.agentDir);
		}
		this._loadSession(parsed.sessionId);
	}

	newSession(options?: NewSessionOptions): string | undefined {
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};

		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.sessionRef = this.persist ? makeSessionRef(this.workspaceId, this.sessionId) : undefined;

		if (this.persist) {
			this.store!.append({
				actor_id: "runtime",
				type: "SESSION_CREATED",
				payload: {
					session_id: this.sessionId,
					created_by: options?.parentSession ? "fork" : "user_explicit",
					cwd: this.cwd,
					timestamp,
					parentSession: options?.parentSession,
				} satisfies SessionCreatedPayload,
				session_hint: this.sessionId,
				idempotency_key: `session_created:${this.sessionId}`,
			});
		}

		return this.sessionRef;
	}

	private _loadSession(sessionId: string): void {
		const created = getSessionCreatedEvents(this.store!)
			.filter((event) => (event.payload as Partial<SessionCreatedPayload>).session_id === sessionId)
			.at(-1);
		if (!created) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const payload = created.payload as SessionCreatedPayload;
		this.sessionId = sessionId;
		this.cwd = payload.cwd ?? this.cwd;
		this.sessionRef = this.persist ? makeSessionRef(this.workspaceId, sessionId) : undefined;

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp: payload.timestamp ?? new Date(created.timestamp).toISOString(),
			cwd: this.cwd,
			parentSession: payload.parentSession,
		};

		const entries = getSessionEvents(this.store!, sessionId)
			.map(entryFromEvent)
			.filter((entry): entry is SessionEntry => !!entry);

		this.fileEntries = [header, ...entries];
		this._buildIndex();
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _persist(entry: SessionEntry): void {
		if (!this.persist) return;
		this.store!.append({
			actor_id: "runtime",
			type: "SESSION_ENTRY_APPENDED",
			payload: {
				session_id: this.sessionId,
				entry,
				leaf_id: this.leafId,
			} satisfies SessionEntryAppendedPayload,
			session_hint: this.sessionId,
			idempotency_key: `session_entry:${this.sessionId}:${entry.id}`,
		});
	}

	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (entry.type === "label") {
			if (entry.label) {
				this.labelsById.set(entry.targetId, entry.label);
				this.labelTimestampsById.set(entry.targetId, entry.timestamp);
			} else {
				this.labelsById.delete(entry.targetId);
				this.labelTimestampsById.delete(entry.targetId);
			}
		}
		this._persist(entry);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionRef;
	}

	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getSessionName(): string | undefined {
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			}
		}

		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	resetLeaf(): void {
		this.leafId = null;
	}

	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	createBranchedSession(leafId: string): string | undefined {
		const previousSessionRef = this.sessionRef;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		const pathWithoutLabels = path.filter((e) => e.type !== "label");
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		const newSessionRef = this.newSession({ parentSession: this.persist ? previousSessionRef : undefined });
		for (const entry of pathWithoutLabels) {
			this._appendEntry({ ...entry });
		}
		for (const { targetId, label, timestamp } of labelsToWrite) {
			const entry: LabelEntry = {
				type: "label",
				id: generateId(this.byId),
				parentId: this.leafId,
				timestamp,
				targetId,
				label,
			};
			this._appendEntry(entry);
		}
		return newSessionRef;
	}

	static create(cwd: string, sessionDir?: string): SessionManager {
		return new SessionManager(cwd, getAgentDirFromSessionDir(sessionDir), undefined, true);
	}

	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const parsed = parseSessionRef(path);
		const agentDir = getAgentDirFromSessionDir(sessionDir);
		const workspaceId = parsed.workspaceId ?? deriveWorkspaceId(cwdOverride ?? process.cwd());
		const cwd = cwdOverride ?? readWorkspaceCwd(workspaceId, agentDir, process.cwd());
		const manager = new SessionManager(cwd, agentDir, undefined, true, workspaceId, false);
		manager.setSessionFile(makeSessionRef(workspaceId, parsed.sessionId));
		if (cwdOverride) {
			manager.cwd = cwdOverride;
		}
		return manager;
	}

	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const manager = new SessionManager(cwd, getAgentDirFromSessionDir(sessionDir), undefined, true, undefined, false);
		const sessions = manager._listCurrentWorkspaceSessions();
		if (sessions[0]) {
			manager.setSessionFile(sessions[0].id);
			return manager;
		}
		manager.newSession();
		return manager;
	}

	static inMemory(cwd: string = process.cwd()): SessionManager {
		return new SessionManager(cwd, "", undefined, false);
	}

	static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
		const source = SessionManager.open(sourcePath, sessionDir);
		const target = SessionManager.create(targetCwd, sessionDir);
		target.newSession({ parentSession: source.getSessionFile() });
		for (const entry of source.getEntries()) {
			target._appendEntry({ ...entry });
		}
		return target;
	}

	private _listCurrentWorkspaceSessions(): SessionInfo[] {
		const createdEvents = getSessionCreatedEvents(this.store!);
		const infos: SessionInfo[] = [];

		for (const event of createdEvents) {
			const payload = event.payload as SessionCreatedPayload;
			if (!payload.session_id) continue;
			const header: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: payload.session_id,
				timestamp: payload.timestamp ?? new Date(event.timestamp).toISOString(),
				cwd: payload.cwd ?? this.cwd,
				parentSession: payload.parentSession,
			};
			const entries = getSessionEvents(this.store!, payload.session_id)
				.map(entryFromEvent)
				.filter((entry): entry is SessionEntry => !!entry);
			infos.push(buildSessionInfoFromEntries(this.workspaceId, header, entries, new Date(event.timestamp)));
		}

		infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return infos;
	}

	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const manager = new SessionManager(cwd, getAgentDirFromSessionDir(sessionDir), undefined, true, undefined, false);
		const sessions = manager._listCurrentWorkspaceSessions();
		sessions.forEach((_, index) => onProgress?.(index + 1, sessions.length));
		return sessions;
	}

	static async listAll(onProgress?: SessionListProgress, sessionDir?: string): Promise<SessionInfo[]> {
		const agentDir = getAgentDirFromSessionDir(sessionDir);
		const workspacesDir = join(agentDir, "workspaces");
		if (!existsSync(workspacesDir)) return [];

		const workspaceDirs = (await readdir(workspacesDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(workspacesDir, entry.name));

		const sessions: SessionInfo[] = [];
		let loaded = 0;
		for (const workspaceDir of workspaceDirs) {
			const workspaceId = workspaceDir.split(/[\\/]/).at(-1)!;
			let cwd = process.cwd();
			const metaPath = getWorkspaceMetaPath(workspaceId, agentDir);
			if (existsSync(metaPath)) {
				try {
					const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cwd?: string };
					cwd = meta.cwd ?? cwd;
				} catch {
					// Keep fallback cwd.
				}
			}
			const store = new SqliteEventStore(workspaceId, getEventDatabasePath(workspaceId, agentDir));
			try {
				const createdEvents = getSessionCreatedEvents(store);
				for (const event of createdEvents) {
					const payload = event.payload as SessionCreatedPayload;
					if (!payload.session_id) continue;
					const header: SessionHeader = {
						type: "session",
						version: CURRENT_SESSION_VERSION,
						id: payload.session_id,
						timestamp: payload.timestamp ?? new Date(event.timestamp).toISOString(),
						cwd: payload.cwd ?? cwd,
						parentSession: payload.parentSession,
					};
					const entries = getSessionEvents(store, payload.session_id)
						.map(entryFromEvent)
						.filter((entry): entry is SessionEntry => !!entry);
					sessions.push(buildSessionInfoFromEntries(workspaceId, header, entries, new Date(event.timestamp)));
				}
			} finally {
				store.close();
			}
			loaded++;
			onProgress?.(loaded, workspaceDirs.length);
		}

		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}
}
