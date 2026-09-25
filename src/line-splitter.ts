/**
 * Incremental byte → line splitter.
 *
 * The transcript file is appended to while we read it, so a read can end in the middle of a line
 * *and* in the middle of a multi-byte UTF-8 sequence. Bytes are therefore buffered as bytes and a
 * line is only decoded once its terminating `0x0A` has arrived.
 */

export interface LineSplitter {
	/** Feed raw bytes; returns every line completed by this chunk (without the trailing "\n"; a trailing "\r" is removed). */
	push(chunk: Uint8Array): string[];
	/** Drop any buffered partial line (used after the file was truncated). */
	reset(): void;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const INITIAL_CAPACITY = 1024;

class ByteLineSplitter implements LineSplitter {
	/** Bytes of the not-yet-terminated last line; only `[0, length)` is meaningful. */
	private buffer = new Uint8Array(INITIAL_CAPACITY);
	private length = 0;
	private readonly decoder = new TextDecoder();

	push(chunk: Uint8Array): string[] {
		if (chunk.length > 0) {
			this.reserve(this.length + chunk.length);
			this.buffer.set(chunk, this.length);
			this.length += chunk.length;
		}
		return this.drain();
	}

	reset(): void {
		this.length = 0;
	}

	private reserve(size: number): void {
		if (this.buffer.length >= size) return;
		let capacity = this.buffer.length;
		while (capacity < size) capacity *= 2;
		const grown = new Uint8Array(capacity);
		grown.set(this.buffer.subarray(0, this.length));
		this.buffer = grown;
	}

	/** Decode every line terminated in the buffer; the trailing partial line stays buffered. */
	private drain(): string[] {
		const lines: string[] = [];
		let start = 0;
		for (;;) {
			const index = this.buffer.subarray(start, this.length).indexOf(NEWLINE);
			if (index === -1) break;
			lines.push(this.decodeLine(start, start + index));
			start += index + 1;
		}
		if (start > 0) {
			this.buffer.copyWithin(0, start, this.length);
			this.length -= start;
		}
		return lines;
	}

	/** Decode `buffer[start, end)` as one complete line (its `\n` already consumed). */
	private decodeLine(start: number, end: number): string {
		const stop = end > start && this.buffer[end - 1] === CARRIAGE_RETURN ? end - 1 : end;
		return this.decoder.decode(this.buffer.subarray(start, stop));
	}
}

export function createLineSplitter(): LineSplitter {
	return new ByteLineSplitter();
}
