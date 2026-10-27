import test from "node:test";
import assert from "node:assert/strict";
import { validateActionUpgradePair } from "../scripts/action-upgrade-state.mjs";

function pair() {
	const value = { sourceRevision: "a".repeat(40), piCommit: "c".repeat(40), portableStorageFaults: 1, nativeProcessObserver: 1, files: [{ path: "resources/app/test/fixtures/research-mcp-server.mjs", sha256: "d".repeat(64) }, { path: "resources/app/apps/desktop/research-preview.mjs", sha256: "e".repeat(64) }] };
	return [value, { ...structuredClone(value), sourceRevision: "b".repeat(40) }];
}
test("an action-upgrade pair requires distinct pinned Deck candidates and an unchanged original synthetic protocol", () => {
	const [baseline, candidate] = pair(); validateActionUpgradePair(baseline, candidate);
	for (const alter of [value => { value.sourceRevision = baseline.sourceRevision; }, value => { value.piCommit = "f".repeat(40); }, value => { value.portableStorageFaults = 0; }, value => { value.files.pop(); }, value => { value.files[0].sha256 = "f".repeat(64); }]) {
		const changed = structuredClone(candidate); alter(changed); assert.throws(() => validateActionUpgradePair(baseline, changed));
	}
});
