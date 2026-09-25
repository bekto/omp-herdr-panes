/**
 * Minimal structural subset of omp's extension API (@oh-my-pi/pi-coding-agent 18.3.1).
 * Declared locally so the project does not depend on the full omp package.
 */
export interface OmpEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface OmpLogger {
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

export interface ExtensionAPI {
	events: OmpEventBus;
	logger: OmpLogger;
	on(
		event: "session_shutdown",
		handler: (event: unknown, ctx: unknown) => void | Promise<void>,
	): void;
}
