/**
 * Viewer process — the program that runs inside each subagent pane.
 *
 * ```
 * BUN_BE_BUN=1 omp src/viewer.ts <sessionFile> [--title <label>] [--thinking <n>]
 * ```
 *
 * It clears the screen (hiding the command line herdr typed), prints a title, waits for the
 * transcript file to appear, then tails it: every complete JSONL line is parsed, rendered by
 * `renderEntry` and written to stdout. Read-only, and it never exits on its own — the extension
 * closes the pane. A bad line or an unreadable file is reported once and the
 * viewer keeps running.
 */

import { watch } from "node:fs";
import { createLineSplitter } from "./line-splitter.ts";
import { renderEntry } from "./render.ts";

const USAGE = "usage: viewer <sessionFile> [--title <label>] [--thinking <n>]";
const DEFAULT_THINKING_LINES = 2;
/** Poll cadence while the transcript file does not exist yet. */
const POLL_INTERVAL_MS = 250;
/** Watch events alone are unreliable, so the tail loop also wakes on an interval. */
const TAIL_INTERVAL_MS = 250;
const DEFAULT_WIDTH = 80;
const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface ViewerOptions {
	sessionFile: string;
	title: string;
	thinkingLines: number;
}

/**
 * Parse the CLI arguments. Returns `null` when the required `<sessionFile>` is missing.
 * An unusable `--thinking` value falls back to the default rather than failing the run.
 */
function parseViewerArgs(argv: readonly string[]): ViewerOptions | null {
	let sessionFile: string | null = null;
	let title: string | null = null;
	let thinkingLines = DEFAULT_THINKING_LINES;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--title") {
			const value = argv[index + 1];
			if (value !== undefined) {
				title = value;
				index += 1;
			}
			continue;
		}
		if (arg === "--thinking") {
			const value = argv[index + 1];
			const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
			if (Number.isInteger(parsed) && parsed >= 0) {
				thinkingLines = parsed;
				index += 1;
			}
			continue;
		}
		if (arg !== undefined && sessionFile === null && !arg.startsWith("--")) {
			sessionFile = arg;
		}
	}

	if (sessionFile === null || sessionFile.length === 0) return null;
	return { sessionFile, title: title ?? basenameWithoutJsonl(sessionFile), thinkingLines };
}

/** Last path segment, with a `.jsonl` suffix removed. */
function basenameWithoutJsonl(path: string): string {
	const segments = path.split(/[\\/]/u);
	const base = segments[segments.length - 1] ?? path;
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

const reportedProblems = new Set<string>();

/** Report a problem once, then stay quiet so a persistent failure cannot flood the pane. */
function reportProblem(context: string, error: unknown): void {
	const problem = `${context}: ${describeError(error)}`;
	if (reportedProblems.has(problem)) return;
	reportedProblems.add(problem);
	process.stderr.write(`viewer: ${problem}\n`);
}

function renderTranscriptLine(line: string, options: ViewerOptions): void {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return; // a partially written or malformed line is skipped silently
	}

	const rendered = renderEntry(entry, {
		width: process.stdout.columns || DEFAULT_WIDTH,
		color: process.stdout.isTTY === true,
		thinkingLines: options.thinkingLines,
	});
	if (rendered.length === 0) return; // entry types the renderer ignores produce no blank lines
	process.stdout.write(`${rendered.join("\n")}\n`);
}

/** Poll until the transcript file exists (it appears 1–5 s after the subagent starts). */
async function waitForTranscript(sessionFile: string): Promise<void> {
	if (await Bun.file(sessionFile).exists()) return;
	process.stdout.write(`${DIM}waiting for transcript…${RESET}\n`);
	while (!(await Bun.file(sessionFile).exists())) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, POLL_INTERVAL_MS);
		});
	}
}

/**
 * Tail the transcript from byte 0. Each wake reads whatever was appended since the last read;
 * at most one read is in flight at a time, and a wake arriving during a read schedules exactly
 * one follow-up read.
 */
function startTailLoop(options: ViewerOptions): void {
	const splitter = createLineSplitter();
	let offset = 0;
	let reading = false;
	let wakePending = false;

	const readNewBytes = async (): Promise<void> => {
		let size: number;
		try {
			size = (await Bun.file(options.sessionFile).stat()).size;
		} catch {
			return; // momentarily gone (rotated/replaced); the next wake retries
		}
		if (size < offset) {
			offset = 0; // truncated or replaced
			splitter.reset();
		}
		if (size <= offset) return;

		const chunk = await Bun.file(options.sessionFile).slice(offset, size).bytes();
		offset += chunk.length;
		for (const line of splitter.push(chunk)) renderTranscriptLine(line, options);
	};

	const pump = async (): Promise<void> => {
		if (reading) {
			wakePending = true;
			return;
		}
		reading = true;
		try {
			await readNewBytes();
			while (wakePending) {
				wakePending = false;
				await readNewBytes();
			}
		} catch (error) {
			reportProblem("read failed", error);
		} finally {
			reading = false;
		}
	};

	const wake = (): void => {
		void pump();
	};

	try {
		watch(options.sessionFile, wake);
	} catch (error) {
		reportProblem("watch failed", error);
	}
	setInterval(wake, TAIL_INTERVAL_MS);
	void pump();
}

/** SIGTERM/SIGHUP/SIGINT end the viewer cleanly; every other failure is reported and survived. */
function installProcessHandlers(): void {
	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
		process.on(signal, () => {
			process.exit(0);
		});
	}
	process.on("uncaughtException", (error: Error) => {
		reportProblem("unexpected error", error);
	});
	process.on("unhandledRejection", (reason: unknown) => {
		reportProblem("unhandled rejection", reason);
	});
}

async function main(): Promise<void> {
	const options = parseViewerArgs(process.argv.slice(2));
	if (options === null) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}

	installProcessHandlers();
	process.stdout.write(`${CLEAR_SCREEN}${BOLD}${options.title}${RESET}\n\n`);
	await waitForTranscript(options.sessionFile);
	startTailLoop(options);
}

void main().catch((error: unknown) => {
	reportProblem("startup failed", error);
});
