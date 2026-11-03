/**
 * Shared matching, application and diff computation for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { decodeFile, type FileEncoding } from "./file-encoding.ts";
import { resolveToCwd } from "./path-utils.ts";

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

/** Replacement of the range [start, end) of some content with newText. */
interface TextReplacement {
	start: number;
	end: number;
	newText: string;
}

interface MatchedEdit extends TextReplacement {
	editIndex: number;
}

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacement.start >= line.start && replacement.start < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacement.end) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

/** Apply sorted, non-overlapping replacements whose offsets are relative to `content` shifted by `offset`. */
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		result =
			result.substring(0, replacement.start - offset) +
			replacement.newText +
			result.substring(replacement.end - offset);
	}
	return result;
}

/**
 * Turn replacements matched in `fuzzyContent` (a fuzzy-normalized view of
 * `normalizedContent`) into replacements of `normalizedContent`.
 *
 * Each replacement is widened to the lines it actually touches, and those
 * lines are rewritten from the fuzzy-normalized text. All other lines keep
 * their original text. The actual replacement ranges drive this, so duplicate
 * normalized lines cannot be aligned to the wrong occurrence.
 */
function widenFuzzyReplacementsToLines(
	normalizedContent: string,
	fuzzyContent: string,
	replacements: TextReplacement[],
): TextReplacement[] {
	const normalizedLines = getLineSpans(normalizedContent);
	const fuzzyLines = getLineSpans(fuzzyContent);
	if (normalizedLines.length !== fuzzyLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	for (const replacement of replacements) {
		const range = getReplacementLineRange(fuzzyLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	return groups.map((group) => {
		const fuzzyStart = fuzzyLines[group.startLine].start;
		const fuzzyEnd = fuzzyLines[group.endLine - 1].end;
		return {
			start: normalizedLines[group.startLine].start,
			end: normalizedLines[group.endLine - 1].end,
			newText: applyReplacements(fuzzyContent.slice(fuzzyStart, fuzzyEnd), group.replacements, fuzzyStart),
		};
	});
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

/** One replacement of matched edits, located both in the LF-normalized and in the original text. */
export interface EditReplacement {
	/** Start offset in the LF-normalized text */
	start: number;
	/** End offset (exclusive) in the LF-normalized text */
	end: number;
	/** Start offset of the same range in the original text */
	originalStart: number;
	/** End offset (exclusive) of the same range in the original text */
	originalEnd: number;
	/** Replacement text with LF line endings */
	newText: string;
}

/** Edits matched against a file's text, ready to apply or diff. */
export interface MatchedEdits {
	/** The decoded file text without BOM, with its original line endings */
	text: string;
	/** `text` with every CRLF and lone CR turned into LF. Matching and diffs work on this view. */
	normalized: string;
	/** Sorted, non-overlapping replacements */
	replacements: EditReplacement[];
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

const NOT_UTF8_ALTERNATIVES =
	"The file was left unchanged. To change non-ASCII text, use bash (for example iconv, or a script that reads and writes the file in its encoding), or, if converting the file to UTF-8 is acceptable, rewrite it with write.";

function describeEdit(path: string, editIndex: number, totalEdits: number): string {
	return totalEdits === 1 ? `the edit to ${path}` : `edits[${editIndex}] to ${path}`;
}

function getNonAsciiEditError(path: string, editIndex: number, totalEdits: number): Error {
	return new Error(
		`Cannot apply ${describeEdit(path, editIndex, totalEdits)}: the file is not valid UTF-8 (it may use a legacy encoding such as Windows-1252, GBK or Shift-JIS), so its encoding is unknown. Edits to such files are only applied when oldText and newText are ASCII, which keeps every other byte unchanged. Anchor the edit on ASCII-only text. ${NOT_UTF8_ALTERNATIVES}`,
	);
}

function getInexactMatchError(path: string, editIndex: number, totalEdits: number): Error {
	return new Error(
		`Cannot apply ${describeEdit(path, editIndex, totalEdits)}: the oldText only matches after normalizing whitespace or Unicode punctuation, and the file is not valid UTF-8, so only exact matches are applied. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getSplitCharacterError(path: string, editIndex: number, totalEdits: number): Error {
	return new Error(
		`Cannot apply ${describeEdit(path, editIndex, totalEdits)}: the file is not valid UTF-8, and the edit changes the byte right after a non-ASCII byte. In multi-byte encodings such as GBK or Shift-JIS that byte can belong to the preceding character. Keep the first character of oldText unchanged in newText. ${NOT_UTF8_ALTERNATIVES}`,
	);
}

const NON_ASCII = /[\u0080-\uffff]/;

/**
 * Match one or more exact-text replacements against a file's decoded text.
 *
 * Matching runs on an LF-normalized view of the text, and all edits are
 * matched against the same original content. If any edit needs fuzzy
 * matching, the replacements are widened to whole lines rewritten from the
 * fuzzy-normalized text. The returned replacements also carry their offsets in
 * the original text, so applying them leaves every other byte untouched.
 *
 * Text of the `bytes` encoding (not valid UTF-8) is decoded one character per
 * byte. Its encoding is unknown, so only ASCII edits that match exactly are
 * accepted: they splice exactly the bytes they replace.
 */
export function matchEdits(text: string, edits: Edit[], path: string, encoding: FileEncoding): MatchedEdits {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
		if (encoding === "bytes" && NON_ASCII.test(normalizedEdits[i].oldText + normalizedEdits[i].newText)) {
			throw getNonAsciiEditError(path, i, normalizedEdits.length);
		}
	}

	const normalizedContent = normalizeToLF(text);
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const fuzzyEditIndex = initialMatches.findIndex((match) => match.usedFuzzyMatch);
	const usedFuzzyMatch = fuzzyEditIndex !== -1;
	if (usedFuzzyMatch && encoding === "bytes") {
		throw getInexactMatchError(path, fuzzyEditIndex, normalizedEdits.length);
	}
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			start: matchResult.index,
			end: matchResult.index + matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.end > current.start) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const normalizedReplacements = usedFuzzyMatch
		? widenFuzzyReplacementsToLines(normalizedContent, replacementBaseContent, matchedEdits)
		: matchedEdits;
	if (replacementsChangeNothing(normalizedContent, normalizedReplacements)) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	const replacements = locateInOriginal(text, normalizedReplacements);
	if (encoding === "bytes") {
		for (const [i, replacement] of replacements.entries()) {
			// Matching in `bytes` text is exact, so replacements[i] is matchedEdits[i].
			const editIndex = matchedEdits[i].editIndex;
			const previousByte = replacement.originalStart > 0 ? text.charCodeAt(replacement.originalStart - 1) : 0;
			if (previousByte >= 0x80 && replacement.newText[0] !== normalizedContent[replacement.start]) {
				throw getSplitCharacterError(path, editIndex, normalizedEdits.length);
			}
		}
	}

	return { text, normalized: normalizedContent, replacements };
}

/**
 * Whether applying the replacements reproduces `content`. Compares in place
 * instead of building the new content, which can be as large as the file.
 */
function replacementsChangeNothing(content: string, replacements: TextReplacement[]): boolean {
	let position = replacements[0].start;
	let previousEnd = position;
	for (const replacement of replacements) {
		if (!content.startsWith(content.slice(previousEnd, replacement.start), position)) return false;
		position += replacement.start - previousEnd;
		if (!content.startsWith(replacement.newText, position)) return false;
		position += replacement.newText.length;
		previousEnd = replacement.end;
	}
	return position === previousEnd;
}

/** Add the offsets of LF-normalized replacements in the original text. */
function locateInOriginal(text: string, replacements: TextReplacement[]): EditReplacement[] {
	// Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p)
	// sits at p - n in the normalized text. A normalized offset maps to the original by adding
	// the number of CRLFs before it, so a range covering that LF covers the whole CRLF.
	let crlfBefore = 0;
	let nextCrlf = text.indexOf("\r\n");
	const toOriginal = (offset: number): number => {
		while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
			crlfBefore++;
			nextCrlf = text.indexOf("\r\n", nextCrlf + 2);
		}
		return offset + crlfBefore;
	};
	return replacements.map((replacement) => {
		const originalStart = toOriginal(replacement.start);
		return { ...replacement, originalStart, originalEnd: toOriginal(replacement.end) };
	});
}

/**
 * Apply matched edits to the original text. Only the replaced ranges change.
 * Line breaks in inserted text use the line ending of the line where the
 * replaced range starts (see `lineEndingAt`).
 */
export function applyMatchedEdits(match: MatchedEdits): string {
	const { text } = match;
	const parts: string[] = [];
	let position = 0;
	for (const replacement of match.replacements) {
		parts.push(text.slice(position, replacement.originalStart));
		const ending = lineEndingAt(text, replacement.originalStart);
		parts.push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
		position = replacement.originalEnd;
	}
	parts.push(text.slice(position));
	return parts.join("");
}

/**
 * Line ending of the line containing `offset`: its own LF or CRLF, or the one
 * of the line before for an unterminated last line. A lone CR only counts in
 * files without any LF (classic Mac line endings); elsewhere it is more likely
 * a control character inside a line. Files without line endings use LF.
 */
function lineEndingAt(text: string, offset: number): "\r\n" | "\n" | "\r" {
	let lineFeed = text.indexOf("\n", offset);
	if (lineFeed === -1) lineFeed = text.lastIndexOf("\n", offset);
	if (lineFeed === -1) return text.includes("\r") ? "\r" : "\n";
	return text[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const { hunks } = Diff.structuredPatch("", "", oldContent, newContent, undefined, undefined, {
		context: contextLines,
	});
	return formatDisplayDiff(hunks, {
		oldLineCount: countLineFeeds(oldContent) + 1,
		newLineCount: countLineFeeds(newContent) + 1,
		oldContentLines: countContentLines(oldContent),
	});
}

interface DisplayDiffLineCounts {
	/** `content.split("\n").length` of the old content; with the new count it sets the line number width */
	oldLineCount: number;
	/** `content.split("\n").length` of the new content */
	newLineCount: number;
	/** Lines of the old content, not counting the empty string after a final LF */
	oldContentLines: number;
}

/**
 * Render unified-diff hunks as numbered lines: removed and context lines carry
 * their old line number, added lines their new one, and "..." marks skipped
 * unchanged lines before, between and after hunks.
 */
function formatDisplayDiff(
	hunks: Diff.StructuredPatchHunk[],
	counts: DisplayDiffLineCounts,
): { diff: string; firstChangedLine: number | undefined } {
	const lineNumWidth = String(Math.max(counts.oldLineCount, counts.newLineCount)).length;
	const formatLineNum = (lineNum: number): string => String(lineNum).padStart(lineNumWidth, " ");
	const skipped = ` ${"".padStart(lineNumWidth, " ")} ...`;
	const output: string[] = [];
	let firstChangedLine: number | undefined;

	for (const [index, hunk] of hunks.entries()) {
		if (index > 0 || hunk.oldStart > 1) {
			output.push(skipped);
		}
		let oldLineNum = hunk.oldStart;
		let newLineNum = hunk.newStart;
		for (const line of hunk.lines) {
			const text = line.slice(1);
			// "\ No newline at end of file" markers have no counterpart in the display diff.
			if (line[0] === "+") {
				firstChangedLine ??= newLineNum;
				output.push(`+${formatLineNum(newLineNum)} ${text}`);
				newLineNum++;
			} else if (line[0] === "-") {
				firstChangedLine ??= newLineNum;
				output.push(`-${formatLineNum(oldLineNum)} ${text}`);
				oldLineNum++;
			} else if (line[0] === " ") {
				output.push(` ${formatLineNum(oldLineNum)} ${text}`);
				oldLineNum++;
				newLineNum++;
			}
		}
		if (index === hunks.length - 1 && oldLineNum - 1 < counts.oldContentLines) {
			output.push(skipped);
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

function countLineFeeds(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		count++;
	}
	return count;
}

function countContentLines(text: string): number {
	return countLineFeeds(text) + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

export interface MatchedEditsDiff extends EditDiffResult {
	/** Standard unified patch, as from `generateUnifiedPatch` */
	patch: string;
}

const EDIT_DIFF_CONTEXT_LINES = 4;

// Unchanged lines diffed around each change. More than the context: in runs of
// repeated lines the diff may align a change further away, and the extra lines
// let it align as the whole-file diff would. Diffing them costs little.
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * Display diff and unified patch of matched edits on the LF-normalized text,
 * as `generateDiffString` and `generateUnifiedPatch` produce them for the
 * whole file. Only windows around the changed lines are diffed; the rest of
 * the file is only scanned for line numbers, so memory use does not grow with
 * the file size. In long runs of repeated lines the whole-file diff could
 * align a change differently; both are valid diffs of the same change.
 */
export function generateMatchedEditsDiff(path: string, match: MatchedEdits): MatchedEditsDiff {
	const content = match.normalized;
	const hunks: Diff.StructuredPatchHunk[] = [];
	let lineDelta = 0;
	for (const window of getDiffWindows(content, match.replacements, DIFF_WINDOW_MARGIN_LINES)) {
		const oldText = content.slice(window.start, window.end);
		const newText = applyReplacements(oldText, window.replacements, window.start);
		const windowPatch = Diff.structuredPatch("", "", oldText, newText, undefined, undefined, {
			context: EDIT_DIFF_CONTEXT_LINES,
		});
		for (const hunk of windowPatch.hunks) {
			hunks.push({
				...hunk,
				oldStart: hunk.oldStart + window.firstLine,
				newStart: hunk.newStart + window.firstLine + lineDelta,
			});
		}
		// Every window but the last ends with an unchanged, LF-terminated line, so the change in
		// line feeds is the shift of all later line numbers.
		lineDelta += countLineFeeds(newText) - countLineFeeds(oldText);
	}

	const oldLineCount = countLineFeeds(content) + 1;
	const { diff, firstChangedLine } = formatDisplayDiff(hunks, {
		oldLineCount,
		newLineCount: oldLineCount + lineDelta,
		oldContentLines: countContentLines(content),
	});
	// formatPatch adjusts the start of empty hunks in place, so give it copies.
	const patch = Diff.formatPatch(
		{
			oldFileName: path,
			newFileName: path,
			oldHeader: undefined,
			newHeader: undefined,
			hunks: hunks.map((hunk) => ({ ...hunk })),
		},
		Diff.FILE_HEADERS_ONLY,
	);
	return { diff, patch, firstChangedLine };
}

interface DiffWindow {
	/** Zero-based number of the first line of the window */
	firstLine: number;
	/** Offsets of the window's whole lines in the content */
	start: number;
	end: number;
	replacements: TextReplacement[];
}

/**
 * Group replacements into windows of whole lines: the lines they touch plus
 * `marginLines` unchanged lines on each side. Windows that would touch or
 * overlap are merged. With a margin of at least the diff context, unchanged
 * lines between windows are never shown as context of any hunk.
 */
function getDiffWindows(content: string, replacements: TextReplacement[], marginLines: number): DiffWindow[] {
	// Zero-based line of an offset. Offsets are queried in ascending order, so one forward scan serves all.
	let lineOfNext = 0;
	let nextLineFeed = content.indexOf("\n");
	const lineAt = (offset: number): number => {
		while (nextLineFeed !== -1 && nextLineFeed < offset) {
			lineOfNext++;
			nextLineFeed = content.indexOf("\n", nextLineFeed + 1);
		}
		return lineOfNext;
	};

	const lineWindows: Array<{ firstLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	for (const replacement of replacements) {
		const firstLine = Math.max(0, lineAt(replacement.start) - marginLines);
		// The line containing the end offset counts as touched even when the range ends at its start:
		// replacing the preceding line feed joins it to the line before.
		const endLine = lineAt(replacement.end) + 1 + marginLines;
		const current = lineWindows[lineWindows.length - 1];
		if (current && firstLine <= current.endLine) {
			current.endLine = endLine;
			current.replacements.push(replacement);
			continue;
		}
		lineWindows.push({ firstLine, endLine, replacements: [replacement] });
	}

	// Offset where a zero-based line starts, or the content length past the last line. Ascending queries again.
	let scannedLine = 0;
	let scannedOffset = 0;
	const lineStart = (line: number): number => {
		while (scannedLine < line && scannedOffset < content.length) {
			const lineFeed = content.indexOf("\n", scannedOffset);
			scannedOffset = lineFeed === -1 ? content.length : lineFeed + 1;
			scannedLine++;
		}
		return scannedOffset;
	};

	return lineWindows.map((window) => ({
		firstLine: window.firstLine,
		start: lineStart(window.firstLine),
		end: lineStart(window.endLine),
		replacements: window.replacements,
	}));
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		const file = decodeFile(await readFile(absolutePath));
		const { diff, firstChangedLine } = generateMatchedEditsDiff(
			path,
			matchEdits(file.text, edits, path, file.encoding),
		);
		return { diff, firstChangedLine };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
