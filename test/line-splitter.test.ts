import { expect, test } from "bun:test";
import { createLineSplitter } from "../src/line-splitter.ts";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

test("returns every complete line of a single chunk", () => {
	const splitter = createLineSplitter();
	expect(splitter.push(bytes("a\nb\n"))).toEqual(["a", "b"]);
});

test("buffers a partial line until its newline arrives", () => {
	const splitter = createLineSplitter();
	expect(splitter.push(bytes("ab"))).toEqual([]);
	expect(splitter.push(bytes("c\nd"))).toEqual(["abc"]);
	expect(splitter.push(bytes("\n"))).toEqual(["d"]);
});

test("strips a trailing carriage return", () => {
	const splitter = createLineSplitter();
	expect(splitter.push(bytes("x\r\n"))).toEqual(["x"]);
});

test("keeps multi-byte characters intact when split at any byte offset", () => {
	const encoded = bytes("é✓\n");
	for (let cut = 0; cut <= encoded.length; cut += 1) {
		const splitter = createLineSplitter();
		const first = splitter.push(encoded.slice(0, cut));
		const second = splitter.push(encoded.slice(cut));
		expect([...first, ...second]).toEqual(["é✓"]);
	}
});

test("reset drops a buffered partial line", () => {
	const splitter = createLineSplitter();
	expect(splitter.push(bytes("partial"))).toEqual([]);
	splitter.reset();
	expect(splitter.push(bytes("fresh\n"))).toEqual(["fresh"]);
});
