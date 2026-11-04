/**
 * The `tool_search` tool, a copy of the coding agent's: the model searches the deferred tools it is not offered yet,
 * and the matches are loaded with `control.addTools`, so the next request offers them. Loading writes the
 * conversation's `modelTools` (its `add`), so loaded tools stay offered on that branch, also after a compaction.
 */
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { rankDocuments } from "../search.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** Fixed, so it does not change while deferred tools are registered, for example as MCP servers connect. */
const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

const toolSearchSchema = obj(
	{
		query: str({ description: "Search query for deferred tools." }),
		limit: opt(num({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` })),
	},
	{ open: true },
);

/** `tool_search` result details: the tools it loaded. */
export type ToolSearchToolDetails = { loaded: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a JSON Pointer within this schema resource, without fetching external schemas. */
function localSchemaRef(root: unknown, ref: string): { schema: unknown; root: unknown } | undefined {
	if (!ref.startsWith("#")) return;
	let pointer: string;
	try {
		pointer = decodeURIComponent(ref.slice(1));
	} catch {
		return;
	}
	if (pointer !== "" && !pointer.startsWith("/")) return;
	let schema = root;
	for (const segment of pointer === "" ? [] : pointer.slice(1).split("/")) {
		const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (typeof schema !== "object" || schema === null || !Object.hasOwn(schema, key)) return;
		// JSON Pointers can also address an array element, such as an anyOf branch.
		schema = (schema as Record<string, unknown>)[key];
		if (isObject(schema) && typeof schema.$id === "string" && schema.$id !== "" && !schema.$id.startsWith("#"))
			root = schema;
	}
	return { schema, root };
}

/** Schema descriptions and property names, including reachable local references. */
function schemaText(schema: unknown, parts: string[], root: unknown = schema, seen = new Set<object>()): void {
	if (!isObject(schema) || seen.has(schema)) return;
	seen.add(schema);
	if (typeof schema.$id === "string" && schema.$id !== "" && !schema.$id.startsWith("#")) root = schema;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (typeof schema.$ref === "string") {
		const target = localSchemaRef(root, schema.$ref);
		if (target) schemaText(target.schema, parts, target.root, seen);
	}
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts, root, seen);
		}
	}
	schemaText(schema.items, parts, root, seen);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts, root, seen);
	}
}

/** Search text of a tool: its description and its parameters' names and descriptions; the ranker reads the name. */
function searchText(tool: ToolRegistration): string {
	const parts = [tool.description];
	schemaText(tool.parameters, parts);
	return parts.filter((part) => part.trim() !== "").join(" ");
}

export function createToolSearchTool() {
	return defineTool({
		name: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		parameters: toolSearchSchema,
		// Searching changes what the model is offered; scripts have their own `searchTools()`.
		callers: ["model"],
		replay: "safe",
		async execute({ query, limit }, api, context) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const candidates = (await api.agent(context)).deferred;
			const documents = candidates.map((tool) => ({ name: tool.name, text: searchText(tool) }));
			const loaded = rankDocuments(query, documents, max);
			const text =
				loaded.length === 0
					? "No matching tools found."
					: `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
							.map((name) => {
								const description = candidates.find((tool) => tool.name === name)?.description ?? "";
								return `- ${name}: ${description.trim().split(/\r?\n/)[0]}`;
							})
							.join("\n")}`;
			const details: ToolSearchToolDetails = { loaded };
			return {
				output: [{ type: "text", text }],
				details,
				...(loaded.length === 0 ? {} : { control: { addTools: loaded } }),
			};
		},
	});
}

/** The `tool_search` extension: install it and select it where the model should find deferred tools. */
export function createToolSearchExtension() {
	return defineExtension({ name: "tool-search", tools: [createToolSearchTool()] });
}
