// Closed, host-only capability. These names are never accepted from renderer/model RPC.
export const researchPlaybookUri = "spherewright://agent/playbooks/opening-movement-v1";
export const researchDefinitions = {
	spherewright_get_progression_state: { readOnly: true, destructive: false, fields: { sessionId: "string", planetId: "integer" } },
	spherewright_get_player_state: { readOnly: true, destructive: false, fields: { sessionId: "string", planetId: "integer" } },
	spherewright_prepare_select_research: { readOnly: false, destructive: false, fields: { sessionId: "string", planetId: "integer", techId: "integer", expectedSelectionStateHash: "string", stateHashVersion: "integer", prioritizeQueued: "boolean" }, optional: ["stateHashVersion", "prioritizeQueued"] },
	spherewright_commit_select_research: { readOnly: false, destructive: true, fields: { sessionId: "string", planetId: "integer", planToken: "string", idempotencyKey: "string" } },
	spherewright_get_action_result: { readOnly: true, destructive: false, fields: { actionId: "string" } },
};
export const opaque = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value);
export const positive = (value) => Number.isSafeInteger(value) && value > 0;
export const tick = (value) => Number.isSafeInteger(value) && value >= 0;
export const selectionHash = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
export function supportedResearchTool(tool) {
	const definition = researchDefinitions[tool?.name];
	if (!definition || tool.annotations?.readOnlyHint !== definition.readOnly || tool.annotations?.destructiveHint !== definition.destructive) return false;
	const schema = tool.inputSchema, required = schema?.required ?? [];
	return schema?.type === "object" && Array.isArray(required) && required.every((key) => Object.hasOwn(definition.fields, key)) && Object.entries(definition.fields).every(([key, type]) => schema.properties?.[key]?.type === type && (definition.optional?.includes(key) || required.includes(key)));
}
export function validResearchArguments(name, args) {
	const fields = researchDefinitions[name]?.fields;
	if (!fields || !args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).length !== Object.keys(fields).length || !Object.keys(args).every((key) => Object.hasOwn(fields, key))) return false;
	for (const key of Object.keys(fields)) {
		const value = args[key];
		if (["sessionId", "actionId"].includes(key) && !opaque(value)) return false;
		if (key === "idempotencyKey" && (typeof value !== "string" || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return false;
		if (["planetId", "techId"].includes(key) && !positive(value)) return false;
		if (key === "expectedSelectionStateHash" && !selectionHash(value)) return false;
		if (key === "stateHashVersion" && value !== 1 || key === "prioritizeQueued" && value !== false) return false;
		if (key === "planToken" && (typeof value !== "string" || value.length < 20 || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) return false;
	}
	return true;
}
