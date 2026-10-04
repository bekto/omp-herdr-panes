/**
 * Thin wrapper around the herdr CLI (herdr 0.9.1).
 *
 * Success prints a single JSON object on stdout; failures print a JSON `error` object on stderr
 * with a non-zero exit code, and `pane run` prints nothing at all. This module spawns the binary
 * with `Bun.spawn`, parses that JSON as `unknown`, and narrows it with `typeof` / `in` checks — no
 * external data is ever cast. All failures surface as `HerdrError`.
 */

export interface PaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutPane {
	paneId: string;
	rect: PaneRect;
}

export interface Herdr {
	/** Split `target`; the new pane never takes focus. Resolves to the new pane id (e.g. "w3:p2"). */
	split(target: string, direction: "right" | "down", ratio: number): Promise<string>;
	/** Type `command` into the pane's shell and press enter. */
	run(paneId: string, command: string): Promise<void>;
	rename(paneId: string, label: string): Promise<void>;
	/** Close a pane. A pane that no longer exists counts as success. */
	close(paneId: string): Promise<void>;
	/** All panes in the tab that contains `paneId`. */
	layout(paneId: string): Promise<LayoutPane[]>;
}

export class HerdrError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HerdrError";
	}
}

function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Turns a herdr `error` payload into a `HerdrError`; a malformed payload becomes `bad_response`. */
function errorFrom(value: unknown): HerdrError {
	if (typeof value === "object" && value !== null && "code" in value) {
		const code = value.code;
		if (typeof code === "string" && code !== "") {
			const message = "message" in value ? value.message : undefined;
			return new HerdrError(code, typeof message === "string" ? message : code);
		}
	}
	return new HerdrError("bad_response", `malformed error payload: ${describeValue(value)}`);
}

/**
 * Throws when the response carries an `error` payload. A response without one passes whatever its
 * shape; validating that shape is the individual parser's business.
 */
export function assertOk(json: unknown): void {
	if (typeof json === "object" && json !== null && "error" in json) {
		throw errorFrom(json.error);
	}
}

/** Rejects an `error` payload and returns the response's raw `result` field. */
function resultOf(json: unknown, what: string): unknown {
	assertOk(json);
	if (typeof json !== "object" || json === null) {
		throw new HerdrError("bad_response", `${what} response must be an object, got ${describeValue(json)}`);
	}
	if (!("result" in json)) {
		throw new HerdrError("bad_response", `${what} response is missing \`result\`: ${describeValue(json)}`);
	}
	return json.result;
}

export function parseSplitResponse(json: unknown): string {
	const result = resultOf(json, "split");
	if (typeof result !== "object" || result === null || !("pane" in result)) {
		throw new HerdrError("bad_response", `split response \`result.pane\` missing: ${describeValue(result)}`);
	}
	const pane = result.pane;
	if (typeof pane !== "object" || pane === null || !("pane_id" in pane)) {
		throw new HerdrError("bad_response", `split response \`result.pane.pane_id\` missing: ${describeValue(pane)}`);
	}
	const paneId = pane.pane_id;
	if (typeof paneId !== "string" || paneId === "") {
		throw new HerdrError("bad_response", `split response \`result.pane.pane_id\` is not a pane id: ${describeValue(paneId)}`);
	}
	return paneId;
}

/** Returns `undefined` for a malformed pane entry; callers skip those instead of failing. */
function parseLayoutPane(value: unknown): LayoutPane | undefined {
	if (typeof value !== "object" || value === null || !("pane_id" in value) || !("rect" in value)) {
		return undefined;
	}
	const paneId = value.pane_id;
	if (typeof paneId !== "string" || paneId === "") return undefined;

	const rect = value.rect;
	if (typeof rect !== "object" || rect === null) return undefined;
	if (!("x" in rect) || !("y" in rect) || !("width" in rect) || !("height" in rect)) return undefined;
	const { x, y, width, height } = rect;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!Number.isFinite(width) ||
		!Number.isFinite(height)
	) {
		return undefined;
	}
	return { paneId, rect: { x, y, width, height } };
}

export function parseLayoutResponse(json: unknown): LayoutPane[] {
	const result = resultOf(json, "layout");
	if (typeof result !== "object" || result === null || !("layout" in result)) {
		throw new HerdrError("bad_response", `layout response \`result.layout\` missing: ${describeValue(result)}`);
	}
	const layout = result.layout;
	if (typeof layout !== "object" || layout === null || !("panes" in layout) || !Array.isArray(layout.panes)) {
		throw new HerdrError("bad_response", `layout response \`result.layout.panes\` is not an array: ${describeValue(layout)}`);
	}
	const panes: LayoutPane[] = [];
	for (const entry of layout.panes) {
		const pane = parseLayoutPane(entry);
		if (pane !== undefined) panes.push(pane);
	}
	return panes;
}

/** A herdr call normally answers in milliseconds; a hung one must not stall the pane queue forever. */
const CLI_TIMEOUT_MS = 5000;

/** Runs `<bin> <args…>`, parses its JSON output, and rejects herdr error payloads. */
async function runCli(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
	const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new HerdrError("timeout", `${bin} ${args.join(" ")} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
	});
	let stdoutText: string;
	let stderrText: string;
	let exitCode: number;
	try {
		// Raced, not awaited after the kill: a grandchild could keep the pipes open indefinitely.
		[stdoutText, stderrText, exitCode] = await Promise.race([
			Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}

	const stdout = stdoutText.trim();
	const stderr = stderrText.trim();

	// herdr writes error payloads to stderr (with a non-zero exit) and success payloads to stdout.
	const raw = stdout === "" ? stderr : stdout;
	let parsed: unknown;
	let hasJson = false;
	if (raw !== "") {
		try {
			parsed = JSON.parse(raw);
			hasJson = true;
		} catch {
			hasJson = false;
		}
	}
	if (hasJson) {
		assertOk(parsed);
		if (exitCode !== 0) throw new HerdrError("cli_failed", failureDetail(bin, stdout, stderr, exitCode));
		return parsed;
	}
	// `pane run` prints nothing at all on success.
	if (exitCode === 0 && stdout === "") return undefined;
	throw new HerdrError("cli_failed", failureDetail(bin, stdout, stderr, exitCode));
}

function failureDetail(bin: string, stdout: string, stderr: string, exitCode: number): string {
	const detail = stderr === "" ? stdout : stderr;
	if (detail !== "") return detail;
	return exitCode === 0 ? `${bin} printed nothing` : `${bin} exited with code ${exitCode}`;
}

/** `timeoutMs` bounds every call; a call that exceeds it is killed and rejects with code `timeout`. */
export function createHerdrCli(bin?: string, timeoutMs = CLI_TIMEOUT_MS): Herdr {
	const resolved = bin ?? process.env.HERDR_BIN_PATH ?? "herdr";
	const cli = (args: string[]): Promise<unknown> => runCli(resolved, args, timeoutMs);

	return {
		async split(target: string, direction: "right" | "down", ratio: number): Promise<string> {
			const json = await cli([
				"pane",
				"split",
				target,
				"--direction",
				direction,
				"--ratio",
				String(ratio),
				"--no-focus",
			]);
			return parseSplitResponse(json);
		},

		async run(paneId: string, command: string): Promise<void> {
			// `command` stays a single argv element: herdr types it into the pane's shell verbatim.
			assertOk(await cli(["pane", "run", paneId, command]));
		},

		async rename(paneId: string, label: string): Promise<void> {
			assertOk(await cli(["pane", "rename", paneId, label]));
		},

		async close(paneId: string): Promise<void> {
			try {
				assertOk(await cli(["pane", "close", paneId]));
			} catch (error) {
				if (error instanceof HerdrError && error.code === "pane_not_found") return;
				throw error;
			}
		},

		async layout(paneId: string): Promise<LayoutPane[]> {
			const json = await cli(["pane", "layout", "--pane", paneId]);
			return parseLayoutResponse(json);
		},
	};
}
