import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Hydration verifies the committed pin. It must not rewrite a matching checkout
// (including its CRLF bytes) and leave the release source spuriously dirty.
export function preserveModelDataLock(path, expected) {
	let existing;
	try { existing = readFileSync(path, "utf8"); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	if (existing !== undefined) {
		if (!isDeepStrictEqual(JSON.parse(existing), expected))
			throw new Error("The pinned model-data metadata changed.");
		return;
	}
	writeFileSync(path, JSON.stringify(expected, null, 2) + "\n", { flag: "wx" });
}
