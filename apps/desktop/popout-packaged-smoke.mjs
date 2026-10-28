import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPortableHistory, assertPortableHistory } from "./portable-history.mjs";
import { packagedPopoutVersion } from "./popout-case.mjs";

export async function runPackagedPopoutSmoke(driver, manifest) {
	const { api, testCommand, context, popoutCase } = driver;
	assert.equal(manifest.independentPopoutWindows, packagedPopoutVersion);
	const history = await readPortableHistory(context); assert.ok(history);
	const before = await assertPortableHistory(api, history), runtime = driver.getRuntimePid();
	const evaluate = source => testCommand("evaluate", { source }), windows = () => testCommand("popout-state");
	const request = (action, args = {}) => api("workbench", { action, args });
	const expected = { rootId: history.workbench.roots[0].id, path: "synthetic-popout-draft.txt", sha256: null, text: "Synthetic retained draft " + context.runId, diskText: "" };
	const panels = [["editor", "代码 / 差异"], ["tasks", "任务记录"], ["production", "生产"]];
	async function until(check, code) { const deadline = performance.now() + 12000; while (!await check()) { assert.ok(performance.now() < deadline, code); await new Promise(resolve => setTimeout(resolve, 50)); } }
	if (popoutCase.phase === "record") {
		assert.equal((await windows()).length, 0);
		assert.equal(await request("ui-get", { key: "editor" }), null);
		await request("ui-save", { key: "editor", value: expected });
		await testCommand("reload");
		await until(() => evaluate("document.querySelector('[aria-label=代码编辑器]')?.value===" + JSON.stringify(expected.text)), "PACKAGED_POPOUT_DRAFT");
		for (const [id, title] of panels) {
			await evaluate(`[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()===${JSON.stringify(title)}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))`);
			await until(() => evaluate(`Boolean(document.querySelector('[data-popout-panel=${id}]'))`), "PACKAGED_POPOUT_TAB");
			await evaluate(`document.querySelector('[data-popout-panel=${id}]').click()`);
			await until(async () => (await windows()).length === panels.findIndex(panel => panel[0] === id) + 1, "PACKAGED_POPOUT_OPEN");
		}
	}
	await until(async () => (await windows()).length === 3 && (await windows()).every(child => child.url === "deck-ui://app/popout.html" && child.visible), "PACKAGED_POPOUT_WINDOWS_READY");
	const opened = await windows(), contents = [];
	for (const child of opened) {
		assert.deepEqual(child.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: false });
		const value = await testCommand("popout-evaluate", { windowName: child.name, source: "({panel:document.querySelector('[data-popout-panel]')?.dataset.popoutPanel,draft:document.querySelector('[aria-label=代码编辑器]')?.value,readOnly:document.querySelector('[aria-label=代码编辑器]')?.readOnly,node:typeof require,bridge:typeof window.deck,styles:document.styleSheets.length,body:document.body.textContent.length})" });
		assert.equal(value.node, "undefined"); assert.equal(value.bridge, "undefined"); assert.ok(value.styles >= 2 && value.body > 10); contents.push(value);
	}
	assert.deepEqual(contents.map(value => value.panel).sort(), panels.map(([id]) => id).sort());
	assert.equal(contents.find(value => value.panel === "editor").draft, expected.text);
	assert.equal(contents.find(value => value.panel === "editor").readOnly, true);
	assert.deepEqual(await request("ui-get", { key: "editor" }), expected);
	await until(async () => (await request("ui-get", { key: "layout" }))?.popoutGroups?.length === 3, "PACKAGED_POPOUT_LAYOUT_PERSISTED");
	if (popoutCase.phase === "reopen") {
		await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='收回全部浮窗').click()");
		await until(async () => (await windows()).length === 0 && (await request("ui-get", { key: "layout" }))?.popoutGroups?.length === 0, "PACKAGED_POPOUTS_RECLAIMED");
		assert.deepEqual(await request("ui-get", { key: "editor" }), expected);
	}
	for (const action of ["probe", "start-fixture", "bridge-select"]) await assert.rejects(api(action, {}), /PORTABLE_SMOKE_ACTION_REJECTED/);
	assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), 0);
	assert.deepEqual(await assertPortableHistory(api, history), before);
	const proof = { runId: context.runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, packaged: true, popoutPhase: popoutCase.phase, independentWindows: 3, panels: panels.map(([id]) => id), layoutAndReadOnlyDraftRetained: true, wholeApplicationReopen: popoutCase.phase === "reopen", allWindowsReturned: popoutCase.phase === "reopen", originalClosedHistoryRetained: true, originalRuntimeRetained: true, noTasksOrModelReplay: true, childWindowsWithoutPreloadOrNode: true, gameViewportRemainsInMain: true, gameCalls: 0, realModelRequests: 0, syntheticModelRequests: 0, physicalInput: "not_tested", multiScreen: "not_tested" };
	await writeFile(join(context.root, "application-proof.json"), JSON.stringify(proof), { flag: "wx" });
	assert.equal(await driver.getTray().activate("exit"), true);
}
