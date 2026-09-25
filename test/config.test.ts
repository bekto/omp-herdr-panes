import { expect, test } from "bun:test";
import { parseLifecycle, readConfig, shellQuote } from "../src/config.ts";

/** Real `task:subagent:lifecycle` payload, plus fields the extension must ignore. */
const LIFECYCLE_SAMPLE = {
	id: "ProbeA",
	agent: "sonic",
	parentToolCallId: "toolu_01a0",
	detached: true,
	agentSource: "bundled",
	status: "started",
	sessionFile: "/home/user/.omp/agent/sessions/-tmp-probe/2026-09-25T14-47-02-753Z_01a0/ProbeA.jsonl",
	index: 0,
};

test("readConfig disables the extension outside Herdr and when switched off", () => {
	expect(readConfig({})).toBeNull();
	expect(readConfig({ HERDR_PANE_ID: "" })).toBeNull();
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES: "0" })).toBeNull();
});

test("readConfig falls back to the documented defaults", () => {
	expect(readConfig({ HERDR_PANE_ID: "w1:p1" })).toEqual({
		mainPaneId: "w1:p1",
		ratio: 0.6,
		closeDelayMs: 3000,
		maxPanes: 6,
	});
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES: "1" })?.maxPanes).toBe(6);
});

test("readConfig honours valid overrides", () => {
	expect(
		readConfig({
			HERDR_PANE_ID: "w1:p1",
			OMP_HERDR_PANES_RATIO: "0.5",
			OMP_HERDR_PANES_CLOSE_DELAY_MS: "0",
			OMP_HERDR_PANES_MAX: "3",
		}),
	).toEqual({ mainPaneId: "w1:p1", ratio: 0.5, closeDelayMs: 0, maxPanes: 3 });
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_RATIO: "0.2" })?.ratio).toBe(0.2);
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_RATIO: "0.9" })?.ratio).toBe(0.9);
});

test("readConfig falls back per field on invalid values", () => {
	const config = readConfig({
		HERDR_PANE_ID: "w1:p1",
		OMP_HERDR_PANES_RATIO: "abc",
		OMP_HERDR_PANES_CLOSE_DELAY_MS: "-1",
		OMP_HERDR_PANES_MAX: "1.5",
	});
	expect(config).toEqual({ mainPaneId: "w1:p1", ratio: 0.6, closeDelayMs: 3000, maxPanes: 6 });

	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_RATIO: "0.05" })?.ratio).toBe(0.6);
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_RATIO: "1" })?.ratio).toBe(0.6);
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_MAX: "0" })?.maxPanes).toBe(6);
	expect(readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_MAX: "-2" })?.maxPanes).toBe(6);
	// A broken value must not leak into the fields that are fine.
	const partial = readConfig({ HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES_RATIO: "nope", OMP_HERDR_PANES_MAX: "2" });
	expect(partial?.ratio).toBe(0.6);
	expect(partial?.maxPanes).toBe(2);
});

test("parseLifecycle accepts the real payload and rejects unusable ones", () => {
	expect(parseLifecycle(LIFECYCLE_SAMPLE)).toEqual({
		id: "ProbeA",
		agent: "sonic",
		status: "started",
		sessionFile: "/home/user/.omp/agent/sessions/-tmp-probe/2026-09-25T14-47-02-753Z_01a0/ProbeA.jsonl",
	});
	expect(parseLifecycle({ ...LIFECYCLE_SAMPLE, status: "completed" })?.status).toBe("completed");

	expect(parseLifecycle(null)).toBeNull();
	expect(parseLifecycle({})).toBeNull();
	expect(parseLifecycle("ProbeA")).toBeNull();
	expect(parseLifecycle([LIFECYCLE_SAMPLE])).toBeNull();
	expect(parseLifecycle({ ...LIFECYCLE_SAMPLE, sessionFile: 42 })).toBeNull();
	expect(parseLifecycle({ ...LIFECYCLE_SAMPLE, sessionFile: "" })).toBeNull();
	expect(parseLifecycle({ ...LIFECYCLE_SAMPLE, agent: undefined })).toBeNull();
	expect(parseLifecycle({ ...LIFECYCLE_SAMPLE, id: null })).toBeNull();
});

test("shellQuote produces words bash reads back verbatim", () => {
	const cases = ["abc", "it's", "/tmp/a b/c.jsonl", "", "ProbeA · sonic", 'two\'quotes"and'];
	expect(shellQuote("abc")).toBe("'abc'");
	expect(shellQuote("it's")).toBe("'it'\\''s'");
	expect(shellQuote("")).toBe("''");

	for (const value of cases) {
		const result = Bun.spawnSync(["bash", "-c", `printf %s ${shellQuote(value)}`]);
		expect(result.stdout.toString()).toBe(value);
	}
});
