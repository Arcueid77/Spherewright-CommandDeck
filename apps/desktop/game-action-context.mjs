const playerHash = "expectedPlayerStateHash";
const fullEntityHashes = {
	spherewright_prepare_transfer: ["expectedStorageStateHash", "storageEntityId"],
};
const entityConfigurationModes = new Set(["production", "research", "sorter-filter", "storage-capacity"]);

export function gameActionContextFields(entry) {
	const properties = entry.inputSchema.properties, fields = ["sessionId", "planetId", playerHash].filter(field => Object.hasOwn(properties, field));
	if (entry.name === "spherewright_prepare_harvest" || entry.name === "spherewright_prepare_build") fields.push("expectedResourceStateHash");
	if (entry.name === "spherewright_prepare_select_research") fields.push("expectedSelectionStateHash");
	if (entry.name === "spherewright_prepare_save") fields.push("expectedRevision");
	if (fullEntityHashes[entry.name]) fields.push(fullEntityHashes[entry.name][0]);
	return fields.filter(field => Object.hasOwn(properties, field));
}

export function gameActionIntentSchema(entry) {
	const schema = structuredClone(entry.inputSchema), fields = new Set(gameActionContextFields(entry));
	for (const field of fields) delete schema.properties[field];
	schema.required = (schema.required ?? []).filter(field => !fields.has(field));
	if (entry.name === "spherewright_prepare_configure_building") schema.required = schema.required.filter(field => field !== "expectedFactoryStateHash");
	return schema;
}

export async function resolveGameActionContext(session, entry, requested, read, observedEndpoint = () => null) {
	const managed = gameActionContextFields(entry);
	if (managed.some(field => Object.hasOwn(requested, field))) throw new Error("GAME_ACTION_CONTEXT_IS_HOST_OWNED");
	const context = { sessionId: session.context.sessionId, planetId: session.context.planetId }, args = { ...requested };
	const entities = new Map();
	const value = async (name, input) => {
		const reply = await read(name, input);
		if (reply?.success !== true || !reply.result) throw new Error("GAME_ACTION_EVIDENCE_UNAVAILABLE");
		return reply.result;
	};
	const hash = (snapshot, field) => {
		if (!/^sha256:[a-f0-9]{64}$/.test(snapshot?.[field] ?? "")) throw new Error("GAME_ACTION_EVIDENCE_UNAVAILABLE");
		return snapshot[field];
	};
	const entity = async id => {
		if (!entities.has(id)) entities.set(id, await value("spherewright_inspect_factory_entity", { ...context, objectId: id }));
		return entities.get(id);
	};
	for (const field of ["sessionId", "planetId"]) if (managed.includes(field)) args[field] = context[field];
	if (managed.includes("expectedRevision")) args.expectedRevision = (await value("spherewright_get_session_state", {})).revision;
	if (managed.includes("expectedSelectionStateHash")) args.expectedSelectionStateHash = hash(await value("spherewright_get_progression_state", context), "selectionStateHash");
	if (managed.includes("expectedResourceStateHash")) {
		const id = entry.name === "spherewright_prepare_harvest" ? args.nodeId : args.resourceNodeId;
		if (id) args.expectedResourceStateHash = hash(await value("spherewright_inspect_resource_node", { ...context, kind: args.resourceKind ?? "vein", nodeId: id }), "stateHash");
	}
	if (fullEntityHashes[entry.name]) {
		const [field, idField] = fullEntityHashes[entry.name], previous = observedEndpoint(args[idField]);
		if (!previous) throw new Error("GAME_ACTION_TARGET_OBSERVATION_REQUIRED");
		const snapshot = await entity(args[idField]);
		if (hash(snapshot, "endpointStateHash") !== previous) throw new Error("GAME_ACTION_TARGET_CHANGED");
		args[field] = hash(snapshot, "stateHash");
	}
	if (entry.name === "spherewright_prepare_configure_building" && args.expectedFactoryStateHash === undefined) {
		const mode = args.mode ?? "production";
		if (!entityConfigurationModes.has(mode)) throw new Error("GAME_ACTION_EXPLICIT_EVIDENCE_REQUIRED");
		const previous = observedEndpoint(args.entityId);
		if (!previous) throw new Error("GAME_ACTION_TARGET_OBSERVATION_REQUIRED");
		const snapshot = await entity(args.entityId);
		if (hash(snapshot, "endpointStateHash") !== previous) throw new Error("GAME_ACTION_TARGET_CHANGED");
		args.expectedFactoryStateHash = hash(snapshot, mode === "sorter-filter" ? "configurationStateHash" : "stateHash");
	}
	let player = null;
	if (managed.includes(playerHash)) { player = await value("spherewright_get_player_state", context); args[playerHash] = hash(player, "stateHash"); }
	return { args, player };
}
