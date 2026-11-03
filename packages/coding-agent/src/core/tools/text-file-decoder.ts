// Decoding of text files for the read tool, whole or in chunks.

import { TextDecoder } from "node:util";

/**
 * Incremental decoder for the text files the read tool shows.
 *
 * A file that starts with a UTF-16 byte order mark (FF FE little endian, FE FF big endian) is decoded
 * as UTF-16 without the mark. Every other file is decoded as UTF-8 exactly like Buffer.toString("utf-8"),
 * including a UTF-8 byte order mark, which stays in the text as U+FEFF.
 */
export class TextFileDecoder {
	private decoder: TextDecoder | undefined;
	private bigEndian = false;
	// Bytes not decoded yet: the start of the file until the byte order mark can be checked, or the odd
	// byte of a big endian UTF-16 code unit split across chunks.
	private pending: Uint8Array = new Uint8Array(0);

	/** Decode the next chunk. Characters split across chunks come out with the chunk that completes them. */
	write(chunk: Uint8Array): string {
		return this.decode(chunk, true);
	}

	/** Decode the bytes still held back; an incomplete character at the end becomes U+FFFD. */
	end(): string {
		return this.decode(new Uint8Array(0), false);
	}

	private decode(chunk: Uint8Array, stream: boolean): string {
		let bytes = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		this.pending = new Uint8Array(0);
		if (!this.decoder) {
			if (bytes.length < 2 && stream) {
				this.pending = bytes;
				return "";
			}
			this.decoder = this.createDecoder(bytes);
		}
		if (this.bigEndian) {
			// Swapping to little endian avoids depending on "utf-16be" support, which runtimes without ICU lack.
			const evenLength = bytes.length - (bytes.length % 2);
			if (stream) this.pending = bytes.slice(evenLength);
			const swapped = Buffer.from(bytes.subarray(0, evenLength)).swap16();
			bytes = stream ? swapped : Buffer.concat([swapped, bytes.subarray(evenLength)]);
		}
		return this.decoder.decode(bytes, { stream });
	}

	private createDecoder(head: Uint8Array): TextDecoder {
		if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le");
		if (head[0] === 0xfe && head[1] === 0xff) {
			this.bigEndian = true;
			return new TextDecoder("utf-16le");
		}
		// ignoreBOM keeps a UTF-8 byte order mark in the text, as Buffer.toString("utf-8") does.
		return new TextDecoder("utf-8", { ignoreBOM: true });
	}
}
