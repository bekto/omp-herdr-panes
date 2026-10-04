/**
 * Oh My Pi extension entry: wire `task:subagent:lifecycle` events to Herdr panes.
 *
 * omp runs this factory again in the same process for every child (subagent) session — children
 * re-bind the parent's extensions — so the very first call belongs to the top-level session. Module
 * state is shared by parent and children, which is exactly what makes a single pane stack possible:
 * `manager` is process-wide and every session's events end up in the same `PaneManager`.
 *
 * Child sessions usually share the parent's event bus, so the lifecycle listener is attached once
 * per bus: one listener per subagent would otherwise pile up and handle every event N times.
 *
 * Outside Herdr the config is `null` and the factory returns without registering anything, so the
 * extension is a silent no-op there.
 */

import { fileURLToPath } from "node:url";
import { parseLifecycle, readConfig, shellQuote } from "./config.ts";
import { createHerdrCli } from "./herdr.ts";
import type { ExtensionAPI, OmpEventBus } from "./omp-types.ts";
import { PaneManager } from "./pane-manager.ts";

/** `src/viewer.ts` next to this module; resolved from this file so any install path works. */
const VIEWER_PATH = fileURLToPath(new URL("./viewer.ts", import.meta.url));

/** One `PaneManager` per process, shared by the parent session and every child session. */
let manager: PaneManager | undefined;
/** True once some factory call in this process claimed ownership (the first one is the parent). */
let ownerClaimed = false;
/** Unsubscribe function per event bus that already carries our lifecycle listener. */
const subscriptions = new Map<OmpEventBus, () => void>();

/**
 * Command typed into a fresh pane: `exec` makes the pane die with the viewer, and the leading space
 * keeps the line out of the pane shell's history. `process.execPath` is the `omp` binary, whose
 * embedded Bun runs the TypeScript viewer (`BUN_BE_BUN=1`). `--parent-pid` lets the viewer exit
 * (closing its pane) if omp dies without running its shutdown hook.
 */
function viewerCommand(sessionFile: string, label: string): string {
	const omp = shellQuote(process.execPath);
	const viewer = shellQuote(VIEWER_PATH);
	const args = `${shellQuote(sessionFile)} --title ${shellQuote(label)} --parent-pid ${process.pid}`;
	return ` exec env BUN_BE_BUN=1 ${omp} ${viewer} ${args}`;
}

export default function ompHerdrPanes(pi: ExtensionAPI): void {
	const config = readConfig(process.env);
	if (config === null) return;

	const isOwner = !ownerClaimed;
	ownerClaimed = true;

	manager ??= new PaneManager(
		createHerdrCli(),
		{ ...config, viewerCommand },
		(message, context) => {
			pi.logger.warn(`herdr-panes: ${message}`, context);
		},
	);

	if (!subscriptions.has(pi.events)) {
		const unsubscribe = pi.events.on("task:subagent:lifecycle", (data) => {
			try {
				const event = parseLifecycle(data);
				if (event === null) return;
				if (event.status === "started") {
					void manager?.open(event.sessionFile, `${event.id} · ${event.agent}`);
				} else {
					// Every non-started status is terminal (completed, failed, aborted, …).
					manager?.finish(event.sessionFile, event.status);
				}
			} catch (error) {
				// An exception escaping an extension callback would take the whole session down.
				pi.logger.warn("herdr-panes: lifecycle handler failed", { error: String(error) });
			}
		});
		subscriptions.set(pi.events, unsubscribe);
	}

	if (isOwner) {
		pi.on("session_shutdown", async () => {
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			subscriptions.clear();
			await manager?.closeAll();
			manager = undefined;
			ownerClaimed = false;
		});
	}
}
