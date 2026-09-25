/**
 * Pure renderer for subagent transcript entries.
 *
 * No I/O: it maps one parsed JSONL entry of a subagent transcript to display lines.
 * Entries arrive as `unknown`; every shape is validated with type guards and anything that does
 * not match a known rule renders as `[]`. `renderEntry` never throws.
 */

export interface RenderOptions {
	/** Terminal columns. Every returned line must fit (visible width <= width). */
	width: number;
	/** Emit ANSI styling. When false, output must contain no escape sequences. */
	color: boolean;
	/** How many trailing non-empty lines of each thinking block to show; 0 hides thinking. */
	thinkingLines: number;
}

type Style = "bold" | "dim" | "red" | "green" | "cyan";

interface Segment {
	text: string;
	style: Style | null;
}

const STYLE_CODES: Record<Style, string> = {
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	cyan: "\x1b[36m",
};

const RESET = "\x1b[0m";
const ELLIPSIS = "…";
const MIN_WIDTH = 10;
const USER_TEXT_MARKER = "Complete assignment thoroughly:";
const USER_TEXT_LINE_LIMIT = 6;
const SUMMARY_KEYS = ["command", "path", "pattern", "query", "url", "task", "code"] as const;

/** Turn one parsed JSONL entry into display lines. Unknown or malformed entries → []. Never throws. */
export function renderEntry(entry: unknown, options: RenderOptions): string[] {
	try {
		const record = recordOf(entry);
		if (record === null) return [];
		const type = record["type"];
		if (type === "session_init") return renderSessionInit(record, options);
		if (type === "message") return renderMessage(record, options);
		if (type === "custom") return renderCustom(record, options);
		return [];
	} catch {
		return [];
	}
}

/** Human-readable summary of a tool call's arguments. */
export function summarizeArgs(args: unknown): string {
	const record = recordOf(args);
	if (record !== null) {
		for (const key of SUMMARY_KEYS) {
			const value = record[key];
			if (typeof value === "string") {
				const collapsed = collapseWhitespace(value);
				if (collapsed.length > 0) return collapsed;
			}
		}
	}
	return stringifyCollapsed(args);
}

// -- entry renderers ---------------------------------------------------------

function renderSessionInit(record: Record<string, unknown>, options: RenderOptions): string[] {
	const agent = stringProp(record, "agent");
	if (agent === null || agent.length === 0) return [];
	const model = stringProp(record, "resolvedModel");
	const text = model === null || model.length === 0 ? `● ${agent}` : `● ${agent} · ${model}`;
	return [composeLine([{ text, style: "bold" }], options, true)];
}

function renderMessage(record: Record<string, unknown>, options: RenderOptions): string[] {
	const message = recordOf(record["message"]);
	if (message === null) return [];
	const role = message["role"];
	if (role === "user") return renderUserMessage(message, options);
	if (role === "assistant") return renderAssistantMessage(message, options);
	if (role === "toolResult") return renderToolResultMessage(message, options);
	return [];
}

function renderUserMessage(message: Record<string, unknown>, options: RenderOptions): string[] {
	const content = message["content"];
	if (!Array.isArray(content)) return [];
	const lines = nonEmptyLines(joinTextBlocks(content));
	if (lines[0] === USER_TEXT_MARKER) lines.shift();
	const out = ["Task:"];
	for (const line of lines.slice(0, USER_TEXT_LINE_LIMIT)) {
		out.push(composeLine([{ text: `  ${line}`, style: "dim" }], options, true));
	}
	return out;
}

function renderAssistantMessage(message: Record<string, unknown>, options: RenderOptions): string[] {
	const content = message["content"];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		const record = recordOf(block);
		if (record === null) continue;
		const blockType = record["type"];
		if (blockType === "thinking") out.push(...renderThinkingBlock(record, options));
		else if (blockType === "text") out.push(...renderTextBlock(record, options));
		else if (blockType === "toolCall") out.push(...renderToolCallBlock(record, options));
	}
	return out;
}

function renderThinkingBlock(record: Record<string, unknown>, options: RenderOptions): string[] {
	const shown = normalizeThinkingLines(options.thinkingLines);
	if (shown === 0) return [];
	const thinking = stringProp(record, "thinking");
	if (thinking === null) return [];
	return nonEmptyLines(thinking)
		.slice(-shown)
		.map((line) => composeLine([{ text: `  ~ ${line}`, style: "dim" }], options, true));
}

function renderTextBlock(record: Record<string, unknown>, options: RenderOptions): string[] {
	const text = stringProp(record, "text");
	if (text === null) return [];
	return wrapText(text, normalizeWidth(options.width));
}

function renderToolCallBlock(record: Record<string, unknown>, options: RenderOptions): string[] {
	const name = stringProp(record, "name");
	if (name === null || name.length === 0) return [];
	const intent = stringProp(record, "intent");
	const collapsedIntent = intent === null ? "" : collapseWhitespace(intent);
	const summary = collapsedIntent.length > 0 ? collapsedIntent : summarizeArgs(record["arguments"]);
	const segments: Segment[] = [
		{ text: "▸ ", style: null },
		{ text: name, style: "cyan" },
	];
	if (summary.length > 0) segments.push({ text: `  ${summary}`, style: null });
	return [composeLine(segments, options, true)];
}

function renderToolResultMessage(message: Record<string, unknown>, options: RenderOptions): string[] {
	const isError = message["isError"] === true;
	const content = message["content"];
	const lines = nonEmptyLines(Array.isArray(content) ? joinTextBlocks(content) : "");
	const segments: Segment[] = [
		{ text: "  ", style: null },
		{ text: isError ? "✗" : "✓", style: isError ? "red" : "green" },
	];
	const first = lines[0];
	if (first === undefined) {
		segments.push({ text: " (no output)", style: null });
	} else {
		segments.push({ text: ` ${first}`, style: null });
		const extra = lines.length - 1;
		if (extra > 0) segments.push({ text: ` (+${extra} lines)`, style: "dim" });
	}
	return [composeLine(segments, options, true)];
}

function renderCustom(record: Record<string, unknown>, options: RenderOptions): string[] {
	if (record["customType"] !== "session_exit") return [];
	return [composeLine([{ text: "■ session ended", style: "dim" }], options, true)];
}

// -- text helpers ------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function stringProp(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

/** Collapse every run of whitespace (including newlines) into a single space. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function stringifyCollapsed(value: unknown): string {
	try {
		const json: unknown = JSON.stringify(value);
		return typeof json === "string" ? collapseWhitespace(json) : "";
	} catch {
		return "";
	}
}

/** Text of every `text` content block, joined with newlines. */
function joinTextBlocks(content: unknown[]): string {
	const parts: string[] = [];
	for (const block of content) {
		const record = recordOf(block);
		if (record === null || record["type"] !== "text") continue;
		const text = stringProp(record, "text");
		if (text !== null) parts.push(text);
	}
	return parts.join("\n");
}

function nonEmptyLines(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.length > 0) lines.push(line);
	}
	return lines;
}

// -- width handling ----------------------------------------------------------

function normalizeWidth(width: number): number {
	if (!Number.isFinite(width)) return MIN_WIDTH;
	const floored = Math.floor(width);
	return floored < MIN_WIDTH ? MIN_WIDTH : floored;
}

function normalizeThinkingLines(count: number): number {
	if (!Number.isFinite(count)) return 0;
	const floored = Math.floor(count);
	return floored < 0 ? 0 : floored;
}

/** Longest prefix of `text` that fits in `maxWidth` visible columns. */
function sliceVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let result = "";
	let used = 0;
	for (const char of text) {
		const charWidth = Bun.stringWidth(char);
		if (used + charWidth > maxWidth) break;
		result += char;
		used += charWidth;
	}
	return result;
}

/**
 * Compose one display line from styled segments. Non-text lines that exceed `width` are cut to
 * `width - 1` visible columns plus an ellipsis; the cut happens on plain text, before ANSI.
 */
function composeLine(segments: Segment[], options: RenderOptions, truncate: boolean): string {
	const width = normalizeWidth(options.width);
	let finalSegments = segments;
	if (truncate) {
		const plain = segments.map((segment) => segment.text).join("");
		if (Bun.stringWidth(plain) > width) finalSegments = truncateSegments(segments, width);
	}
	if (!options.color) return finalSegments.map((segment) => segment.text).join("");
	return finalSegments
		.map((segment) => (segment.style === null ? segment.text : STYLE_CODES[segment.style] + segment.text + RESET))
		.join("");
}

function truncateSegments(segments: Segment[], width: number): Segment[] {
	let remaining = width - Bun.stringWidth(ELLIPSIS);
	const out: Segment[] = [];
	for (const segment of segments) {
		const segmentWidth = Bun.stringWidth(segment.text);
		if (segmentWidth <= remaining) {
			out.push(segment);
			remaining -= segmentWidth;
			continue;
		}
		const head = sliceVisible(segment.text, remaining);
		if (head.length > 0) out.push({ text: head, style: segment.style });
		remaining = 0;
		break;
	}
	out.push({ text: ELLIPSIS, style: null });
	return out;
}

/** Word-wrap `text` to `width`, hard-breaking words longer than `width`; blank lines are kept. */
function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
	if (normalized.trim().length === 0) return [];
	const out: string[] = [];
	for (const raw of normalized.split("\n")) {
		const words = raw.split(/\s+/u).filter((word) => word.length > 0);
		if (words.length === 0) {
			out.push("");
			continue;
		}
		let current = "";
		for (const word of words) {
			let rest = word;
			while (Bun.stringWidth(rest) > width) {
				const head = sliceVisible(rest, width);
				if (head.length === 0) break;
				if (current.length > 0) {
					out.push(current);
					current = "";
				}
				out.push(head);
				rest = rest.slice(head.length);
			}
			if (rest.length === 0) continue;
			if (current.length === 0) current = rest;
			else if (Bun.stringWidth(current) + 1 + Bun.stringWidth(rest) <= width) current += ` ${rest}`;
			else {
				out.push(current);
				current = rest;
			}
		}
		if (current.length > 0) out.push(current);
	}
	return out;
}
