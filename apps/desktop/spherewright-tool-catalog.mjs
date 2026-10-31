import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Use the schema implementation already shipped with the pinned Pi runtime.
const requirePi = createRequire(new URL("../../vendor/pi/node_modules/@earendil-works/pi-ai/package.json", import.meta.url));
const { Compile } = await import(pathToFileURL(requirePi.resolve("typebox/compile")).href);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
// These operations have additional conversation/restore authority, beyond an ordinary
// action confirmation. Discovery must never turn their presence into that authority.
const separateConsent = /^(?:save_import|resume_owned_game|reload_flight_checkpoint|quarantine_reconciliation|return_to_main_menu)$/;
export function spherewrightCatalog(tools) {
	const entries = new Map();
	for (const tool of tools) {
		if (!/^spherewright_[a-z0-9_]{1,100}$/.test(tool.name ?? "") || tool.inputSchema?.type !== "object" || JSON.stringify(tool.inputSchema).length > 65536) continue;
		const match = /^spherewright_(prepare|commit)_(.+)$/.exec(tool.name);
		if (match && separateConsent.test(match[2])) continue;
		const read = !match && tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false;
		if (!read && (!match || separateConsent.test(match[2]) || tool.annotations?.readOnlyHint !== false || tool.annotations?.destructiveHint !== (match[1] === "commit"))) continue;
		try {
			const schema = { ...structuredClone(tool.inputSchema), additionalProperties: false };
			const validator = Compile(schema);
			entries.set(tool.name, { tool: { name: tool.name, description: String(tool.description ?? tool.title ?? tool.name).slice(0, 16000), inputSchema: schema }, kind: read ? "read" : match[1], family: match?.[2], validator });
		} catch { /* An unsupported schema is unavailable, never implicitly permissive. */ }
	}
	for (const [name, entry] of entries) if (entry.kind !== "read") {
		const commit = entries.get(`spherewright_commit_${entry.family}`), prepare = entries.get(`spherewright_prepare_${entry.family}`);
		if (!prepare || !commit || commit.tool.inputSchema.properties?.planToken?.type !== "string" || commit.tool.inputSchema.properties?.idempotencyKey?.type !== "string" || Object.keys(commit.tool.inputSchema.properties).some(key => !["sessionId", "planetId", "planToken", "idempotencyKey"].includes(key))) entries.delete(name);
	}
	return entries;
}
export function validSpherewrightArguments(entry, args) {
	if (!entry || !object(args)) return false;
	try { return JSON.stringify(args).length <= 262144 && entry.validator.Check(args); } catch { return false; }
}
export function publicGameValue(value) {
	let nodes = 0;
	function visit(item, depth) {
		if (++nodes > 50000 || depth > 32) throw new Error("GAME_MCP_RESULT_LIMIT");
		if (Array.isArray(item)) return item.map(value => visit(value, depth + 1));
		if (!object(item)) return item;
		return Object.fromEntries(Object.entries(item).filter(([key]) => !/(?:token|ticket|credential|password|secret)$|^(?:saveName|originalSaveName|privatePath|descriptorPath|filePath|absolutePath|directoryPath)$/i.test(key)).map(([key, value]) => [key, visit(value, depth + 1)]));
	}
	const result = visit(value, 0);
	if (JSON.stringify(result).length > 1048576) throw new Error("GAME_MCP_RESULT_LIMIT");
	return result;
}
