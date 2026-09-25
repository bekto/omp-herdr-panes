/**
 * Extension configuration: environment variables read once when the extension loads.
 *
 * Every value is validated here — the rest of the extension can assume a usable config, and an
 * invalid value never disables the feature, it only falls back to its documented default.
 */

export interface Config {
	/** Pane running omp (`HERDR_PANE_ID`). The stack is created to its right. */
	mainPaneId: string;
	/** Width share kept by the main pane on the first split. */
	ratio: number;
	/** Delay between a subagent reaching a terminal state and its pane closing. */
	closeDelayMs: number;
	/** Max simultaneously open subagent panes; extra subagents get no pane. */
	maxPanes: number;
}

const DEFAULT_RATIO = 0.6;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.9;
const DEFAULT_CLOSE_DELAY_MS = 3000;
const DEFAULT_MAX_PANES = 6;

/** Reads a numeric override, falling back to `fallback` when it is malformed or out of range. */
function readNumber(
	raw: string | undefined,
	fallback: number,
	isValid: (value: number) => boolean,
): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || !isValid(value)) return fallback;
	return value;
}

function isRatio(value: number): boolean {
	return value >= MIN_RATIO && value <= MAX_RATIO;
}

function isCloseDelay(value: number): boolean {
	return Number.isInteger(value) && value >= 0;
}

function isMaxPanes(value: number): boolean {
	return Number.isInteger(value) && value >= 1;
}

/**
 * Builds the config from the process environment.
 * Returns `null` (extension disabled) when `HERDR_PANE_ID` is missing/empty or `OMP_HERDR_PANES`
 * is `0`. Invalid numbers fall back to their defaults, per field.
 */
export function readConfig(env: Record<string, string | undefined>): Config | null {
	const mainPaneId = env["HERDR_PANE_ID"];
	if (mainPaneId === undefined || mainPaneId === "") return null;
	if (env["OMP_HERDR_PANES"] === "0") return null;

	return {
		mainPaneId,
		ratio: readNumber(env["OMP_HERDR_PANES_RATIO"], DEFAULT_RATIO, isRatio),
		closeDelayMs: readNumber(env["OMP_HERDR_PANES_CLOSE_DELAY_MS"], DEFAULT_CLOSE_DELAY_MS, isCloseDelay),
		maxPanes: readNumber(env["OMP_HERDR_PANES_MAX"], DEFAULT_MAX_PANES, isMaxPanes),
	};
}

/** Payload of the `task:subagent:lifecycle` event channel. */
export interface LifecycleEvent {
	id: string;
	agent: string;
	status: string;
	sessionFile: string;
}

/** Type guard for `task:subagent:lifecycle` payloads; `null` when any required field is unusable. */
export function parseLifecycle(data: unknown): LifecycleEvent | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	if (!("id" in data) || !("agent" in data) || !("status" in data) || !("sessionFile" in data)) return null;
	// `in` narrowing gives all four fields here; only string-valued non-empty ones are usable.
	const { id, agent, status, sessionFile } = data;
	if (
		typeof id !== "string" ||
		id === "" ||
		typeof agent !== "string" ||
		agent === "" ||
		typeof status !== "string" ||
		status === "" ||
		typeof sessionFile !== "string" ||
		sessionFile === ""
	) {
		return null;
	}
	return { id, agent, status, sessionFile };
}

/** POSIX single-quote a shell word: `abc` → `'abc'`, `it's` → `'it'\''s'`, `""` → `''`. */
export function shellQuote(word: string): string {
	return `'${word.split("'").join(`'\\''`)}'`;
}
