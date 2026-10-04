/**
 * Pane manager: one stacked Herdr pane per running subagent.
 *
 * Every herdr interaction runs on ONE internal promise chain, so a batch of subagents starting at
 * the same moment can never interleave splits. The tracked map (key = the subagent's sessionFile)
 * is mutated synchronously, so a terminal status that arrives before herdr answered is not lost.
 * Nothing here rejects or throws at its caller: herdr failures are logged and skipped, because an
 * exception escaping an extension callback would take down the whole omp session.
 */

import type { Herdr, LayoutPane } from "./herdr.ts";

export interface PaneManagerConfig {
	/** Pane running omp ($HERDR_PANE_ID). The stack is created to its right. */
	mainPaneId: string;
	/** Width share kept by the main pane on the first split, e.g. 0.6. */
	ratio: number;
	/** Max simultaneously open subagent panes; extra subagents wait in FIFO order for a slot. */
	maxPanes: number;
	/** Delay between a `completed` finish() and closing the pane. */
	closeDelayMs: number;
	/** Delay between any other (failed, aborted, …) finish() and closing the pane. */
	failCloseDelayMs: number;
	/** Shell command typed into a new pane. */
	viewerCommand(sessionFile: string, label: string): string;
}

export type Log = (message: string, context?: Record<string, unknown>) => void;
export type Schedule = (fn: () => void, ms: number) => { cancel(): void };

interface Entry {
	label: string;
	paneId?: string;
	/** Open order, monotonically increasing; breaks height ties when picking the split target. */
	order: number;
	done: boolean;
	/** Terminal lifecycle status (`completed`, `failed`, `aborted`, …) once done. */
	status?: string;
	timer?: { cancel(): void };
}

/** Share of the split pane that a newly stacked pane keeps (the rest stays with the target). */
const STACK_SPLIT_RATIO = 0.5;

export class PaneManager {
	readonly #herdr: Herdr;
	readonly #config: PaneManagerConfig;
	readonly #logger: Log;
	readonly #schedule: Schedule;
	readonly #entries = new Map<string, Entry>();
	/** Subagents that started while every slot was taken: key → label, in arrival order. */
	readonly #waiting = new Map<string, string>();
	/** Tail of the serialized herdr job chain. Never rejects. */
	#queue: Promise<void> = Promise.resolve();
	#nextOrder = 0;

	constructor(herdr: Herdr, config: PaneManagerConfig, log: Log, schedule?: Schedule) {
		this.#herdr = herdr;
		this.#config = config;
		this.#logger = log;
		this.#schedule =
			schedule ??
			defaultSchedule((message, context) => {
				this.#log(message, context);
			});
	}

	/**
	 * Open a pane for this subagent (key = its sessionFile). Resolves when the herdr calls finished.
	 * At the pane limit the oldest finished pane makes room; without one the subagent waits for a
	 * free slot. Never rejects.
	 */
	open(key: string, label: string): Promise<void> {
		const existing = this.#entries.get(key);
		if (existing !== undefined) {
			// A repeated `started` event revives the subagent: drop the pending close, keep its pane.
			this.#cancelTimer(existing);
			existing.done = false;
			if (existing.status !== undefined) {
				existing.status = undefined;
				const paneId = existing.paneId;
				if (paneId !== undefined) void this.#enqueue(() => this.#rename(key, paneId, existing));
			}
			return this.#queue;
		}
		if (this.#waiting.has(key)) return Promise.resolve();
		if (this.#entries.size >= this.#config.maxPanes && !this.#evictFinished()) {
			this.#log("pane limit reached, waiting for a free slot", { key });
			this.#waiting.set(key, label);
			return Promise.resolve();
		}
		// Insert before enqueuing, so a finish() arriving while herdr is still working is not lost.
		const entry: Entry = { label, order: this.#nextOrder, done: false };
		this.#nextOrder += 1;
		this.#entries.set(key, entry);
		return this.#enqueue(() => this.#openPane(key, entry));
	}

	/**
	 * The subagent reached a terminal `status`: mark its pane title ✓/✗ and close it after
	 * closeDelayMs (`completed`) or failCloseDelayMs (anything else). Never throws.
	 */
	finish(key: string, status: string): void {
		if (this.#waiting.delete(key)) return;
		const entry = this.#entries.get(key);
		if (entry === undefined) return;
		entry.done = true;
		entry.status = status;
		// No pane yet: open's job applies the title and schedules the close once the split returns.
		const paneId = entry.paneId;
		if (paneId === undefined) return;
		void this.#enqueue(() => this.#rename(key, paneId, entry));
		this.#scheduleClose(key, entry);
	}

	/** Close every pane now and cancel pending timers. Never rejects. */
	async closeAll(): Promise<void> {
		const closing = [...this.#entries];
		for (const [, entry] of closing) this.#cancelTimer(entry);
		// Forgotten right away: a pane opened from here on belongs to a new subagent.
		this.#entries.clear();
		this.#waiting.clear();
		await this.#enqueue(async () => {
			for (const [key, entry] of closing) {
				// Set late by an open job queued ahead of this one, hence read at run time.
				const paneId = entry.paneId;
				if (paneId === undefined) continue;
				await this.#closePane(paneId, key);
			}
		});
	}

	/** Number of subagents currently tracked (opening, open, or waiting to close). For tests. */
	get size(): number {
		return this.#entries.size;
	}

	/**
	 * Appends a job to the serialized herdr chain. Jobs run strictly one after another; a failing
	 * job logs and the chain continues, so one broken pane cannot stall the others.
	 */
	#enqueue(job: () => Promise<void>): Promise<void> {
		const queued = this.#queue.then(async () => {
			try {
				await job();
			} catch (error) {
				this.#log("herdr job failed", { error: describeError(error) });
			}
		});
		this.#queue = queued;
		return queued;
	}

	/** The queued half of open(): pick a split target, create the pane, start the viewer. */
	async #openPane(key: string, entry: Entry): Promise<void> {
		let paneId: string;
		try {
			paneId = await this.#splitFor(key);
		} catch (error) {
			this.#log("pane split failed", { key, error: describeError(error) });
			if (this.#entries.get(key) === entry) {
				this.#entries.delete(key);
				this.#promote();
			}
			return;
		}
		entry.paneId = paneId;
		// Titled at run time: finish() may already have set the ✓/✗ status.
		await this.#rename(key, paneId, entry);
		try {
			await this.#herdr.run(paneId, this.#config.viewerCommand(key, entry.label));
		} catch (error) {
			this.#log("pane run failed", { key, paneId, error: describeError(error) });
		}
		// finish() may have arrived while herdr was busy: schedule the close it could not.
		if (entry.done) this.#scheduleClose(key, entry);
	}

	/** Splits the tallest stacked pane downwards, or the main pane to the right when there is none. */
	async #splitFor(key: string): Promise<string> {
		const stacked = this.#stackedEntries();
		let target: string | undefined;
		if (stacked.length > 0) {
			try {
				target = tallestPaneId(await this.#herdr.layout(this.#config.mainPaneId), stacked);
			} catch (error) {
				this.#log("pane layout failed", { key, error: describeError(error) });
			}
		}
		// Nothing stacked yet, layout broken, or the candidate was closed by hand: rebuild the
		// column with a fresh split off the main pane.
		if (target === undefined) {
			return this.#herdr.split(this.#config.mainPaneId, "right", this.#config.ratio);
		}
		return this.#herdr.split(target, "down", STACK_SPLIT_RATIO);
	}

	/** Tracked entries that already own a pane, i.e. potential split targets. */
	#stackedEntries(): Entry[] {
		const stacked: Entry[] = [];
		for (const entry of this.#entries.values()) {
			if (entry.paneId !== undefined) stacked.push(entry);
		}
		return stacked;
	}

	/**
	 * Schedules the delayed close of a finished entry; a second call while one is pending is a no-op.
	 * With subagents waiting for a slot the pane closes right away instead.
	 */
	#scheduleClose(key: string, entry: Entry): void {
		if (entry.timer !== undefined) return;
		const delay =
			this.#waiting.size > 0
				? 0
				: entry.status === "completed"
					? this.#config.closeDelayMs
					: this.#config.failCloseDelayMs;
		entry.timer = this.#schedule(() => {
			entry.timer = undefined;
			void this.#enqueueClose(key, entry);
		}, delay);
	}

	/**
	 * Makes room at the pane limit by closing the oldest finished pane now (skipping its close
	 * delay). Returns false when no finished pane exists.
	 */
	#evictFinished(): boolean {
		let oldestKey: string | undefined;
		let oldest: Entry | undefined;
		for (const [key, entry] of this.#entries) {
			// Without a pane id the open job is still running; it closes the pane itself.
			if (!entry.done || entry.paneId === undefined) continue;
			if (oldest === undefined || entry.order < oldest.order) {
				oldestKey = key;
				oldest = entry;
			}
		}
		if (oldestKey === undefined || oldest === undefined) return false;
		const key = oldestKey;
		const paneId = oldest.paneId;
		if (paneId === undefined) return false;
		this.#cancelTimer(oldest);
		this.#entries.delete(key);
		void this.#enqueue(() => this.#closePane(paneId, key));
		return true;
	}

	/** Opens panes for waiting subagents while slots are free, oldest first. */
	#promote(): void {
		for (const [key, label] of this.#waiting) {
			if (this.#entries.size >= this.#config.maxPanes) return;
			this.#waiting.delete(key);
			void this.open(key, label);
		}
	}

	/** Sets the pane title: the label, prefixed with ✓/✗ once the subagent finished. */
	async #rename(key: string, paneId: string, entry: Entry): Promise<void> {
		const mark = entry.status === undefined ? "" : entry.status === "completed" ? "✓ " : "✗ ";
		try {
			await this.#herdr.rename(paneId, `${mark}${entry.label}`);
		} catch (error) {
			this.#log("pane rename failed", { key, paneId, error: describeError(error) });
		}
	}

	/** Queues the actual close; the entry must still be the finished one when the job finally runs. */
	#enqueueClose(key: string, entry: Entry): Promise<void> {
		return this.#enqueue(async () => {
			// Gone, replaced, or revived (done === false) since the timer was armed → leave it alone.
			if (this.#entries.get(key) !== entry || !entry.done) return;
			const paneId = entry.paneId;
			if (paneId === undefined) return;
			// Forgotten before awaiting: a revive during the close gets a fresh pane of its own.
			this.#entries.delete(key);
			this.#promote();
			await this.#closePane(paneId, key);
		});
	}

	async #closePane(paneId: string, key: string): Promise<void> {
		try {
			await this.#herdr.close(paneId);
		} catch (error) {
			this.#log("pane close failed", { key, paneId, error: describeError(error) });
		}
	}

	#cancelTimer(entry: Entry): void {
		if (entry.timer === undefined) return;
		entry.timer.cancel();
		entry.timer = undefined;
	}

	/** Diagnostics must never break the job chain, so a throwing logger is swallowed too. */
	#log(message: string, context?: Record<string, unknown>): void {
		try {
			this.#logger(message, context);
		} catch {
			// Nothing left to report to.
		}
	}
}

/** Pane id of the tallest tracked pane present in `panes`; ties go to the highest open order. */
function tallestPaneId(panes: LayoutPane[], candidates: Entry[]): string | undefined {
	const heights = new Map<string, number>();
	for (const pane of panes) heights.set(pane.paneId, pane.rect.height);
	let bestId: string | undefined;
	let bestHeight = Number.NEGATIVE_INFINITY;
	let bestOrder = Number.NEGATIVE_INFINITY;
	for (const entry of candidates) {
		const paneId = entry.paneId;
		if (paneId === undefined) continue;
		const height = heights.get(paneId);
		if (height === undefined) continue;
		if (height > bestHeight || (height === bestHeight && entry.order > bestOrder)) {
			bestId = paneId;
			bestHeight = height;
			bestOrder = entry.order;
		}
	}
	return bestId;
}

/**
 * `setTimeout`/`clearTimeout` with the callback body wrapped in try/catch: an uncaught throw in a
 * timer kills the whole omp session, so timer failures are reported instead.
 */
function defaultSchedule(log: Log): Schedule {
	return (fn, ms) => {
		const handle = setTimeout(() => {
			try {
				fn();
			} catch (error) {
				log("scheduled callback failed", { error: describeError(error) });
			}
		}, ms);
		return { cancel: () => clearTimeout(handle) };
	};
}

/** Renders an unknown thrown value for a log context, keeping `HerdrError.code` visible. */
function describeError(error: unknown): string {
	if (error instanceof Error) {
		const code: unknown = "code" in error ? error.code : undefined;
		return typeof code === "string"
			? `${error.name} ${code}: ${error.message}`
			: `${error.name}: ${error.message}`;
	}
	return String(error);
}
