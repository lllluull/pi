import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult } from "./harness.ts";

// #11842: explicit inspection must recover the schema hidden by the catalog budget.
it("keeps the catalog bounded but exposes large input types through describeTool", async () => {
	const fields = Array.from({ length: 100 }, (_, index) => `field_${String(index).padStart(3, "0")}`);
	const parameters = Type.Object(
		Object.fromEntries(
			fields.map((name) => [
				name,
				Type.Integer({
					minimum: 0,
					description:
						"A reconciliation reference used to associate this record with its original source. ".repeat(3),
				}),
			]),
		),
	);
	const harness = await createHarness({
		initialActiveToolNames: ["codemode"],
		settings: { codemode: { mode: "only", inlineBudget: 0 } },
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "reconcile-records",
					label: "Reconcile records",
					description: "Inspect reconciliation records.",
					promptGuidelines: ["Inspect only; do not submit payments."],
					exposure: "codemode",
					parameters,
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		],
	});
	try {
		const initialDescription = harness.session.agent.state.tools.find(
			(tool) => tool.name === "codemode",
		)?.description;
		expect(initialDescription).not.toContain("field_000");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const catalog = ALL_TOOLS.find(tool => tool.name === "reconcile_records").description;
							const detail = await describeTool("reconcile-records");
							const alias = await describeTool("reconcile_records");
							text({
								catalogUnknown: catalog.includes("args: unknown"),
								catalogChars: catalog.length,
								detailChars: detail.length,
								fields: (detail.match(/field_[0-9]{3}:/g) || []).length,
								constraints: detail.includes("@integer @minimum 0"),
								guideline: detail.includes("Inspect only; do not submit payments."),
								aliasMatches: alias === detail,
								missing: (await describeTool("missing")) === undefined
							});`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Inspect the input contract before reconciling records.");
		const result = getToolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		const text = getMessageText(result);
		const metrics = JSON.parse(text.slice(text.indexOf("{")));
		expect(metrics).toMatchObject({
			catalogUnknown: true,
			fields: 100,
			constraints: true,
			guideline: true,
			aliasMatches: true,
			missing: true,
		});
		expect(metrics.detailChars).toBeGreaterThan(16_000);
		expect(metrics.catalogChars).toBeLessThan(1_000);
		expect(harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description).toBe(
			initialDescription,
		);
	} finally {
		harness.cleanup();
	}
});
