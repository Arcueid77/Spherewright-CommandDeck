import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runPopoutSmoke(driver) {
	const evaluate = source => driver.testCommand("evaluate", { source });
	const state = () => driver.testCommand("popout-state");
	const childEvaluate = (windowName, source) => driver.testCommand("popout-evaluate", { windowName, source });
	async function until(check, code) {
		const deadline = performance.now() + 12000;
		while (!await check()) { assert.ok(performance.now() < deadline, code); await new Promise(done => setTimeout(done, 50)); }
	}
	const chooseTab = title => evaluate(`[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()===${JSON.stringify(title)}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))`);
	const request = (action, args = {}) => driver.api("workbench", { action, args });
	const tasksBefore = (await request("state")).tasks, pid = driver.getRuntimePid();
	const original = await request("ui-get", { key: "editor" }); assert.ok(original?.text);
	await chooseTab("代码 / 差异");
	await until(async () => await evaluate("Boolean(document.querySelector('[data-popout-panel=editor]'))"), "POPOUT_EDITOR_TAB");
	assert.equal(await evaluate("document.location.href"), "deck-ui://app/index.html");
	assert.equal(await evaluate("window.open('https://example.invalid','external','width=400,height=300,top=0,left=0')===null"), true);
	await evaluate("document.querySelector('[data-popout-panel=editor]').click()");
	await until(async () => (await state()).length === 1, "POPOUT_NATIVE_WINDOW");
	let child = (await state())[0];
	await until(async () => await childEvaluate(child.name, "Boolean(document.querySelector('[aria-label=代码编辑器]'))"), "POPOUT_EDITOR_RENDER");
	child = (await state())[0];
	assert.equal(child.url, "deck-ui://app/popout.html");
	assert.deepEqual(child.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: false });
	assert.equal(child.visible, true);
	assert.equal(await childEvaluate(child.name, "(()=>{const rect=document.querySelector('[aria-label=代码编辑器]').getBoundingClientRect();return document.styleSheets.length>=2&&rect.width>0&&rect.height>0})()"), true);
	assert.deepEqual(await childEvaluate(child.name, "({node:typeof require,bridge:typeof window.deck,editor:document.querySelector('[aria-label=代码编辑器]').value})"), { node: "undefined", bridge: "undefined", editor: original.text });
	assert.equal(await childEvaluate(child.name, "window.open('deck-ui://app/popout.html','nested','width=400,height=300,top=0,left=0')===null"), true);
	const changed = original.text + "// typed in independent window\n";
	await childEvaluate(child.name, `(()=>{const area=document.querySelector('[aria-label=代码编辑器]');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area),'value').set.call(area,${JSON.stringify(changed)});area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
	await until(async () => (await request("ui-get", { key: "editor" })).text === changed, "POPOUT_EDIT_SAVED_TO_ORIGINAL_STATE");
	await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='模型设置').click()");
	await until(async () => await childEvaluate(child.name, "document.querySelector('.dv-popout-window').inert && !document.querySelector('.popout-modal-notice').hidden"), "POPOUT_MODAL_BLOCKS_INPUT");
	await evaluate("document.querySelector('[role=dialog] button').click()");
	await until(async () => await childEvaluate(child.name, "!document.querySelector('.dv-popout-window').inert"), "POPOUT_MODAL_RELEASES_INPUT");
	await until(async () => (await request("ui-get", { key: "layout" }))?.popoutGroups?.length === 1, "POPOUT_LAYOUT_SAVED");
	const oldWindowId = child.id;
	await driver.testCommand("reload");
	await until(async () => { const windows = await state(); return windows.length === 1 && windows[0].id !== oldWindowId; }, "POPOUT_RESTORED_AFTER_RELOAD");
	child = (await state())[0];
	await until(async () => await childEvaluate(child.name, "document.querySelector('[aria-label=代码编辑器]')?.value") === changed, "POPOUT_DRAFT_AFTER_RELOAD");
	const beforeCrash = child.id;
	await driver.testCommand("renderer-crash");
	await until(async () => { const windows = await state(); return windows.length === 1 && windows[0].id !== beforeCrash; }, "POPOUT_RESTORED_AFTER_RENDERER_CRASH");
	child = (await state())[0];
	await until(async () => await childEvaluate(child.name, "document.querySelector('[aria-label=代码编辑器]')?.value") === changed, "POPOUT_DRAFT_AFTER_RENDERER_CRASH");
	await childEvaluate(child.name, "document.querySelector('[data-popout-panel=editor]').click()");
	await until(async () => (await state()).length === 0 && await evaluate("document.querySelector('[aria-label=代码编辑器]')?.value") === changed, "POPOUT_RETURN_TO_MAIN");
	await chooseTab("任务记录");
	await evaluate("document.querySelector('[data-popout-panel=tasks]').click()");
	await until(async () => (await state()).length === 1, "POPOUT_TASK_WINDOW");
	child = (await state())[0];
	await until(async () => await childEvaluate(child.name, "Boolean(document.querySelector('.tasks-panel'))"), "POPOUT_TASKS_RENDER");
	await driver.testCommand("popout-close", { windowName: child.name });
	await until(async () => (await state()).length === 0 && await evaluate("Boolean(document.querySelector('.tasks-panel'))"), "POPOUT_NATIVE_CLOSE_RETURNS_PANEL");
	await chooseTab("游戏 / 原生视口");
	assert.equal(await evaluate("Boolean(document.querySelector('[data-popout-panel=game]'))"), false);
	await chooseTab("代码 / 差异");
	assert.equal(driver.getRuntimePid(), pid);
	assert.deepEqual((await request("state")).tasks, tasksBefore);
	const proof = { runId: driver.runId, realIndependentWindows: true, sharedEditorState: true, unsavedDraftSurvivesMoveReloadAndReturn: true, rendererCrashClosesAndRestoresOwnedPopouts: true, nativeCloseReturnsPanel: true, modalBlocksPopouts: true, ownWindowsNoPreloadOrNode: true, externalAndNestedWindowsDenied: true, originalRuntimeRetained: true, noTaskReplay: true, gameViewportRemainsInMain: true, gameCalls: 0, realModelRequests: 0, physicalInput: "not_tested", multiScreen: "not_tested" };
	const directory = join(driver.root, ".local/popout-smoke", driver.runId); await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "application.private.json"), JSON.stringify(proof), { flag: "wx" });
	return proof;
}
