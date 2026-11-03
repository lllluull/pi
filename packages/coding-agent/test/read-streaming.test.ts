import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadToolDefinition, type ReadOperations } from "../src/core/tools/read.ts";
import { TextFileDecoder } from "../src/core/tools/text-file-decoder.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	HeadTruncator,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
} from "../src/core/tools/truncate.ts";

// The read tool's text path before it streamed (#9654), kept as the reference the new paths must match.
function referenceRead(
	textContent: string,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
): { text: string; details: { truncation: TruncationResult } | undefined } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}
	const truncation = truncateHead(selectedContent);
	let outputText: string;
	let details: { truncation: TruncationResult } | undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		outputText = truncation.content;
	}
	return { text: outputText, details };
}

type ReadOutcome = { text: string; details: unknown } | { error: string };

async function outcome(run: () => Promise<{ content: { type: string; text?: string }[]; details: unknown }>) {
	try {
		const result = await run();
		return { text: result.content[0].text ?? "", details: result.details };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function referenceOutcome(text: string, offset: number | undefined, limit: number | undefined): ReadOutcome {
	try {
		return referenceRead(text, FILE_PATH, offset, limit);
	} catch (error) {
		return { error: (error as Error).message };
	}
}

const FILE_PATH = join(tmpdir(), "pi-read-streaming-test-missing", "file.txt");

/** Splits bytes into chunks whose sizes cycle through `sizes`, so characters and lines split at chunk ends. */
async function* chunked(bytes: Buffer, sizes: number[]): AsyncIterable<Uint8Array> {
	let position = 0;
	for (let i = 0; position < bytes.length; i++) {
		const size = sizes[i % sizes.length];
		yield bytes.subarray(position, position + size);
		position += size;
	}
}

function streamingOps(bytes: Buffer, sizes: number[]): ReadOperations {
	return {
		readFile: async () => {
			throw new Error("readFile must not be used when createReadStream is present");
		},
		access: async () => {},
		createReadStream: () => chunked(bytes, sizes),
	};
}

function bufferOps(bytes: Buffer): ReadOperations {
	return { readFile: async () => bytes, access: async () => {} };
}

function readWith(ops: ReadOperations, offset: number | undefined, limit: number | undefined) {
	const tool = createReadToolDefinition(process.cwd(), { operations: ops });
	return outcome(() =>
		tool.execute("call", { path: FILE_PATH, offset, limit }, undefined, undefined, undefined as never),
	);
}

function lines(count: number, make: (i: number) => string): string {
	return Array.from({ length: count }, (_, i) => make(i)).join("\n");
}

// Inputs around every boundary the read tool's notices and truncation depend on.
const TEXT_CASES: Record<string, string> = {
	empty: "",
	"single line, no trailing newline": "alpha",
	"trailing newline": "alpha\nbeta\n",
	"only newlines": "\n\n\n",
	"single newline": "\n",
	"no trailing newline": "alpha\nbeta\ngamma",
	CRLF: "alpha\r\nbeta\r\n\r\ngamma\r\n",
	"lone CR": "alpha\rbeta\rgamma",
	"multi-byte characters": "é€😀\nñ\u{10348}字\n😀😀😀",
	"UTF-8 byte order mark": "\uFEFFalpha\nbeta",
	"2000 lines": lines(2000, (i) => `line ${i}`),
	"2000 lines and trailing newline": `${lines(2000, (i) => `line ${i}`)}\n`,
	"2001 lines": lines(2001, (i) => `line ${i}`),
	"2001 lines and trailing newline": `${lines(2001, (i) => `line ${i}`)}\n`,
	"2002 lines, last empty": `${lines(2001, (i) => `l${i}`)}\n\n`,
	"first line just over 50KB": `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\nsecond`,
	"first line exactly 50KB": `${"x".repeat(DEFAULT_MAX_BYTES)}\nsecond`,
	"only line exactly 50KB": "x".repeat(DEFAULT_MAX_BYTES),
	"first line over 50KB of multi-byte characters": `${"é".repeat(DEFAULT_MAX_BYTES / 2 + 1)}\nsecond`,
	"just under 50KB in lines": lines(512, () => "y".repeat(99)),
	"exactly 50KB in lines": `${lines(512, () => "y".repeat(99))}y`,
	// 50KB + 1 byte, truncated, yet every line fits: truncateHead reports truncatedBy "lines".
	"exactly 50KB plus a trailing newline": `${lines(512, () => "y".repeat(99))}y\n`,
	"only line exactly 50KB plus a trailing newline": `${"x".repeat(DEFAULT_MAX_BYTES)}\n`,
	"just under 50KB plus a trailing newline": `${lines(512, () => "y".repeat(99))}\n`,
	"50KB plus one line": `${lines(512, () => "y".repeat(99))}\nz`,
	"50KB plus an empty line and more": `${lines(512, () => "y".repeat(99))}\n\nz`,
	"multi-byte characters over 50KB": lines(700, (i) => `${i} ${"€😀".repeat(13)}`),
	"long line after short lines": `a\nb\n${"z".repeat(60 * 1024)}\nc`,
	"over 50KB in lines": lines(3000, (i) => `${i} ${"w".repeat(i % 40)}`),
};

function offsetsAndLimits(text: string): { offsets: (number | undefined)[]; limits: (number | undefined)[] } {
	const total = text.split("\n").length;
	const around = (n: number) => [n - 1, n, n + 1];
	const offsets = [undefined, 0, 1, 2, -3, ...around(total), ...around(2000), 2002].filter(
		(o) => o === undefined || o > -5,
	);
	const limits = [undefined, 0, 1, 2, ...around(total), ...around(2000), 2001];
	return { offsets: [...new Set(offsets)], limits: [...new Set(limits)].filter((l) => l === undefined || l >= 0) };
}

describe("read tool streaming", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-read-streaming-"));
	afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

	it("streams with output identical to the whole-file algorithm", async () => {
		for (const [name, text] of Object.entries(TEXT_CASES)) {
			const bytes = Buffer.from(text, "utf-8");
			const { offsets, limits } = offsetsAndLimits(text);
			for (const offset of offsets) {
				for (const limit of limits) {
					const expected = referenceOutcome(text, offset, limit);
					const label = `${name}, offset ${offset}, limit ${limit}`;
					expect(await readWith(streamingOps(bytes, [1, 3, 7, 4096]), offset, limit), label).toEqual(expected);
					expect(await readWith(bufferOps(bytes), offset, limit), label).toEqual(expected);
				}
			}
		}
	});

	it("keeps details key order, which session files serialize", async () => {
		const text = TEXT_CASES["2001 lines"];
		const streamed = (await readWith(streamingOps(Buffer.from(text), [4096]), 1, undefined)) as { details: unknown };
		const expected = referenceOutcome(text, 1, undefined) as { details: unknown };
		expect(JSON.stringify(streamed.details)).toBe(JSON.stringify(expected.details));
	});

	it("decodes multi-byte characters split across every chunk boundary", async () => {
		const text = "aé€😀\n😀b\u{10348}\nc";
		const bytes = Buffer.from(text, "utf-8");
		for (const sizes of [[1], [2], [3], [5], [1, 2], [2, 1, 4]]) {
			expect(await readWith(streamingOps(bytes, sizes), undefined, undefined)).toEqual(
				referenceOutcome(text, undefined, undefined),
			);
		}
	});

	it("decodes invalid UTF-8 like Buffer.toString", async () => {
		const bytes = Buffer.from([
			0x61, 0xc3, 0x0a, 0xe2, 0x82, 0x0a, 0xff, 0xfe, 0x80, 0xf0, 0x9f, 0x98, 0x0a, 0xed, 0xa0, 0x80,
		]);
		for (const sizes of [[1], [2], [3], [4096]]) {
			expect(await readWith(streamingOps(bytes, sizes), undefined, undefined)).toEqual(
				referenceOutcome(bytes.toString("utf-8"), undefined, undefined),
			);
		}
	});

	it("routes fractional and negative ranges to the whole-file path, unchanged", async () => {
		const text = "one\ntwo\nthree\nfour";
		for (const [offset, limit] of [
			[1.5, undefined],
			[2.5, 1],
			[undefined, -1],
			[2, -1],
			[1, 1.5],
			[3, -10],
		] as const) {
			const result = await readWith(
				{ ...streamingOps(Buffer.from(text), [1]), readFile: async () => Buffer.from(text) },
				offset,
				limit,
			);
			expect(result, `offset ${offset}, limit ${limit}`).toEqual(referenceOutcome(text, offset, limit));
		}
	});

	it("reports the size of an over-long first line for a fractional offset instead of throwing", async () => {
		const text = `short\n${"x".repeat(DEFAULT_MAX_BYTES + 1)}`;
		// The old code threw a TypeError here: Buffer.byteLength(allLines[1.5]).
		expect(referenceOutcome(text, 2.5, undefined)).toMatchObject({ error: expect.stringContaining("string") });
		expect(await readWith(bufferOps(Buffer.from(text)), 2.5, undefined)).toMatchObject({
			text: `[Line 2.5 is 50.0KB, exceeds 50.0KB limit. Use bash: sed -n '2.5p' ${FILE_PATH} | head -c ${DEFAULT_MAX_BYTES}]`,
		});
	});

	it("reads local files through the default stream", async () => {
		const path = join(tempDir, "local.txt");
		const text = TEXT_CASES["over 50KB in lines"];
		writeFileSync(path, text);
		const tool = createReadToolDefinition(tempDir);
		for (const [offset, limit] of [
			[undefined, undefined],
			[1500, 10],
			[2999, undefined],
		] as const) {
			const result = await outcome(() =>
				tool.execute("call", { path, offset, limit }, undefined, undefined, undefined as never),
			);
			expect(result).toEqual(referenceRead(text, path, offset, limit));
		}
		await expect(tool.execute("call", { path: tempDir }, undefined, undefined, undefined as never)).rejects.toThrow(
			"EISDIR",
		);
	});
});

describe("read tool encodings", () => {
	const text = "héllo 😀\nwörld\r\nlast";

	function utf16(byteOrder: "le" | "be", body: string): Buffer {
		const le = Buffer.from(`\uFEFF${body}`, "utf16le");
		return byteOrder === "le" ? le : Buffer.from(le).swap16();
	}

	it("decodes UTF-16 files with a byte order mark, without the mark", async () => {
		for (const byteOrder of ["le", "be"] as const) {
			const bytes = utf16(byteOrder, text);
			const expected = referenceOutcome(text, undefined, undefined);
			expect(await readWith(bufferOps(bytes), undefined, undefined), byteOrder).toEqual(expected);
			for (const sizes of [[1], [3], [1, 2, 5], [4096]]) {
				expect(await readWith(streamingOps(bytes, sizes), undefined, undefined), `${byteOrder} ${sizes}`).toEqual(
					expected,
				);
			}
			expect(await readWith(streamingOps(bytes, [3]), 2, 1)).toEqual(referenceOutcome(text, 2, 1));
		}
	});

	it("replaces a dangling odd byte at the end of a UTF-16 file", async () => {
		for (const byteOrder of ["le", "be"] as const) {
			const bytes = Buffer.concat([utf16(byteOrder, "ab"), Buffer.from([0x41])]);
			for (const ops of [bufferOps(bytes), streamingOps(bytes, [1])]) {
				expect(await readWith(ops, undefined, undefined)).toEqual({ text: "ab\uFFFD", details: undefined });
			}
		}
	});

	it("keeps a UTF-8 byte order mark and treats files without a mark as UTF-8", () => {
		for (const bytes of [
			Buffer.from("\uFEFFabc", "utf-8"),
			Buffer.from([0xfe]),
			Buffer.from([0xff]),
			Buffer.from([0xfe, 0x41]),
			Buffer.from("plain", "utf-8"),
		]) {
			const decoder = new TextFileDecoder();
			expect(decoder.write(bytes.subarray(0, 1)) + decoder.write(bytes.subarray(1)) + decoder.end()).toBe(
				bytes.toString("utf-8"),
			);
		}
	});
});

describe("read tool abort", () => {
	it("stops consuming the stream when aborted", async () => {
		const controller = new AbortController();
		let chunksRead = 0;
		let closed = false;
		const ops: ReadOperations = {
			readFile: async () => Buffer.alloc(0),
			access: async () => {},
			async *createReadStream(_path, { signal }) {
				expect(signal).toBe(controller.signal);
				try {
					while (true) {
						chunksRead++;
						if (chunksRead === 3) controller.abort();
						await new Promise((resolve) => setTimeout(resolve, 1));
						yield Buffer.from("line\n");
					}
				} finally {
					closed = true;
				}
			},
		};
		const tool = createReadToolDefinition(process.cwd(), { operations: ops });
		await expect(
			tool.execute("call", { path: FILE_PATH }, controller.signal, undefined, undefined as never),
		).rejects.toThrow("Operation aborted");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closed).toBe(true);
		expect(chunksRead).toBe(3);
	});
});

describe("HeadTruncator", () => {
	const options: TruncationOptions[] = [{}, { maxLines: 3, maxBytes: 10 }, { maxLines: 0 }, { maxBytes: 0 }];
	const contents = [
		"",
		"\n",
		"\n\n",
		"a",
		"a\n",
		"abc\ndef\nghi\njkl",
		"abc\ndef\nghi\n",
		"0123456789\n",
		"0123456789a\nb",
		"012345678\n\n",
		"é€😀\n😀",
		"\n\n\n\nx",
	];

	it("matches truncateHead for any split of the content", () => {
		for (const option of options) {
			for (const content of contents) {
				const expected = truncateHead(content, option);
				const characters = [...content];
				for (let split = 0; split <= characters.length; split++) {
					const truncator = new HeadTruncator(option);
					truncator.write(characters.slice(0, split).join(""));
					truncator.write(characters.slice(split).join(""));
					expect(truncator.end(), `${JSON.stringify(content)} at ${split}`).toEqual(expected);
				}
			}
		}
	});

	it("matches truncateHead on random content", () => {
		let seed = 1;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		const alphabet = ["a", "b", "\n", "\n", "é", "😀", "\r"];
		for (let run = 0; run < 2000; run++) {
			const characters = Array.from({ length: random(40) }, () => alphabet[random(alphabet.length)]);
			const content = characters.join("");
			const option = { maxLines: random(6), maxBytes: random(30) };
			const truncator = new HeadTruncator(option);
			let position = 0;
			while (position < characters.length) {
				const end = Math.min(characters.length, position + 1 + random(5));
				truncator.write(characters.slice(position, end).join(""));
				position = end;
			}
			expect(truncator.end(), JSON.stringify({ content, option })).toEqual(truncateHead(content, option));
		}
	});
});
