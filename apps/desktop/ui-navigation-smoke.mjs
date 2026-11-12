import assert from "node:assert/strict";

async function waitFor(check, label) {
	const deadline = performance.now() + 12000;
	while (!await check()) {
		assert.ok(performance.now() < deadline, label);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

export async function selectWorkspace(evaluate, workspace) {
	await waitFor(() => evaluate("Boolean(document.querySelector('[data-workspace-button=" + workspace + "]'))"), "WORKSPACE_ENTRY");
	await evaluate("document.querySelector('[data-workspace-button=" + workspace + "]').click()");
	await waitFor(() => evaluate("document.querySelector('header')?.getAttribute('aria-busy')==='false' && document.querySelector('[data-workspace=" + workspace + "]')?.hidden===false"), "WORKSPACE_READY_" + workspace);
}

export async function openHeaderMenu(evaluate, menu, label) {
	await waitFor(() => evaluate("Boolean(document.querySelector('[data-menu=" + menu + "]:not([disabled])'))"), "MENU_READY_" + menu);
	await evaluate("document.querySelector('[data-menu=" + menu + "]').click()");
	await waitFor(() => evaluate("[...document.querySelectorAll('[role=menu] button')].some(button=>button.textContent===" + JSON.stringify(label) + "&&!button.disabled)"), "MENU_ITEM_" + label);
	await evaluate("[...document.querySelectorAll('[role=menu] button')].find(button=>button.textContent===" + JSON.stringify(label) + ").click()");
}

export async function addWorkbenchPanel(evaluate, id) {
	await waitFor(() => evaluate("Boolean(document.querySelector('[data-menu=panels]:not([disabled])'))"), "PANEL_MENU_READY");
	await evaluate("document.querySelector('[data-menu=panels]').click()");
	await waitFor(() => evaluate("Boolean(document.querySelector('[data-add-panel=" + id + "]'))"), "PANEL_ENTRY_" + id);
	await evaluate("document.querySelector('[data-add-panel=" + id + "]').click()");
}

export async function verifyWorkspaceNavigation(driver) {
	const evaluate = source => driver.testCommand("evaluate", { source });
	const request = (action, args = {}) => driver.api("workbench", { action, args });
	await selectWorkspace(evaluate, "game");
	assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-workspace=game] .dv-tab')].map(tab=>tab.textContent.trim())"), ["游戏 / 原生视口"]);
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=game] .current-game-task'))"), true);
	const before = { tasks: (await request("state")).tasks, game: await driver.api("game", { action: "snapshot" }), probes: driver.getProbeSequence(), native: await driver.api("status") };
	for (const workspace of ["observation", "development", "game", "development"]) await selectWorkspace(evaluate, workspace);
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=development] .game-panel'))"), false);
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=development] .output-panel'))"), false);
	assert.deepEqual((await request("state")).tasks, before.tasks);
	assert.deepEqual((await driver.api("game", { action: "snapshot" })).tasks, before.game.tasks);
	assert.equal(driver.getProbeSequence(), before.probes);
	assert.equal((await driver.api("status")).gameCalls, before.native.gameCalls);
	assert.equal((await driver.api("bridge", { action: "snapshot" })).selected, null);
	await addWorkbenchPanel(evaluate, "tasks");
	await waitFor(async () => Boolean(await request("ui-get", { key: "layout-development" })), "WORKSPACE_LAYOUT_SAVED");
	const legacy = await request("ui-get", { key: "layout-development" });
	await request("ui-save", { key: "layout", value: legacy });
	await request("ui-save", { key: "layout-development", value: null });
	await driver.testCommand("reload");
	await selectWorkspace(evaluate, "development");
	assert.equal(await evaluate("[...document.querySelectorAll('[data-workspace=development] .dv-tab')].some(tab=>tab.textContent.trim()==='任务记录')"), true);
	assert.deepEqual(await request("ui-get", { key: "layout" }), legacy);
	for (const [workspace, id] of [["game", "events"], ["observation", "research"], ["development", "output"]]) {
		await selectWorkspace(evaluate, workspace);
		await addWorkbenchPanel(evaluate, id);
		await waitFor(async () => Boolean(await request("ui-get", { key: "layout-" + workspace })), "WORKSPACE_LAYOUT_" + workspace);
	}
	const layouts = await Promise.all(["game", "observation", "development"].map(workspace => request("ui-get", { key: "layout-" + workspace })));
	assert.equal(new Set(layouts.map(layout => JSON.stringify(layout))).size, 3);
	assert.deepEqual(await request("ui-get", { key: "layout" }), legacy);
}
