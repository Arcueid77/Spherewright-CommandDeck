const collections = {
	spherewright_get_progression_state: { technologies: ["techId", "name", "unlocked", "isQueued", "prerequisiteTechIds"] },
	spherewright_get_recipe_catalog: { items: ["itemId", "name", "unlocked", "handcraftRecipeId"], recipes: ["recipeId", "name", "unlocked", "handcraft", "recipeType", "prerequisiteTechId"] },
	spherewright_get_build_catalog: { buildings: ["itemId", "name", "role", "unlocked", "available", "buildMode"], recipes: ["recipeId", "name", "unlocked", "recipeType"] },
};

export const gameCatalogSources = Object.keys(collections);

export function gameCatalogIndex(source, reply) {
	if (reply?.success !== true || !gameCatalogSources.includes(source)) return reply;
	const result = { ...reply.result };
	for (const [name, fields] of Object.entries(collections[source])) {
		if (!Array.isArray(result[name])) continue;
		result[name] = result[name].map(row => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
	}
	return { ...reply, result, catalogView: { source, indexedCollections: Object.keys(collections[source]), detailsTool: "deck_goal_catalog", description: "Indexed native rows. Read full selected rows with deck_goal_catalog. Unlock flags retain the source observation time. Native prepare remains authoritative." } };
}

export function gameCatalogDetails(cache, args) {
	if (!args || Object.keys(args).some(key => !["source", "collection", "ids", "query", "offset", "limit"].includes(key))
		|| !gameCatalogSources.includes(args.source) || !Object.hasOwn(collections[args.source], args.collection)
		|| args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.length > 16 || args.ids.some(id => !Number.isSafeInteger(id) || id < 1))
		|| args.query !== undefined && (typeof args.query !== "string" || args.query.length > 80)
		|| args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)
		|| args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 8)) throw new Error("INVALID_GAME_CATALOG_QUERY");
	const entry = cache.get(args.source);
	if (!entry) return { success: false, error: { code: "GAME_CATALOG_SOURCE_REQUIRED", message: "Read the named native source first to capture its index." } };
	const rows = entry.reply.result?.[args.collection];
	if (!Array.isArray(rows)) return { success: false, error: { code: "GAME_CATALOG_COLLECTION_UNAVAILABLE" } };
	const query = args.query?.toLowerCase() ?? "";
	const selected = rows.filter(row => (!args.ids || args.ids.includes(row.techId ?? row.recipeId ?? row.itemId)) && (!query || String(row.name ?? "").toLowerCase().includes(query)));
	const offset = args.offset ?? 0, limit = args.limit ?? 4, page = selected.slice(offset, offset + limit);
	if (JSON.stringify(page).length > 32768) return { success: false, error: { code: "GAME_CATALOG_PAGE_TOO_LARGE", message: "Use fewer selected IDs or a smaller limit." } };
	return { success: true, result: { source: args.source, collection: args.collection, sourceArgs: structuredClone(entry.args), capturedAtGameTick: entry.reply.result.capturedAtGameTick ?? null, sourceRevision: entry.reply.result.revision ?? null, total: selected.length, offset, nextOffset: offset + page.length < selected.length ? offset + page.length : null, sourcePaths: page.map(row => "/result/" + args.collection + "/" + rows.indexOf(row)), rows: structuredClone(page) } };
}
