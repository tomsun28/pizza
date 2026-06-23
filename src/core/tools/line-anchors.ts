import { createHash } from "crypto";

const HASH_LENGTH = 8;
const LINE_ANCHOR_PATTERN = /^L([1-9]\d*)#([0-9a-f]{8})$/;

export interface LineAnchor {
	line: number;
	hash: string;
}

export interface RangeAnchor {
	start: LineAnchor;
	end: LineAnchor;
}

export interface LineRecord {
	lineNumber: number;
	text: string;
	startIndex: number;
	contentEndIndex: number;
	replacementEndIndex: number;
	hash: string;
}

export interface ResolvedLineRange {
	rangeId: string;
	startLine: number;
	endLine: number;
	startIndex: number;
	endIndex: number;
	existingText: string;
	usedRelocation: boolean;
}

export function hashLine(line: string): string {
	return createHash("sha256").update(line, "utf-8").digest("hex").slice(0, HASH_LENGTH);
}

export function formatLineAnchor(lineNumber: number, line: string): string {
	return `L${lineNumber}#${hashLine(line)}`;
}

export function formatRangeId(start: LineAnchor, end: LineAnchor = start): string {
	const startId = `L${start.line}#${start.hash}`;
	const endId = `L${end.line}#${end.hash}`;
	return startId === endId ? startId : `${startId}..${endId}`;
}

export function looksLikeRangeId(value: string): boolean {
	try {
		parseRangeId(value);
		return true;
	} catch {
		return false;
	}
}

export function parseRangeId(rangeId: string): RangeAnchor {
	const trimmed = rangeId.trim();
	if (!trimmed) {
		throw new Error("rangeId must not be empty.");
	}
	const parts = trimmed.split("..");
	if (parts.length > 2) {
		throw new Error(`Invalid rangeId "${rangeId}". Expected L<line>#<hash> or L<start>#<hash>..L<end>#<hash>.`);
	}
	const start = parseLineAnchor(parts[0], rangeId);
	const end = parseLineAnchor(parts[1] ?? parts[0], rangeId);
	if (start.line > end.line) {
		throw new Error(`Invalid rangeId "${rangeId}". Start line must be before or equal to end line.`);
	}
	return { start, end };
}

export function buildLineRecords(content: string): LineRecord[] {
	if (content.length === 0) {
		return [
			{
				lineNumber: 1,
				text: "",
				startIndex: 0,
				contentEndIndex: 0,
				replacementEndIndex: 0,
				hash: hashLine(""),
			},
		];
	}

	const records: LineRecord[] = [];
	let startIndex = 0;
	let lineNumber = 1;
	for (let i = 0; i < content.length; i++) {
		if (content[i] !== "\n") continue;
		const text = content.slice(startIndex, i);
		records.push({
			lineNumber,
			text,
			startIndex,
			contentEndIndex: i,
			replacementEndIndex: i + 1,
			hash: hashLine(text),
		});
		startIndex = i + 1;
		lineNumber++;
	}

	if (startIndex < content.length) {
		const text = content.slice(startIndex);
		records.push({
			lineNumber,
			text,
			startIndex,
			contentEndIndex: content.length,
			replacementEndIndex: content.length,
			hash: hashLine(text),
		});
	}

	return records;
}

export function annotateTextWithLineAnchors(text: string, startLine = 1): string {
	const lines = text.split("\n");
	if (text.endsWith("\n")) {
		lines.pop();
	}
	if (lines.length === 0) {
		return "";
	}
	return lines.map((line, index) => `${formatLineAnchor(startLine + index, line)} | ${line}`).join("\n");
}

export function resolveRangeId(content: string, rangeId: string, path: string): ResolvedLineRange {
	const anchor = parseRangeId(rangeId);
	const records = buildLineRecords(content);
	const length = anchor.end.line - anchor.start.line + 1;

	const direct = resolveByRecordIndex(records, anchor.start.line - 1, length, anchor);
	if (direct) {
		return buildResolvedRange(content, rangeId, records, direct.startIndex, direct.endIndex, false);
	}

	const candidates: Array<{ startIndex: number; endIndex: number }> = [];
	for (let i = 0; i <= records.length - length; i++) {
		const candidate = resolveByRecordIndex(records, i, length, anchor);
		if (candidate) {
			candidates.push(candidate);
		}
	}

	if (candidates.length === 1) {
		return buildResolvedRange(content, rangeId, records, candidates[0].startIndex, candidates[0].endIndex, true);
	}

	if (candidates.length > 1) {
		throw new Error(
			`rangeId ${rangeId} is ambiguous in ${path}. Re-read a smaller region and use current line anchors.`,
		);
	}

	throw new Error(`rangeId ${rangeId} is stale in ${path}. Re-read the file and use current line anchors.`);
}

function parseLineAnchor(value: string | undefined, originalRangeId: string): LineAnchor {
	const match = value?.match(LINE_ANCHOR_PATTERN);
	if (!match) {
		throw new Error(
			`Invalid rangeId "${originalRangeId}". Expected L<line>#<8-hex-hash> or L<start>#<hash>..L<end>#<hash>.`,
		);
	}
	return {
		line: Number(match[1]),
		hash: match[2],
	};
}

function resolveByRecordIndex(
	records: LineRecord[],
	startIndex: number,
	length: number,
	anchor: RangeAnchor,
): { startIndex: number; endIndex: number } | undefined {
	if (startIndex < 0) return undefined;
	const endIndex = startIndex + length - 1;
	if (endIndex >= records.length) return undefined;
	const start = records[startIndex];
	const end = records[endIndex];
	if (start.hash !== anchor.start.hash || end.hash !== anchor.end.hash) return undefined;
	return { startIndex, endIndex };
}

function buildResolvedRange(
	content: string,
	rangeId: string,
	records: LineRecord[],
	startRecordIndex: number,
	endRecordIndex: number,
	usedRelocation: boolean,
): ResolvedLineRange {
	const start = records[startRecordIndex];
	const end = records[endRecordIndex];
	return {
		rangeId,
		startLine: start.lineNumber,
		endLine: end.lineNumber,
		startIndex: start.startIndex,
		endIndex: end.replacementEndIndex,
		existingText: content.slice(start.startIndex, end.replacementEndIndex),
		usedRelocation,
	};
}
