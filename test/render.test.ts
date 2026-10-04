import { expect, test } from "bun:test";
import { type RenderOptions, renderEntry, summarizeArgs, usageOf } from "../src/render.ts";

const WIDTH = 80;

/** Renders one entry with the default options (no color unless overridden). */
function render(entry: unknown, options: Partial<RenderOptions> = {}): string[] {
	return renderEntry(entry, { width: WIDTH, color: false, thinkingLines: 2, ...options });
}

/** An assistant entry holding exactly the given content blocks. */
function assistant(...content: unknown[]): unknown {
	return { type: "message", message: { role: "assistant", stopReason: "toolUse", content } };
}

/** A toolResult entry for tool `toolu_1`. */
function toolResult(text: string, isError = false): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "bash",
			isError,
			content: [{ type: "text", text }],
		},
	};
}

/** A user entry whose single text block is `text`. */
function user(text: string): unknown {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

const BASH_CALL = assistant({
	type: "toolCall",
	id: "toolu_1",
	name: "bash",
	arguments: { command: "sleep 3; echo hi", i: "Running sleep and echo" },
	intent: "Running sleep and echo",
});

test("toolCall with intent renders `▸ <name>  <intent>`", () => {
	expect(render(BASH_CALL)).toEqual(["▸ bash  Running sleep and echo"]);
});

test("toolCall without intent falls back to the collapsed arguments JSON", () => {
	const entry = assistant({ type: "toolCall", name: "bash", arguments: { data: { nested: true } } });
	expect(render(entry)).toEqual(['▸ bash  {"data":{"nested":true}}']);
	expect(summarizeArgs({ data: { nested: true } })).toBe('{"data":{"nested":true}}');
});

test("yield without intent summarizes its data record readably", () => {
	const complete = assistant({
		type: "toolCall",
		name: "yield",
		arguments: { data: { status: "complete", checks: { tsc: "clean" }, files_changed: ["a.ts"] } },
	});
	expect(render(complete)).toEqual(["▸ yield  status: complete · checks, files_changed"]);
	const withError = assistant({ type: "toolCall", name: "yield", arguments: { error: "boom\nnow" } });
	expect(render(withError)).toEqual(["▸ yield  error: boom now"]);
	const statusOnly = assistant({ type: "toolCall", name: "yield", arguments: { data: { status: "done" } } });
	expect(render(statusOnly)).toEqual(["▸ yield  status: done"]);
	const keysOnly = assistant({ type: "toolCall", name: "yield", arguments: { data: { checks: "clean", files_changed: [] } } });
	expect(render(keysOnly)).toEqual(["▸ yield  checks, files_changed"]);
	const noData = assistant({ type: "toolCall", name: "yield", arguments: { other: 1 } });
	expect(render(noData)).toEqual(['▸ yield  {"other":1}']);
});

test("toolCall with a multi-line command collapses newlines", () => {
	const entry = assistant({ type: "toolCall", name: "bash", arguments: { command: "ls -la\npwd" } });
	expect(render(entry)).toEqual(["▸ bash  ls -la pwd"]);
});

test("toolResult renders the tool name, first line, remainder count and errors", () => {
	expect(render(toolResult("hi\n\n\nWall time: 3.05 seconds"))).toEqual(["  ✓ bash  hi (+1 lines)"]);
	const failed = render(toolResult("boom", true));
	expect(failed).toHaveLength(1);
	expect(failed[0]?.startsWith("  ✗ bash")).toBe(true);
	expect(render(toolResult("only line"))).toEqual(["  ✓ bash  only line"]);
	expect(render(toolResult(""))).toEqual(["  ✓ bash  (no output)"]);
});

test("toolResult omits the tool name when missing or empty, styles it cyan otherwise", () => {
	const bare = { type: "message", message: { role: "toolResult", toolName: "", content: [{ type: "text", text: "hi" }] } };
	expect(render(bare)).toEqual(["  ✓ hi"]);
	const named = { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "hi" }] } };
	expect(render(named, { color: true }).join("")).toContain("\x1b[36m read \x1b[0m");
	expect(render(named, { color: false })).toEqual(["  ✓ read  hi"]);
});

test("assistant blocks render in order and honour thinkingLines", () => {
	const entry = assistant(
		{ type: "thinking", thinking: "t1\nt2\nt3\nt4\nt5", thinkingSignature: "sig" },
		{ type: "text", text: "All good." },
		{ type: "toolCall", name: "bash", arguments: { command: "ls" }, intent: "Listing files" },
	);
	expect(render(entry)).toEqual(["  ~ t4", "  ~ t5", "All good.", "▸ bash  Listing files"]);
	expect(render(entry, { thinkingLines: 0 })).toEqual(["All good.", "▸ bash  Listing files"]);
});

test("text blocks are wrapped and preserve their words", () => {
	const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
	const options: Partial<RenderOptions> = { width: 20, thinkingLines: 0 };
	const lines = render(assistant({ type: "text", text }), options);
	expect(lines.length).toBeGreaterThan(1);
	for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
	expect(lines.join(" ")).toBe(text);
});

test("text blocks hard-break words longer than the width", () => {
	const word = "z".repeat(45);
	const lines = render(assistant({ type: "text", text: `head ${word} tail` }), { width: 20, thinkingLines: 0 });
	for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
	expect(lines.join("")).toBe(`head${word} tail`);
	expect(lines.join(" ")).not.toContain("  ");
});

test("over-long non-text lines are cut to the width with an ellipsis", () => {
	const entry = assistant({ type: "toolCall", name: "bash", arguments: {}, intent: "x".repeat(300) });
	const lines = render(entry, { width: 40 });
	expect(lines).toHaveLength(1);
	const line = lines[0] ?? "";
	expect(Bun.stringWidth(line)).toBe(40);
	expect(line.endsWith("…")).toBe(true);
});

test("width below 10 is treated as 10", () => {
	const entry = assistant({ type: "toolCall", name: "bash", arguments: {}, intent: "y".repeat(100) });
	const line = render(entry, { width: 3 })[0] ?? "";
	expect(Bun.stringWidth(line)).toBe(10);
});

test("color: true emits ANSI, color: false never does", () => {
	const colored = render(BASH_CALL, { color: true }).join("");
	expect(colored).toContain("\x1b[");
	expect(colored).toContain("\x1b[36mbash\x1b[0m");
	const plain = render(BASH_CALL, { color: false }).join("");
	expect(plain).not.toContain("\x1b[");
	expect(render(toolResult("boom", true), { color: false }).join("")).not.toContain("\x1b[");
	expect(render(toolResult("boom", true), { color: true }).join("")).toContain("\x1b[31m");
});

test("session_init and session_exit render their marker lines", () => {
	expect(render({ type: "session_init", agent: "sonic", resolvedModel: "anthropic/claude-opus-5-5:medium" })).toEqual([
		"● sonic · anthropic/claude-opus-5-5:medium",
	]);
	expect(render({ type: "session_init", agent: "sonic" })).toEqual(["● sonic"]);
	expect(render({ type: "custom", customType: "session_exit", data: { reason: "dispose" } })).toEqual([
		"■ session ended",
	]);
});

test("malformed and irrelevant entries render nothing", () => {
	const ignored: unknown[] = [
		null,
		"x",
		{},
		{ type: "title" },
		{ type: "message" },
		{ type: "message", message: { role: "assistant", content: "str" } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "system", content: [] } },
		{ type: "session" },
		{ type: "model_change" },
		{ type: "custom", customType: "tool_execution_start", data: {} },
		{ type: "custom" },
		{ type: "session_init" },
		[1, 2, 3],
	];
	for (const entry of ignored) expect(render(entry)).toEqual([]);
});

test("control sequences never reach the output, with or without color", () => {
	const evil = "\x1b]0;pwned\x07\x1b[31mred\x1b[0m";
	expect(render(toolResult(evil))).toEqual(["  ✓ bash  red"]);
	const plain = render(toolResult(evil), { color: false }).join("");
	expect(plain).not.toContain("\x1b");
	expect(plain).not.toContain("\x07");
	const colored = render(toolResult(evil), { color: true }).join("");
	expect(colored).not.toContain("pwned");
	expect(colored).not.toContain("\x1b[31m");
	expect(colored).toBe("  \x1b[32m✓\x1b[0m\x1b[36m bash \x1b[0m red");
});

test("C0 controls (except newline), DEL and C1 are removed; tab becomes a space", () => {
	const entry = assistant({ type: "text", text: "a\tb\x01c\x7fd\x85e\rf\none\x07 two" });
	expect(render(entry, { thinkingLines: 0 })).toEqual(["a bcdef", "one two"]);
});

test("truncation width is measured after stripping control sequences", () => {
	const entry = assistant({ type: "toolCall", name: "bash", arguments: {}, intent: `\x1b[31m${"x".repeat(300)}` });
	const line = render(entry, { width: 40 })[0] ?? "";
	expect(Bun.stringWidth(line)).toBe(40);
	expect(line.startsWith("▸ bash  ")).toBe(true);
	expect(line.endsWith("…")).toBe(true);
	expect(line).not.toContain("\x1b");
});

test("assistant stopReason error and aborted append a red line after the content", () => {
	const errored = {
		type: "message",
		message: { role: "assistant", stopReason: "error", errorMessage: "boom\nnow", content: [{ type: "text", text: "partial" }] },
	};
	expect(render(errored)).toEqual(["partial", "✗ error: boom now"]);
	expect(render(errored, { color: true }).join("")).toContain("\x1b[31m✗ error: boom now\x1b[0m");
	expect(render({ type: "message", message: { role: "assistant", stopReason: "error", content: [] } })).toEqual(["✗ error"]);
	expect(render({ type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } })).toEqual(["✗ aborted"]);
});

test("usageOf reads assistant usage and rejects everything else", () => {
	const entry = { type: "message", message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.5 } } } };
	expect(usageOf(entry)).toEqual({ tokens: 10, cost: 0.5 });
	expect(usageOf({ type: "message", message: { role: "assistant" } })).toEqual({ tokens: 0, cost: 0 });
	expect(usageOf({ type: "message", message: { role: "user", usage: { totalTokens: 10 } } })).toBeNull();
	expect(usageOf({ type: "custom", customType: "session_exit" })).toBeNull();
	expect(usageOf(null)).toBeNull();
});

test("session_exit renders totals", () => {
	const exit = { type: "custom", customType: "session_exit", data: {}, timestamp: "2026-10-03T16:05:03.544Z" };
	expect(render(exit, { totals: { tokens: 47200, cost: 0.0008, durationMs: 133000 } })).toEqual([
		"■ session ended · 47.2k tok · $0.0008 · 2m13s",
	]);
	expect(render(exit, { totals: { tokens: 999, cost: 0, durationMs: null } })).toEqual(["■ session ended · 999 tok"]);
	expect(render(exit, { totals: { tokens: 1_200_000, cost: 0, durationMs: 3_840_000 } })).toEqual([
		"■ session ended · 1.2M tok · 1h04m",
	]);
	expect(render(exit, { totals: { tokens: 0, cost: 0, durationMs: null } })).toEqual(["■ session ended"]);
	expect(render(exit)).toEqual(["■ session ended"]);
	expect(render(exit, { totals: { tokens: 12, cost: 0, durationMs: 45_000 } })).toEqual(["■ session ended · 12 tok · 45s"]);
});

test("user messages skip the assignment preamble and cap at 6 lines", () => {
	const text = [
		"Complete assignment thoroughly:",
		"",
		"# Target",
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight",
	].join("\n");
	const lines = render(user(text));
	expect(lines).toHaveLength(7);
	expect(lines[0]).toBe("Task:");
	expect(lines[1]).toBe("  # Target");
	expect(lines[6]).toBe("  five");
	expect(lines.join("\n")).not.toContain("six");
	expect(render(user("# Target"), { color: true })[0]).toBe("\x1b[1mTask:\x1b[0m");
});
