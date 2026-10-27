import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devNull } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function runWorkbenchSmoke(driver) {
	const originalTray = driver.getTray(); assert.ok(originalTray);
	const journalId = (await driver.api("journal", { action: "start" })).activeId;
	const base = join(driver.root, ".local", "m1-smoke", driver.runId), source = join(base, "source");
	await mkdir(source, { recursive: true });
	const git = (...args) => execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "user.name=CommandDeck fixture", "-c", "user.email=fixture@invalid.example", ...args], { cwd: source, windowsHide: true, stdio: "pipe" });
	git("init", "-q");
	await writeFile(join(source, "code.mjs"), "export const value = 1;\n");
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "commanddeck-desktop-fixture", private: true, scripts: { test: "node check.cjs" } }));
	await writeFile(join(source, "check.cjs"), "console.log('CHECK_STARTED');setTimeout(()=>{require('node:fs').appendFileSync('count.txt','x');console.log('CHECK_RAN')},2500)\n");
	git("add", "."); git("commit", "-qm", "fixture baseline");
	const request = (action, args = {}) => driver.api("workbench", { action, args });
	const evaluate = (source) => driver.testCommand("evaluate", { source });
	await request("add", { path: source, label: "M1 fixture", canWrite: true, canExecute: true });
	const root = (await request("state")).roots[0];
	const initial = await request("read", { rootId: root.id, path: "code.mjs" });
	const edit = await evaluate(`window.deck.workbench('save',${JSON.stringify({ rootId: root.id, path: "code.mjs", expectedSha256: initial.sha256, content: "export const value = 2;\n" })})`);
	async function settled(id) { const deadline = Date.now() + 20000; while (true) { const task = await request("task", { taskId: id }); if (!["queued", "running", "cancelling"].includes(task.state) && (await request("state")).activeTask !== id) return task; if (Date.now() > deadline) throw new Error("M1_TASK_TIMEOUT"); await delay(50); } }
	assert.equal((await settled(edit.id)).state, "succeeded");
	const current = await request("read", { rootId: root.id, path: "code.mjs" });
	const check = await evaluate(`window.deck.workbench('check',${JSON.stringify({ rootId: root.id, checkId: "npm:test" })})`);
	const deadline = Date.now() + 15000;
	while (true) {
		const snapshot = await request("task", { taskId: check.id });
		if (snapshot.events.some((event) => event.kind === "command-output" && event.value.text.includes("CHECK_STARTED"))) break;
		if (!["queued", "running", "cancelling"].includes(snapshot.state)) throw new Error("M1_CHECK_START_FAILED " + JSON.stringify(snapshot.invocations));
		assert.ok(Date.now() < deadline); await delay(50);
	}
	await request("ui-save", { key: "draft", value: { prompt: "M1 draft survives reload", model: "" } });
	await request("ui-save", { key: "editor", value: { rootId: root.id, path: "code.mjs", sha256: current.sha256, text: current.fullText, diskText: current.fullText } });
	await request("ui-save", { key: "selection", value: { rootId: root.id, taskId: check.id } });
	const runtimePid = driver.getRuntimePid();
	await driver.testCommand("reload");
	const task = await settled(check.id);
	assert.equal(task.state, "succeeded", task.error);
	assert.equal(task.invocations.length, 1);
	assert.equal(task.invocations[0].result.exitCode, 0);
	assert.equal(driver.getRuntimePid(), runtimePid);
	assert.equal(await readFile(join(source, "count.txt"), "utf8"), "x");
	// This profile and endpoint are synthetic; no real credentials or external model are used.
	const syntheticKey = "!synthetic-desktop-" + randomUUID(), providerId = "deckvault-" + randomUUID();
	let releaseResponse, receivedAuthorization = false;
	const endpoint = createServer(async (request, response) => {
		for await (const _chunk of request) {}
		receivedAuthorization = request.headers.authorization === "Bearer " + syntheticKey;
		await new Promise((done) => { releaseResponse = done; });
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ delta: { role: "assistant", content: "fixture echo: " + syntheticKey.slice(0, 11) } }, { delta: { content: syntheticKey.slice(11) } }, { delta: {}, finish_reason: "stop" }]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((done) => endpoint.listen(0, "127.0.0.1", done));
	try {
		const empty = await driver.api("profiles-manage", { action: "list" }); assert.equal(empty.profiles.length, 0); assert.equal(empty.available, true);
		const config = { id: providerId, label: "Desktop fixture", api: "openai-completions", baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, modelId: "fixture", contextWindow: 8192, maxTokens: 2048, apiKey: syntheticKey, expectedRevision: empty.revision };
		const saved = await evaluate(`window.deck.manageProfiles('save',${JSON.stringify(config)})`);
		assert.ok(!JSON.stringify(saved).includes(syntheticKey));
		const described = await evaluate(`window.deck.manageProfiles('describe',{id:${JSON.stringify(providerId)}})`);
		assert.equal(described.credentialPresent, true); assert.ok(!JSON.stringify(described).includes(syntheticKey));
		const denied = await evaluate("window.deck.manageProfiles('resolve',{}).then(()=>false,()=>true)"); assert.equal(denied, true);
		const agent = await evaluate(`window.deck.workbench('agent',${JSON.stringify({ rootId: root.id, prompt: "Reply briefly. Do not use tools.", providerId, modelId: "fixture" })})`);
		const requestedBy = Date.now() + 10000;
		while (!releaseResponse) { const active = await request("task", { taskId: agent.id }); assert.equal(active.state, "running", active.error); assert.ok(Date.now() < requestedBy, "PROTECTED_MODEL_REQUEST_TIMEOUT"); await delay(30); }
		assert.equal(await evaluate(`window.deck.manageProfiles('remove',${JSON.stringify({ id: providerId, expectedRevision: saved.revision })}).then(()=>false,()=>true)`), true);
		releaseResponse();
		const completed = await settled(agent.id); assert.equal(completed.state, "succeeded", completed.error); assert.equal(completed.response, "fixture echo: [redacted]"); assert.equal(receivedAuthorization, true);
		assert.ok(!JSON.stringify(completed).includes(syntheticKey));
		await evaluate(`window.deck.manageProfiles('remove',${JSON.stringify({ id: providerId, expectedRevision: saved.revision })})`);
		assert.equal((await driver.api("profiles-manage", { action: "list" })).profiles.length, 0);
	} finally { releaseResponse?.(); endpoint.closeAllConnections(); endpoint.close(); }
	let rendered;
	const renderDeadline = Date.now() + 8000;
	do {
		rendered = await evaluate("({draft:document.querySelector('[aria-label=开发任务]')?.value,editor:document.querySelector('[aria-label=代码编辑器]')?.value,nodeExposed:typeof require!=='undefined',groups:document.querySelectorAll('.dv-groupview').length})");
		if (rendered.draft === "M1 draft survives reload" && rendered.editor?.includes("value = 2")) break;
		assert.ok(Date.now() < renderDeadline, "M1_UI_STATE_NOT_RESTORED"); await delay(100);
	} while (true);
	assert.equal(rendered.nodeExposed, false);
	assert.ok(rendered.groups >= 4);
	await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='模型设置').click()");
	const settingsDeadline = Date.now() + 5000;
	while (!(await evaluate("Boolean(document.querySelector('[role=dialog]')?.textContent.includes('添加模型服务'))"))) { assert.ok(Date.now() < settingsDeadline, "PROVIDER_SETTINGS_NOT_RENDERED"); await delay(50); }
	assert.deepEqual(await evaluate("({workspaceInert:document.querySelector('.workspace').inert,overlay:document.body.dataset.deckOverlay,focusInside:document.querySelector('[role=dialog]').contains(document.activeElement),passwordAbsent:!document.querySelector('input[type=password]')})"), { workspaceInert: true, overlay: "settings", focusInside: true, passwordAbsent: true });
	await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
	await delay(50);
	assert.equal(await evaluate("Boolean(document.querySelector('[role=dialog]'))"), false);
	const denied = await evaluate("(async()=>{let blocked=0;for(const action of ['initialize','close-store','add','configuration-begin','configuration-end']){try{await window.deck.workbench(action,{})}catch{blocked++}}return blocked})()");
	assert.equal(denied, 5);
	const capture = await driver.testCommand("capture-workbench");
	await driver.testCommand("reload");
	assert.equal((await request("task", { taskId: check.id })).state, "succeeded");
	assert.equal(await readFile(join(source, "count.txt"), "utf8"), "x");
	const recovered = once(driver.events, "recovered"), previousUi = driver.getUi().epoch;
	driver.beginUiHang();
	let timer;
	try { await Promise.race([recovered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("M1_UI_REPLACEMENT_TIMEOUT")), 15000); })]); } finally { clearTimeout(timer); }
	assert.equal(driver.getUi().epoch, previousUi + 1);
	assert.equal(driver.getRuntimePid(), runtimePid);
	assert.equal(driver.getTray(), originalTray); assert.equal(originalTray.nativeTray.isDestroyed(), false);
	const hydrationDeadline = Date.now() + 8000;
	while ((await evaluate("document.querySelector('[aria-label=开发任务]')?.value")) !== "M1 draft survives reload") { assert.ok(Date.now() < hydrationDeadline, "M1_REPLACEMENT_HYDRATION_FAILED"); await delay(100); }
	assert.equal((await request("task", { taskId: check.id })).state, "succeeded");
	assert.equal(await readFile(join(source, "count.txt"), "utf8"), "x");
	// Exercise immutable task history through the real renderer, after the source was committed.
	git("add", "--", "code.mjs"); git("commit", "-qm", "fixture edit committed");
	assert.equal((await request("diff", { rootId: root.id, path: "code.mjs" })).text, "");
	const originalTask = await request("task", { taskId: edit.id }), changeId = originalTask.changes[0].id;
	const originalDiff = await request("change-diff", { taskId: edit.id, changeId });
	const lab = join(base, "lab"); await mkdir(lab);
	const labGit = (...args) => execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "user.name=CommandDeck fixture", "-c", "user.email=fixture@invalid.example", ...args], { cwd: lab, windowsHide: true, stdio: "pipe" });
	labGit("init", "-q"); await writeFile(join(lab, "acceptance.md"), "FIXED_LAB_EVIDENCE\n"); labGit("add", "--", "acceptance.md"); labGit("commit", "-qm", "fixture Lab baseline");
	await request("add", { path: lab, label: "M4 Lab fixture", canWrite: false, canExecute: false });
	const labRoot = (await request("state")).roots.find(value => value.label === "M4 Lab fixture");
	const reference = await evaluate(`window.deck.workbench('attach-reference',${JSON.stringify({ taskId: edit.id, rootId: labRoot.id, path: "acceptance.md", revision: labRoot.metadata.sha, label: "M4 fixed acceptance" })})`);
	await writeFile(join(lab, "acceptance.md"), "LATER_LAB_CONTENT\n"); labGit("add", "--", "acceptance.md"); labGit("commit", "-qm", "later fixture Lab content");
	const draftText = current.fullText + "// M4 unsaved draft\n";
	await request("ui-save", { key: "editor", value: { rootId: root.id, path: "code.mjs", sha256: current.sha256, text: draftText, diskText: current.fullText } });
	await driver.testCommand("reload");
	async function untilUi(predicate, label) { const by = Date.now() + 10000; while (!await predicate()) { assert.ok(Date.now() < by, label); await delay(60); } }
	await untilUi(async () => await evaluate("document.querySelector('[aria-label=代码编辑器]')?.value") === draftText, "M4_DRAFT_HYDRATION");
	async function showTask(taskId) {
		await untilUi(async () => await evaluate("[...document.querySelectorAll('.dv-tab')].some(tab=>tab.textContent.trim()==='任务记录')"), "M4_TASK_TAB");
		await evaluate("[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()==='任务记录').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))");
		await untilUi(async () => await evaluate(`[...document.querySelectorAll('.task-row')].some(row=>row.textContent.includes(${JSON.stringify(taskId.slice(0, 8))}))`), "M4_TASK_ROW");
		await evaluate(`[...document.querySelectorAll('.task-row')].find(row=>row.textContent.includes(${JSON.stringify(taskId.slice(0, 8))})).click()`);
	}
	await showTask(edit.id);
	await untilUi(async () => await evaluate("[...document.querySelectorAll('.output-panel button')].some(button=>button.textContent==='打开原始差异')"), "M4_HISTORY_BUTTON");
	await evaluate("[...document.querySelectorAll('.output-panel button')].find(button=>button.textContent==='打开原始差异').click()");
	await untilUi(async () => await evaluate("document.querySelector('[aria-label=原始任务差异]')?.textContent") === originalDiff.text, "M4_ORIGINAL_DIFF");
	assert.equal((await request("ui-get", { key: "editor" })).text, draftText);
	await untilUi(async () => await evaluate("[...document.querySelectorAll('.output-panel button')].some(button=>button.textContent.includes('M4 fixed acceptance'))"), "M4_REFERENCE_BUTTON");
	await evaluate("[...document.querySelectorAll('.output-panel button')].find(button=>button.textContent.includes('M4 fixed acceptance')).click()");
	await untilUi(async () => await evaluate("document.querySelector('[aria-label=固定版本记录]')?.textContent") === "FIXED_LAB_EVIDENCE\n", "M4_FIXED_REFERENCE");
	assert.equal((await request("task", { taskId: edit.id })).references[0].id, reference.id);
	await driver.testCommand("reload"); await showTask(edit.id);
	await untilUi(async () => await evaluate("[...document.querySelectorAll('.output-panel button')].some(button=>button.textContent.includes('M4 fixed acceptance'))"), "M4_REFERENCE_AFTER_RELOAD");
	await evaluate("[...document.querySelectorAll('.output-panel button')].find(button=>button.textContent.includes('M4 fixed acceptance')).click()");
	await untilUi(async () => await evaluate("document.querySelector('[aria-label=固定版本记录]')?.textContent") === "FIXED_LAB_EVIDENCE\n", "M4_PIN_AFTER_RELOAD");
	await evaluate("[...document.querySelectorAll('.history-view button')].find(button=>button.textContent==='返回当前文件').click()");
	await untilUi(async () => await evaluate("document.querySelector('[aria-label=代码编辑器]')?.value") === draftText, "M4_RETURN_DRAFT");
	await showTask(check.id);
	await untilUi(async () => await evaluate("document.querySelector('.output-panel')?.textContent.includes('CHECK_RAN')"), "M4_CHECK_LOG_NAVIGATION");
	assert.equal(await readFile(join(source, "count.txt"), "utf8"), "x");
	assert.equal((await request("task", { taskId: check.id })).invocations.length, 1);
	const native = await driver.api("status");
	assert.equal(native.attached, false);
	const proof = { runId: driver.runId, edited: true, checkExitCode: 0, checkStarts: 1, uiReloadDuringCheck: true, uiProcessReplaced: true, replacementHydrated: true, sameRuntime: true, draftRestored: true, editorRestored: true, historicalResultRestored: true, ipcWhitelistRejectsControlActions: true, protectedProfileRoundtrip: true, rendererCannotResolveCredential: true, profileMutationBlockedDuringTask: true, splitEchoRedacted: true, providerSettingsRenderAndDismiss: true, syntheticCredentialOnly: true, externalModelRequests: 0, noNodeInRenderer: true, visualCapture: capture.captured ? "captured" : "unavailable", gameCalls: 0, realDsp: "not_attached", physicalInput: "not_tested" };
	Object.assign(proof, { originalDiffAfterCommit: true, crossRepositoryReference: true, referencePinsOldCommit: true, referenceSurvivesReload: true, historyPreservesUnsavedDraft: true, taskClickNavigatesToLog: true, navigationDoesNotRepeatCommand: true });
	proof.supervisorTrayRetainedAcrossUiReplacement = true;
	await driver.api("journal", { action: "stop", args: { id: journalId } });
	const journal = await driver.api("journal", { action: "read", args: { id: journalId } });
	assert.ok(journal.events.some(event => event.domain === "development" && event.facts.state === "running"));
	assert.ok(journal.events.some(event => event.domain === "development" && event.facts.state === "succeeded"));
	assert.ok(!JSON.stringify(journal).includes(syntheticKey)); assert.ok(!JSON.stringify(journal).includes(JSON.stringify(source).slice(1, -1)));
	proof.developmentJournalPreservesStagesWithoutPrivateContent = true;
	await writeFile(join(driver.root, ".local/desktop-smoke-workbench.json"), JSON.stringify(proof, null, 2));
}
