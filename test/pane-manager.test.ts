import { expect, test } from "bun:test";
import { HerdrError } from "../src/herdr.ts";
import type { Herdr } from "../src/herdr.ts";
import { PaneManager } from "../src/pane-manager.ts";
import type { Schedule } from "../src/pane-manager.ts";

// Fake herdr: records every call as a string, hands out pane ids w1:p2, w1:p3, …, resolves through a
// few microtasks (so a real interleaving would be observable) and reports the peak call concurrency.
const MAIN_PANE = "w1:p1";
const MAIN_HEIGHT = 51;

interface FakeHerdr extends Herdr {
	/** Every herdr call in order, e.g. `"split w1:p1 right 0.6"`. */
	calls: string[];
	/** Heights used by `layout`; a pane id missing here is absent from the layout. */
	layoutHeights: Record<string, number>;
	/** Number of upcoming `split` calls that reject. */
	failSplits: number;
	/** Number of upcoming `layout` calls that reject. */
	failLayouts: number;
	/** Highest number of herdr calls that were ever in flight at the same time. */
	maxInFlight: number;
}

interface FakeHerdrOptions {
	layoutHeights?: Record<string, number>;
	failSplits?: number;
	failLayouts?: number;
	/** Microtask hops per call, i.e. how long a call stays "in flight". */
	ticks?: number;
}

function fakeHerdr(options: FakeHerdrOptions = {}): FakeHerdr {
	const ticks = options.ticks ?? 2;
	let inFlight = 0;
	let nextPane = 2;
	const fake: FakeHerdr = {
		calls: [],
		layoutHeights: { ...(options.layoutHeights ?? {}) },
		failSplits: options.failSplits ?? 0,
		failLayouts: options.failLayouts ?? 0,
		maxInFlight: 0,
		split: async (target, direction, ratio) =>
			record(`split ${target} ${direction} ${ratio}`, () => {
				if (fake.failSplits > 0) {
					fake.failSplits -= 1;
					throw new HerdrError("pane_not_found", `pane ${target} not found`);
				}
				const paneId = `w1:p${nextPane}`;
				nextPane += 1;
				return paneId;
			}),
		rename: (paneId, label) => record(`rename ${paneId} ${label}`, () => undefined),
		run: (paneId, command) => record(`run ${paneId} ${command}`, () => undefined),
		close: (paneId) => record(`close ${paneId}`, () => undefined),
		layout: (paneId) =>
			record(`layout ${paneId}`, () => {
				if (fake.failLayouts > 0) {
					fake.failLayouts -= 1;
					throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
				}
				return [
					{ paneId: MAIN_PANE, rect: { x: 0, y: 0, width: 120, height: MAIN_HEIGHT } },
					...Object.entries(fake.layoutHeights).map(([id, height]) => ({
						paneId: id,
						rect: { x: 120, y: 0, width: 80, height },
					})),
				];
			}),
	};

	async function record<T>(call: string, body: () => T): Promise<T> {
		fake.calls.push(call);
		inFlight += 1;
		if (inFlight > fake.maxInFlight) fake.maxInFlight = inFlight;
		try {
			for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
			return body();
		} finally {
			inFlight -= 1;
		}
	}

	return fake;
}

/** Fake `Schedule`: stores the callbacks so the test fires them by hand (no real timers, no sleeps). */
interface FakeTimer {
	ms: number;
	cancelled: boolean;
	/** Runs the stored callback even when cancelled — that is exactly what must stay harmless. */
	fire(): void;
}

function fakeSchedule(): { schedule: Schedule; timers: FakeTimer[] } {
	const timers: FakeTimer[] = [];
	const schedule: Schedule = (fn, ms) => {
		const timer: FakeTimer = { ms, cancelled: false, fire: () => fn() };
		timers.push(timer);
		return { cancel: () => (timer.cancelled = true) };
	};
	return { schedule, timers };
}

interface LogEntry {
	message: string;
	context?: Record<string, unknown>;
}

interface Harness {
	herdr: FakeHerdr;
	timers: FakeTimer[];
	logs: LogEntry[];
	pm: PaneManager;
}

function harness(options: FakeHerdrOptions & { maxPanes?: number } = {}): Harness {
	const herdr = fakeHerdr(options);
	const { schedule, timers } = fakeSchedule();
	const logs: LogEntry[] = [];
	const pm = new PaneManager(
		herdr,
		{
			mainPaneId: MAIN_PANE,
			ratio: 0.6,
			maxPanes: options.maxPanes ?? 6,
			closeDelayMs: 1000,
			viewerCommand: (sessionFile, label) => `omp viewer ${sessionFile} --label ${label}`,
		},
		(message, context) => logs.push(context === undefined ? { message } : { message, context }),
		schedule,
	);
	return { herdr, timers, logs, pm };
}

/** The n-th registered fake timer; fails the test when the manager scheduled none. */
function timer(h: Harness, index = 0): FakeTimer {
	const found = h.timers[index];
	if (found === undefined) throw new Error(`expected a scheduled timer at index ${index}`);
	return found;
}

/** Drains the manager's serialized microtask chain (and the fake herdr's delays). */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function callsMatching(h: Harness, prefix: string): string[] {
	return h.herdr.calls.filter((call) => call.startsWith(prefix));
}

const file = (name: string): string => `/tmp/${name}.jsonl`;

test("the first open splits the main pane to the right, renames and starts the viewer", async () => {
	const h = harness();
	await h.pm.open(file("A"), "agent A");
	expect(h.herdr.calls).toEqual([
		"split w1:p1 right 0.6",
		"rename w1:p2 agent A",
		`run w1:p2 omp viewer ${file("A")} --label agent A`,
	]);
	expect(h.pm.size).toBe(1);
	expect(h.logs).toEqual([]);
});

test("a second open splits the only candidate pane downwards", async () => {
	const h = harness({ layoutHeights: { "w1:p2": 51 } });
	await h.pm.open(file("A"), "agent A");
	await h.pm.open(file("B"), "agent B");
	expect(callsMatching(h, "split ")).toEqual(["split w1:p1 right 0.6", "split w1:p2 down 0.5"]);
	expect(h.herdr.calls).toContain(`run w1:p3 omp viewer ${file("B")} --label agent B`);
	expect(h.pm.size).toBe(2);
});

test("the tallest candidate is split; equal heights go to the higher open order", async () => {
	const h = harness({ layoutHeights: { "w1:p2": 25, "w1:p3": 26 } });
	await h.pm.open(file("A"), "agent A");
	await h.pm.open(file("B"), "agent B");
	await h.pm.open(file("C"), "agent C");
	expect(callsMatching(h, "split ")).toEqual([
		"split w1:p1 right 0.6",
		"split w1:p2 down 0.5",
		"split w1:p3 down 0.5",
	]);

	// w1:p3 (opened after w1:p2) wins the tie against the stale w1:p2 entry.
	h.herdr.layoutHeights = { "w1:p3": 30, "w1:p4": 30 };
	await h.pm.open(file("D"), "agent D");
	expect(callsMatching(h, "split ").at(-1)).toBe("split w1:p4 down 0.5");
});

test("concurrent opens are serialized: splits happen in order and never overlap", async () => {
	const h = harness({ layoutHeights: { "w1:p2": 25, "w1:p3": 26 }, ticks: 5 });
	await Promise.all([
		h.pm.open(file("A"), "agent A"),
		h.pm.open(file("B"), "agent B"),
		h.pm.open(file("C"), "agent C"),
	]);
	expect(callsMatching(h, "split ")).toEqual([
		"split w1:p1 right 0.6",
		"split w1:p2 down 0.5",
		"split w1:p3 down 0.5",
	]);
	expect(h.herdr.maxInFlight).toBe(1);
	expect(h.pm.size).toBe(3);
});

test("opens beyond maxPanes make no herdr call and are logged", async () => {
	const h = harness({ maxPanes: 2, layoutHeights: { "w1:p2": 26 } });
	await h.pm.open(file("A"), "agent A");
	await h.pm.open(file("B"), "agent B");
	const before = [...h.herdr.calls];
	await h.pm.open(file("C"), "agent C");
	expect(h.herdr.calls).toEqual(before);
	expect(h.pm.size).toBe(2);
	expect(h.logs.map((entry) => entry.message)).toEqual(["pane limit reached"]);
	expect(h.logs[0]?.context?.["key"]).toBe(file("C"));
});

test("finish closes the pane only once the scheduled callback fires", async () => {
	const h = harness();
	await h.pm.open(file("A"), "agent A");
	h.pm.finish(file("A"));
	expect(timer(h).ms).toBe(1000);
	expect(callsMatching(h, "close ")).toEqual([]);
	expect(h.pm.size).toBe(1);

	timer(h).fire();
	await settle();
	expect(callsMatching(h, "close ")).toEqual(["close w1:p2"]);
	expect(h.pm.size).toBe(0);
});

test("finish before the split resolves still schedules the close afterwards", async () => {
	const h = harness({ ticks: 4 });
	const opening = h.pm.open(file("A"), "agent A");
	h.pm.finish(file("A"));
	expect(h.timers).toEqual([]); // the pane id is not known yet

	await opening;
	expect(h.timers.length).toBe(1);
	expect(callsMatching(h, "close ")).toEqual([]);

	timer(h).fire();
	await settle();
	expect(callsMatching(h, "close ")).toEqual(["close w1:p2"]);
	expect(h.pm.size).toBe(0);
});

test("a revived subagent cancels the pending close and keeps its pane", async () => {
	const h = harness();
	await h.pm.open(file("A"), "agent A");
	h.pm.finish(file("A"));
	const stale = timer(h);

	await h.pm.open(file("A"), "agent A");
	expect(stale.cancelled).toBe(true);
	stale.fire();
	await settle();
	expect(callsMatching(h, "close ")).toEqual([]);
	expect(h.pm.size).toBe(1);

	h.pm.finish(file("A"));
	timer(h, 1).fire();
	await settle();
	expect(callsMatching(h, "close ")).toEqual(["close w1:p2"]);
	expect(h.pm.size).toBe(0);
});

test("a failed split is logged, drops the entry, and leaves the chain usable", async () => {
	const h = harness({ failSplits: 1 });
	await h.pm.open(file("A"), "agent A");
	expect(h.pm.size).toBe(0);
	expect(h.logs.map((entry) => entry.message)).toEqual(["pane split failed"]);
	expect(String(h.logs[0]?.context?.["error"])).toContain("pane_not_found");
	expect(callsMatching(h, "rename ")).toEqual([]);

	await h.pm.open(file("B"), "agent B");
	expect(callsMatching(h, "split ")).toEqual(["split w1:p1 right 0.6", "split w1:p1 right 0.6"]);
	expect(h.pm.size).toBe(1);
});

test("closeAll closes every pane, cancels pending timers, and closes nothing twice", async () => {
	const h = harness({ layoutHeights: { "w1:p2": 26 } });
	await h.pm.open(file("A"), "agent A");
	await h.pm.open(file("B"), "agent B");
	h.pm.finish(file("A"));
	const stale = timer(h);

	await h.pm.closeAll();
	expect(h.pm.size).toBe(0);
	expect(callsMatching(h, "close ")).toEqual(["close w1:p2", "close w1:p3"]);
	expect(stale.cancelled).toBe(true);

	const afterCloseAll = [...h.herdr.calls];
	stale.fire();
	await settle();
	expect(h.herdr.calls).toEqual(afterCloseAll);
	expect(h.pm.size).toBe(0);
});

test("a candidate missing from the layout falls back to splitting the main pane", async () => {
	const h = harness();
	await h.pm.open(file("A"), "agent A");
	h.herdr.layoutHeights = {}; // the user closed w1:p2 by hand
	await h.pm.open(file("B"), "agent B");
	expect(h.herdr.calls).toContain(`layout ${MAIN_PANE}`);
	expect(callsMatching(h, "split ")).toEqual(["split w1:p1 right 0.6", "split w1:p1 right 0.6"]);
	expect(h.pm.size).toBe(2);
});

test("a failing layout falls back to splitting the main pane", async () => {
	const h = harness({ failLayouts: 1 });
	await h.pm.open(file("A"), "agent A");
	await h.pm.open(file("B"), "agent B");
	expect(h.logs.map((entry) => entry.message)).toEqual(["pane layout failed"]);
	expect(callsMatching(h, "split ")).toEqual(["split w1:p1 right 0.6", "split w1:p1 right 0.6"]);
	expect(h.pm.size).toBe(2);
});
