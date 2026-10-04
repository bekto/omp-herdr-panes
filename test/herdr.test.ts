import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, assertOk, createHerdrCli, parseLayoutResponse, parseSplitResponse } from "../src/herdr.ts";

// Real herdr 0.9.1 stdout samples.
const SPLIT_SAMPLE = `{"id":"cli:pane:split","result":{"pane":{"pane_id":"w3:p2","tab_id":"w3:t1","type":"pane_info"},"type":"pane_info"}}`;
const LAYOUT_SAMPLE = `{"id":"cli:pane:layout","result":{"layout":{"panes":[{"focused":true,"pane_id":"w3:p1","rect":{"height":51,"width":120,"x":0,"y":0}},{"focused":false,"pane_id":"w3:p2","rect":{"height":51,"width":80,"x":120,"y":0}}],"splits":[],"tab_id":"w3:t1","workspace_id":"w3","zoomed":false},"type":"pane_layout"}}`;
const CLOSE_SAMPLE = `{"id":"cli:pane:close","result":{"type":"ok"}}`;
const ERROR_SAMPLE = `{"error":{"code":"pane_not_found","message":"pane w3:p4 not found"},"id":"cli:pane:get"}`;

/** Runs `call`, returning the `HerdrError` it throws (fails the test on anything else). */
function herdrErrorFrom(call: () => unknown): HerdrError {
	try {
		call();
	} catch (error) {
		if (error instanceof HerdrError) return error;
		throw error;
	}
	throw new Error("expected a HerdrError, but nothing was thrown");
}

test("parseSplitResponse returns the new pane id", () => {
	expect(parseSplitResponse(JSON.parse(SPLIT_SAMPLE))).toBe("w3:p2");
});

test("parseSplitResponse surfaces an error payload", () => {
	const error = herdrErrorFrom(() => parseSplitResponse(JSON.parse(ERROR_SAMPLE)));
	expect(error.code).toBe("pane_not_found");
	expect(error.message).toBe("pane w3:p4 not found");
});

test("parseSplitResponse rejects a response without a pane id", () => {
	expect(herdrErrorFrom(() => parseSplitResponse({})).code).toBe("bad_response");
	expect(herdrErrorFrom(() => parseSplitResponse({ result: {} })).code).toBe("bad_response");
	expect(herdrErrorFrom(() => parseSplitResponse({ result: { pane: { pane_id: 7 } } })).code).toBe(
		"bad_response",
	);
	expect(herdrErrorFrom(() => parseSplitResponse("w3:p2")).code).toBe("bad_response");
});

test("parseLayoutResponse maps the layout sample to panes", () => {
	expect(parseLayoutResponse(JSON.parse(LAYOUT_SAMPLE))).toEqual([
		{ paneId: "w3:p1", rect: { x: 0, y: 0, width: 120, height: 51 } },
		{ paneId: "w3:p2", rect: { x: 120, y: 0, width: 80, height: 51 } },
	]);
});

test("parseLayoutResponse skips malformed pane entries", () => {
	const panes = parseLayoutResponse({
		id: "cli:pane:layout",
		result: {
			layout: {
				panes: [
					{ focused: true, pane_id: "w3:p1", rect: { height: 51, width: 120, x: 0, y: 0 } },
					{ focused: false, pane_id: "w3:p2", rect: { height: 51, width: 80 } },
					{ focused: false, pane_id: "", rect: { height: 51, width: 80, x: 120, y: 0 } },
					{ focused: false, pane_id: "w3:pX", rect: { height: "51", width: 80, x: 120, y: 0 } },
					{ focused: false, rect: { height: 51, width: 80, x: 120, y: 0 } },
					"w3:p3",
					{ focused: false, pane_id: "w3:p4", rect: { height: 51, width: 80, x: 120, y: 0 } },
				],
				splits: [],
				tab_id: "w3:t1",
			},
		},
	});

	expect(panes).toEqual([
		{ paneId: "w3:p1", rect: { x: 0, y: 0, width: 120, height: 51 } },
		{ paneId: "w3:p4", rect: { x: 120, y: 0, width: 80, height: 51 } },
	]);
});

test("parseLayoutResponse rejects a malformed envelope", () => {
	expect(herdrErrorFrom(() => parseLayoutResponse(JSON.parse(ERROR_SAMPLE))).code).toBe("pane_not_found");
	expect(herdrErrorFrom(() => parseLayoutResponse({ result: { layout: {} } })).code).toBe("bad_response");
	expect(herdrErrorFrom(() => parseLayoutResponse({ result: { layout: { panes: "nope" } } })).code).toBe(
		"bad_response",
	);
});

test("assertOk passes on the close sample and throws on the error sample", () => {
	expect(() => assertOk(JSON.parse(CLOSE_SAMPLE))).not.toThrow();
	expect(assertOk({ result: { type: "ok" } })).toBeUndefined();

	const error = herdrErrorFrom(() => assertOk(JSON.parse(ERROR_SAMPLE)));
	expect(error.code).toBe("pane_not_found");
	expect(error.message).toBe("pane w3:p4 not found");
});

test("assertOk reports a malformed error payload as bad_response", () => {
	expect(herdrErrorFrom(() => assertOk({ error: { message: "boom" } })).code).toBe("bad_response");
});

// Live-observed herdr 0.9.1 behaviour: `pane run` prints nothing on
// success, and failures print their `error` payload on stderr with exit code 1.
test("the CLI wrapper reads errors from stderr and accepts a silent `pane run`", async () => {
	const dir = await mkdtemp(join(tmpdir(), "herdr-test-"));
	const bin = join(dir, "herdr");
	await Bun.write(
		bin,
		[
			"#!/bin/sh",
			`case "$1 $2" in`,
			`  "pane run") exit 0 ;;`,
			`  "pane close") echo '{"error":{"code":"pane_not_found","message":"pane w3:p4 not found"},"id":"cli:request"}' >&2; exit 1 ;;`,
			`  "pane rename") echo 'boom' >&2; exit 1 ;;`,
			`  *) echo '{"id":"cli:pane:split","result":{"pane":{"pane_id":"w3:p2"}}}' ;;`,
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);

	try {
		const herdr = createHerdrCli(bin);
		await expect(herdr.run("w3:p2", "echo hi")).resolves.toBeUndefined();
		await expect(herdr.close("w3:p4")).resolves.toBeUndefined();
		await expect(herdr.split("w3:p1", "right", 0.6)).resolves.toBe("w3:p2");

		const renameError = await herdr.rename("w3:p2", "x").then(
			() => null,
			(error: unknown) => error,
		);
		expect(renameError).toBeInstanceOf(HerdrError);
		expect((renameError as HerdrError).code).toBe("cli_failed");
		expect((renameError as HerdrError).message).toBe("boom");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a hung herdr call is killed and rejects with code timeout", async () => {
	const dir = await mkdtemp(join(tmpdir(), "herdr-test-"));
	const bin = join(dir, "herdr");
	await Bun.write(bin, "#!/bin/sh\nexec sleep 10\n");
	chmodSync(bin, 0o755);

	try {
		const started = Date.now();
		const error = await createHerdrCli(bin, 100)
			.rename("w3:p2", "x")
			.then(
				() => null,
				(reason: unknown) => reason,
			);
		expect(error).toBeInstanceOf(HerdrError);
		expect((error as HerdrError).code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(2000);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
