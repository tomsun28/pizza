import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CheckpointRef, CheckpointRequest } from "./types.js";

export interface LocalCheckpointServiceOptions {
	workspace_id: string;
	runtime_id: string;
	checkpointDir: string;
}

interface CheckpointManifest extends CheckpointRef {
	workspace_id: string;
	runtime_id: string;
	cwd: string;
	workspace_hash: string;
	files: Array<{ path: string; hash: string; size: number }>;
}

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".pizza", ".agents"]);

export class LocalCheckpointService {
	constructor(private options: LocalCheckpointServiceOptions) {
		mkdirSync(this.options.checkpointDir, { recursive: true });
	}

	create(request: CheckpointRequest): CheckpointRef {
		const createdAt = Date.now();
		const checkpointId = `ckpt_${createdAt.toString(36)}_${randomUUID().slice(0, 8)}`;
		const path = join(this.options.checkpointDir, `${checkpointId}.json`);
		const files = collectFileManifest(request.cwd);
		const workspaceHash = createHash("sha256")
			.update(files.map((file) => `${file.path}:${file.hash}:${file.size}`).join("\n"))
			.digest("hex");

		const manifest: CheckpointManifest = {
			checkpoint_id: checkpointId,
			path,
			created_at: createdAt,
			event_head: request.event_head,
			event_head_sequence: request.event_head_sequence,
			label: request.label,
			workspace_id: this.options.workspace_id,
			runtime_id: this.options.runtime_id,
			cwd: resolve(request.cwd),
			workspace_hash: workspaceHash,
			files,
		};
		writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
		return {
			checkpoint_id: manifest.checkpoint_id,
			path: manifest.path,
			created_at: manifest.created_at,
			event_head: manifest.event_head,
			event_head_sequence: manifest.event_head_sequence,
			label: manifest.label,
		};
	}

	restore(ref: CheckpointRef): void {
		if (!existsSync(ref.path)) {
			throw new Error(`Checkpoint not found: ${ref.path}`);
		}
		JSON.parse(readFileSync(ref.path, "utf8")) as CheckpointManifest;
	}
}

function collectFileManifest(cwd: string): Array<{ path: string; hash: string; size: number }> {
	const root = resolve(cwd);
	const files: Array<{ path: string; hash: string; size: number }> = [];
	collect(root, root, files);
	files.sort((a, b) => a.path.localeCompare(b.path));
	return files;
}

function collect(root: string, current: string, files: Array<{ path: string; hash: string; size: number }>): void {
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".gitignore") {
			if (entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
		}
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

		const fullPath = join(current, entry.name);
		if (entry.isDirectory()) {
			collect(root, fullPath, files);
			continue;
		}
		if (!entry.isFile()) continue;

		const stat = statSync(fullPath);
		const content = readFileSync(fullPath);
		files.push({
			path: relative(root, fullPath).replace(/\\/g, "/"),
			hash: createHash("sha256").update(content).digest("hex"),
			size: stat.size,
		});
	}
}
