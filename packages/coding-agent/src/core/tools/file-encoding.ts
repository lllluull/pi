/**
 * Byte-preserving decoding and encoding of text files for the edit tool.
 *
 * Every supported encoding round-trips exactly: decoding a file and encoding the unchanged text gives back
 * the same bytes, so an edit only changes the bytes of the text it replaces.
 */

import { isUtf8 } from "buffer";
import { splitBom } from "../../utils/text.ts";

/**
 * How a file's bytes map to text.
 * - `utf-8`: valid UTF-8, optionally with a BOM.
 * - `utf-16le` / `utf-16be`: detected by their BOM, which is kept out of the text and written back.
 * - `bytes`: neither of the above (for example Windows-1252, GBK or Shift-JIS). Decoded as Latin-1, one
 *   character per byte, so ASCII text matches and splices byte-exactly and all other bytes survive unchanged.
 */
export type FileEncoding = "utf-8" | "utf-16le" | "utf-16be" | "bytes";

/** Decoded file text without its BOM. */
export type DecodedFile =
	| { encoding: "utf-8"; bom: boolean; text: string }
	| { encoding: "utf-16le" | "utf-16be" | "bytes"; text: string };

const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/** Detect the encoding of file contents and decode them losslessly. */
export function decodeFile(buffer: Buffer): DecodedFile {
	// An odd length cannot be UTF-16. Such files fall through to `bytes`, since FF and FE are never valid UTF-8.
	if (buffer.length % 2 === 0) {
		if (buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
			return { encoding: "utf-16le", text: buffer.toString("utf16le", 2) };
		}
		if (buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
			return { encoding: "utf-16be", text: Buffer.from(buffer.subarray(2)).swap16().toString("utf16le") };
		}
	}
	if (isUtf8(buffer)) {
		const { bom, text } = splitBom(buffer.toString("utf-8"));
		return { encoding: "utf-8", bom: bom !== "", text };
	}
	return { encoding: "bytes", text: buffer.toString("latin1") };
}

/** Encode text of a non-UTF-8 file back to bytes, including the BOM it was read with. */
export function encodeNonUtf8File(encoding: "utf-16le" | "utf-16be" | "bytes", text: string): Buffer {
	switch (encoding) {
		case "utf-16le":
			return Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]);
		case "utf-16be":
			return Buffer.concat([UTF16BE_BOM, Buffer.from(text, "utf16le").swap16()]);
		case "bytes":
			return Buffer.from(text, "latin1");
	}
}

/** Describe a non-UTF-8 encoding for error messages. */
export function describeNonUtf8Encoding(encoding: "utf-16le" | "utf-16be" | "bytes"): string {
	switch (encoding) {
		case "utf-16le":
			return "UTF-16LE";
		case "utf-16be":
			return "UTF-16BE";
		case "bytes":
			return "not valid UTF-8";
	}
}
