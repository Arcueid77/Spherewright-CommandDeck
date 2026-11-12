import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

export const disabledGameExecutionSource = "(()=>{const panel=document.querySelector('.game-tasks-panel'),forms=panel?.querySelectorAll('fieldset'),buttons=panel?.querySelectorAll('.game-task-primary button');return Boolean(forms?.length===2&&[...forms].every(field=>field.matches(':disabled'))&&buttons?.length&&[...buttons].filter(button=>/核对并确认|开始分析|开始游戏任务|核对授权并开始|核对并继续/.test(button.textContent)).every(button=>button.matches(':disabled')))})()";

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

export async function selectObservationTopic(evaluate, topic) {
	await selectWorkspace(evaluate, "observation");
	await evaluate("[...document.querySelectorAll('[data-workspace=observation] .dv-tab')].find(tab=>tab.textContent.trim()==='当前世界').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))");
	await waitFor(() => evaluate("Boolean(document.querySelector('[data-observation-topic=" + topic + "]'))"), "OBSERVATION_TOPIC_" + topic);
	await evaluate("document.querySelector('[data-observation-topic=" + topic + "]').click()");
}

export async function verifyResponsiveLayout(driver, workspace) {
	const evaluate = source => driver.testCommand("evaluate", { source });
	await selectWorkspace(evaluate, workspace);
	await driver.testCommand("show-ui");
	for (const [width, height] of [[1366, 768], [3440, 1369]]) {
		assert.deepEqual(await driver.testCommand("resize-ui", { width, height }), [width, height]);
		await waitFor(() => evaluate("innerWidth===" + width + "&&innerHeight===" + height), "RESPONSIVE_SIZE");
		await waitFor(() => evaluate("(()=>{const dock=document.querySelector('[data-workspace=" + workspace + "] .workspace-dock'),grid=dock?.querySelector('.dv-grid-view');return Boolean(grid&&Math.abs(grid.getBoundingClientRect().width-dock.clientWidth)<2&&Math.abs(grid.getBoundingClientRect().height-dock.clientHeight)<2)})()"), "RESPONSIVE_DOCK_FILLS_" + workspace);
		await new Promise(resolve => setTimeout(resolve, 120));
		const result = await evaluate("(()=>{const header=document.querySelector('header'),buttons=[...header.querySelectorAll('button')].filter(button=>button.getBoundingClientRect().height>0),primary=document.querySelector('.current-game-task .game-task-primary'),next=document.querySelector('.current-game-task .game-goal-next'),bounds=primary?.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,headerFits:buttons.every(button=>{const r=button.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=header.getBoundingClientRect().bottom}),fonts:buttons.every(button=>Number.parseFloat(getComputedStyle(button).fontSize)>=14),primaryFits:!bounds||bounds.height===0||bounds.top>=header.getBoundingClientRect().bottom&&bounds.bottom<=innerHeight,nextVisible:!next||next.getBoundingClientRect().bottom<=bounds.top}})()");
		assert.deepEqual(result, { overflow: false, headerFits: true, fonts: true, primaryFits: true, nextVisible: true }, workspace + " " + width + "x" + height);
		const kind = workspace === "observation" ? "bridge" : workspace === "game" ? "game" : "workbench";
		const capture = await driver.testCommand("capture-" + kind);
		if (capture.captured) await copyFile(join(driver.root, kind === "game" ? ".local/m3-smoke-game.private.png" : kind === "bridge" ? ".local/m2-smoke-bridge.private.png" : ".local/m1-smoke-workbench.private.png"), join(driver.root, ".local/workspace-" + workspace + "-" + width + "x" + height + ".private.png"));
	}
	await driver.testCommand("resize-ui", { width: 1440, height: 900 });
}

export async function verifyWorkspaceNavigation(driver) {
	const evaluate = source => driver.testCommand("evaluate", { source });
	const request = (action, args = {}) => driver.api("workbench", { action, args });
	await selectWorkspace(evaluate, "game");
	assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-workspace=game] .dv-tab')].map(tab=>tab.textContent.trim())"), ["游戏 / 原生视口"]);
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=game] .current-game-task'))"), true);
	await verifyResponsiveLayout(driver, "game");
	const before = { tasks: (await request("state")).tasks, game: await driver.api("game", { action: "snapshot" }), probes: driver.getProbeSequence(), native: await driver.api("status") };
	for (const workspace of ["observation", "development", "game", "development"]) await selectWorkspace(evaluate, workspace);
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=development] .game-panel'))"), false);
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=development] .output-panel'))"), false);
	await verifyResponsiveLayout(driver, "development");
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
	await openHeaderMenu(evaluate, "layout", "恢复当前工作区默认布局");
	assert.equal(await evaluate("Boolean(document.querySelector('[data-workspace=development] .output-panel'))"), false);
	assert.deepEqual(await request("ui-get", { key: "layout" }), legacy);
}
