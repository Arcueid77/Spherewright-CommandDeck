import { lstat, realpath, readFile, readdir, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

const missing = () => new Error("PROFILE_LEDGER_EVIDENCE_MISSING");
const invalid = () => new Error("PROFILE_LEDGER_GUARD_INVALID");

export function ledgerPresenceConfiguration(runId = null) {
	if (runId !== null && !/^[a-f0-9-]{36}$/.test(runId)) throw invalid();
	return Object.freeze({
		marker: runId === null ? "ledger-presence.json" : "ledger-presence-" + runId + ".json",
		stores: Object.freeze([
			Object.freeze({ role: "game", file: (runId === null ? "game" : "game-smoke-" + runId) + "/game-tasks.sqlite" }),
			Object.freeze({ role: "workbench", file: (runId === null ? "workbench" : "m1-smoke-" + runId) + "/workbench.sqlite" }),
		]),
		sessions: runId === null ? "game-agent" : "game-agent-smoke-" + runId,
	});
}

async function info(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

// This inventory is loss-detection metadata, not an execution permission or a
// replacement for the stores' schema, intent and original-action validation.
export async function prepareLedgerPresence(directory, runId = null) {
	const base = await realpath(directory), config = ledgerPresenceConfiguration(runId), marker = join(base, config.marker);
	const expected = { version: 1, kind: "commanddeck-ledger-presence", stores: config.stores };
	async function readMarker() {
		const entry = await info(marker); if (!entry) return null;
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > 4096 || (await realpath(marker)).toLowerCase() !== marker.toLowerCase()) throw invalid();
		const bytes = await readFile(marker); let value;
		try { value = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
		if (Number.isSafeInteger(value?.version) && value.version > 1) throw new Error("PROFILE_LEDGER_GUARD_UNSUPPORTED");
		if (!isDeepStrictEqual(value, expected)) throw invalid();
		return bytes;
	}
	async function storeInfo(store) {
		const path = join(base, store.file), entry = await info(path); if (!entry) return null;
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size === 0 || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw missing();
		return entry;
	}
	async function traces(path) {
		const entry = await info(path); if (!entry) return false;
		if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw missing();
		return (await readdir(path)).length > 0;
	}
	const original = await readMarker();
	for (const store of config.stores) {
		if (await storeInfo(store)) continue;
		if (original || await traces(dirname(join(base, store.file))) || await traces(join(base, config.sessions))) throw missing();
	}
	let sealed = false;
	return Object.freeze({
		async seal() {
			if (sealed) return;
			for (const store of config.stores) if (!await storeInfo(store)) throw missing();
			const current = await readMarker();
			if (original) { if (!current?.equals(original)) throw invalid(); }
			else {
				if (current) throw invalid();
				let handle;
				try { handle = await open(marker, "wx", 0o600); await handle.writeFile(JSON.stringify(expected)); await handle.sync(); }
				catch (error) { if (error.code === "EEXIST") throw invalid(); throw error; }
				finally { await handle?.close(); }
				// Retain a partial or changed file on failure; never delete/rebuild it.
				if (!(await readMarker())?.equals(Buffer.from(JSON.stringify(expected)))) throw invalid();
			}
			sealed = true;
		},
	});
}
