/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Streaming form of truncateHead: write the content in pieces of any size that do not split a
 * surrogate pair, then end() returns exactly what truncateHead(content) returns. Only the lines that
 * can be part of the output are kept, so memory stays bounded by maxBytes however large the content is.
 */
export class HeadTruncator {
	readonly maxLines: number;
	readonly maxBytes: number;
	/** Bytes of the content's first line, final once end() returned. */
	firstLineBytes = 0;
	private totalBytes = 0;
	private lineIndex = 0;
	private lineHasText = false;
	private lineBytes = 0;
	private linePieces: string[] = [];
	private readonly outputLines: string[] = [];
	private outputBytes = 0;
	private stoppedBy: "lines" | "bytes" | undefined;

	constructor(options: TruncationOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	}

	/** Append the next piece of the content. */
	write(text: string): void {
		this.totalBytes += Buffer.byteLength(text, "utf-8");
		let start = 0;
		while (true) {
			const newline = text.indexOf("\n", start);
			const end = newline === -1 ? text.length : newline;
			if (end > start) this.appendToLine(text, start, end);
			if (newline === -1) return;
			// A line followed by a newline is never the trailing empty line truncateHead drops.
			this.takeLine();
			this.lineIndex++;
			this.lineHasText = false;
			this.lineBytes = 0;
			this.linePieces = [];
			start = newline + 1;
		}
	}

	/** The truncation result for all content written so far. */
	end(): TruncationResult {
		// An empty last line is the trailing newline's, which truncateHead does not count as a line.
		if (this.lineHasText) this.takeLine();
		const { maxLines, maxBytes } = this;
		const totalBytes = this.totalBytes;
		const totalLines = totalBytes === 0 ? 0 : this.lineIndex + (this.lineHasText ? 1 : 0);
		if (totalLines <= maxLines && totalBytes <= maxBytes) {
			// Every line fit, so all of them were kept.
			const trailingNewline = this.lineIndex > 0 && !this.lineHasText ? "\n" : "";
			return {
				content: this.outputLines.join("\n") + trailingNewline,
				truncated: false,
				truncatedBy: null,
				totalLines,
				totalBytes,
				outputLines: totalLines,
				outputBytes: totalBytes,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines,
				maxBytes,
			};
		}
		if (this.firstLineBytes > maxBytes) {
			return {
				content: "",
				truncated: true,
				truncatedBy: "bytes",
				totalLines,
				totalBytes,
				outputLines: 0,
				outputBytes: 0,
				lastLinePartial: false,
				firstLineExceedsLimit: true,
				maxLines,
				maxBytes,
			};
		}
		return {
			content: this.outputLines.join("\n"),
			truncated: true,
			truncatedBy: this.stoppedBy === "bytes" ? "bytes" : "lines",
			totalLines,
			totalBytes,
			outputLines: this.outputLines.length,
			outputBytes: this.outputBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	private appendToLine(text: string, start: number, end: number): void {
		this.lineHasText = true;
		// The output stops at a line's end, after the first line's size is known: nothing else is needed.
		if (this.stoppedBy !== undefined) return;
		const piece = text.slice(start, end);
		this.lineBytes += Buffer.byteLength(piece, "utf-8");
		const separatorBytes = this.lineIndex > 0 ? 1 : 0;
		if (this.outputBytes + separatorBytes + this.lineBytes <= this.maxBytes) {
			this.linePieces.push(piece);
		} else {
			// The line cannot be output any more: keep counting its bytes, drop its text.
			this.linePieces = [];
		}
	}

	/** truncateHead's collection loop for one line. */
	private takeLine(): void {
		if (this.lineIndex === 0) this.firstLineBytes = this.lineBytes;
		if (this.stoppedBy !== undefined) return;
		if (this.lineIndex >= this.maxLines) {
			this.stoppedBy = "lines";
			return;
		}
		const lineBytes = this.lineBytes + (this.lineIndex > 0 ? 1 : 0);
		if (this.outputBytes + lineBytes > this.maxBytes) {
			this.stoppedBy = "bytes";
			return;
		}
		this.outputLines.push(this.linePieces.join(""));
		this.outputBytes += lineBytes;
	}
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
