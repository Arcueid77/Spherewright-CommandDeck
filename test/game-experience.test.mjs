import test from "node:test";
import assert from "node:assert/strict";
import { loadGameExperience, gameExperienceBrief, gameExperienceRead, validateGameExperienceRecord } from "../apps/desktop/game-experience.mjs";

test("the bundled Lab snapshot supplies bounded core guidance and traceable on-demand evidence", async () => {
	const value = await loadGameExperience(), brief = gameExperienceBrief(value);
	assert.equal(value.lessonIds.length, 20);
	assert.equal(brief.lessons.length, 4);
	assert.ok(brief.lessons.some(lesson => lesson.id === "research-material-flow" && lesson.guidance.includes("科研")));
	const selected = gameExperienceRead(value, { topic: "movement" });
	assert.equal(selected.lessons[0].id, "movement-progress");
	assert.match(value.source.revision, /^[a-f0-9]{40}$/);
	assert.match(value.source.fileSha256, /^[a-f0-9]{64}$/);
	assert.ok(selected.lessons[0].sources[0].path.startsWith("operations/"));
	assert.throws(() => gameExperienceRead(value, { ids: ["missing"] }), /INVALID_GAME_EXPERIENCE_QUERY/);
	assert.throws(() => validateGameExperienceRecord({ version: 1, source: { ...value.source, path: "../private" }, lessonIds: [] }), /INVALID_GAME_EXPERIENCE_RECORD/);
});

test("default Lab guidance covers the full opening-to-blue path before the first model decision", async () => {
	const value = await loadGameExperience(), brief = gameExperienceBrief(value);
	const guidance = brief.lessons.map(lesson => lesson.guidance).join("\n");
	for (const term of ["着陆舱", "侧向", "燃料", "制造", "科研", "端口", "分拣器", "峰值", "过滤", "储存", "连续", "保存", "activeTools"]) assert.ok(guidance.includes(term), term);
	for (const id of ["opening-obstructions", "fuel-and-energy", "bootstrap-research", "blue-chain-bom", "machine-port-layout", "power-network-coverage", "powered-logistics", "belt-flow-routing", "clean-material-sources", "storage-and-transfers", "throughput-window", "milestone-persistence"]) assert.equal(gameExperienceRead(value, { ids: [id] }).lessons[0].id, id);
});
