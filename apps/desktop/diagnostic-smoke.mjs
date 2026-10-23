import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";

export async function runDiagnosticSmoke(driver) {
	const { api, testCommand, getRuntimePid, getProbeSequence, getBridgeClient, context } = driver;
	const evaluate = source => testCommand("evaluate", { source });
	async function until(source, code) {
		const deadline = performance.now() + 10000;
		while (!await evaluate(source)) { if (performance.now() >= deadline) throw new Error(code); await new Promise(resolve => setTimeout(resolve, 40)); }
	}
	async function click(text) {
		assert.equal(await evaluate("(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent===" + JSON.stringify(text) + ");if(!button||button.disabled)return false;button.click();return true})()"), true, "DIAGNOSTIC_BUTTON_UNAVAILABLE");
	}
	const stateSelector = "document.querySelector('[data-diagnostic-state]')?.dataset.diagnosticState";
	async function generate() { await click("生成预览"); await until(stateSelector + "==='preview'", "DIAGNOSTIC_PREVIEW_NOT_READY"); return evaluate("document.querySelector('pre[aria-label=\"诊断报告完整预览\"]').textContent"); }
	const runtimePid = getRuntimePid(), probeSequence = getProbeSequence(), destination = join(context.root, "diagnostic-export.json");
	const initialWork = await api("workbench", { action: "state" }), initialGame = await api("game", { action: "snapshot" });
	assert.deepEqual(initialWork.roots, []); assert.deepEqual(initialWork.tasks, []); assert.deepEqual(initialGame.tasks, []); assert.deepEqual(initialGame.unresolved, []);
	assert.equal((await api("bridge", { action: "snapshot" })).selected, null); assert.equal(getBridgeClient(), undefined);
	await assert.rejects(api("diagnostics-preview", { options: {}, generation: 1 }), /TRUSTED_DIAGNOSTIC_HOST_REQUIRED/);
	await testCommand("show-ui");
	await until("document.querySelector('header')?.getAttribute('aria-busy')==='false'", "DIAGNOSTIC_LAYOUT_NOT_READY");
	assert.equal(await evaluate("typeof require==='undefined'&&typeof window.deck.diagnosticPreview==='function'"), true);
	await click("诊断报告");
	await until("document.body.dataset.deckOverlay==='diagnostics'&&document.querySelector('header').inert&&document.querySelector('.workspace').inert", "DIAGNOSTIC_OVERLAY_NOT_READY");
	const previewText = await generate(), report = JSON.parse(previewText);
	assert.equal(report.kind, "spherewright-commanddeck-diagnostic"); assert.equal(report.version, 1);
	assert.equal(report.workbench.state, "available"); assert.equal(report.workbench.taskCount, 0); assert.equal(report.game.pendingCount, 0);
	assert.equal(report.runtime.available, true); assert.equal(report.build.installationVerified, false); assert.equal(report.bridge.connected, false);
	for (const value of [context.root, process.env.COMMANDDECK_PI_CONFIG_DIR]) if (value) assert.ok(!previewText.includes(value));
	for (const field of ["apiKey", "sessionId", "actionId", "idempotencyKey", "saveName", "prompt", "response", "arguments", "stdout", "sessionFile"]) assert.ok(!Object.hasOwn(report, field) && !previewText.includes('"' + field + '":'));
	await testCommand("answer-diagnostic-save", { cancelled: true }); await click("保存这份预览");
	await until(stateSelector + "==='preview'&&document.querySelector('.diagnostic-dialog [role=status]').textContent.includes('已取消保存')", "DIAGNOSTIC_CANCEL_NOT_RETAINED");
	await assert.rejects(lstat(destination), { code: "ENOENT" });
	assert.equal(await evaluate("document.querySelector('pre[aria-label=\"诊断报告完整预览\"]').textContent"), previewText);
	await testCommand("answer-diagnostic-save", { cancelled: false, fileName: "diagnostic-export.json" }); await click("保存这份预览");
	await until(stateSelector + "==='saved'", "DIAGNOSTIC_SAVE_NOT_CONFIRMED");
	const saved = await readFile(destination); assert.equal(saved.toString(), previewText);
	const sha256 = createHash("sha256").update(saved).digest("hex");
	await generate(); await testCommand("answer-diagnostic-save", { cancelled: false, fileName: "diagnostic-export.json" }); await click("保存这份预览");
	await until(stateSelector + "==='error'&&document.querySelector('.diagnostic-dialog [role=status]').textContent.includes('该文件已存在')", "DIAGNOSTIC_EXISTING_FILE_NOT_REFUSED");
	assert.deepEqual(await readFile(destination), saved);
	await generate();
	assert.equal(await evaluate("(()=>{document.querySelector('.diagnostic-options input').click();return true})()"), true);
	await until(stateSelector + "==='empty'&&!document.querySelector('pre[aria-label=\"诊断报告完整预览\"]')", "DIAGNOSTIC_OPTION_CHANGE_RETAINED_STALE_PREVIEW");
	const reduced = JSON.parse(await generate()); assert.equal(reduced.workbench.state, "omitted"); assert.equal(reduced.game.state, "omitted");
	await click("关闭");
	await until("!document.body.dataset.deckOverlay&&!document.querySelector('header').inert", "DIAGNOSTIC_OVERLAY_NOT_CLOSED");
	const oldPreview = await evaluate("window.deck.diagnosticPreview({includeTasks:true,includePerformance:false})");
	await testCommand("reload");
	await until("document.querySelector('header')?.getAttribute('aria-busy')==='false'", "DIAGNOSTIC_RELOAD_NOT_READY");
	const stale = await evaluate("(async()=>{try{await window.deck.saveDiagnosticPreview(" + JSON.stringify(oldPreview.id) + ");return false}catch(error){return String(error).includes('DIAGNOSTIC_PREVIEW_REQUIRED')}})()");
	assert.equal(stale, true); assert.deepEqual(await readFile(destination), saved);
	await click("诊断报告"); const afterReload = JSON.parse(await generate()); assert.equal(afterReload.runtime.available, true);
	await click("关闭");
	const rejected = await evaluate("(async()=>{let count=0;for(const call of [()=>window.deck.probe({mode:'live'}),()=>window.deck.probe({mode:'offline'}),()=>window.deck.game('start',{}),()=>window.deck.workbench('check',{}),()=>window.deck.bridge('refresh'),()=>window.deck.manageProfiles('save',{})])try{await call()}catch{count++}return count})()");
	assert.equal(rejected, 6); assert.equal(getRuntimePid(), runtimePid); assert.equal(getProbeSequence(), probeSequence); assert.equal(getBridgeClient(), undefined);
	const finalWork = await api("workbench", { action: "state" }), finalGame = await api("game", { action: "snapshot" });
	assert.deepEqual(finalWork.roots, initialWork.roots); assert.deepEqual(finalWork.tasks, initialWork.tasks); assert.deepEqual(finalGame.tasks, initialGame.tasks); assert.deepEqual(finalGame.unresolved, initialGame.unresolved);
	const stopped = await driver.stopRuntimeForSmoke(); assert.equal(stopped.exitObserved, true);
	await click("诊断报告"); const unavailable = JSON.parse(await generate()); assert.equal(unavailable.runtime.available, false); assert.equal(unavailable.runtime.exitObserved, true); assert.equal(unavailable.workbench.state, "unavailable"); assert.equal(unavailable.workbench.code, "RUNTIME_UNAVAILABLE"); await click("关闭");
	assert.equal(getProbeSequence(), probeSequence); assert.equal(getBridgeClient(), undefined); assert.deepEqual(await readFile(destination), saved);
	const proof = { runId: context.runId, reportVersion: 1, previewBytes: saved.length, previewSha256: sha256, previewMatchesSavedBytes: true, cancelledPickerWritesNothing: true, existingDestinationPreserved: true, changedOptionsDiscardPreview: true, reloadInvalidatesPreview: true, newPreviewAfterReload: true, diagnosticAfterRuntimeExit: true, runtimeExitObserved: true, rendererNodeDisabled: true, runtimeRetainedUntilControlledExit: true, noProbeAllocated: true, noMcpAllocated: true, noTaskCreatedOrReplayed: true, modelAndGameActionsRejected: true, nativeSavePickerResponseMocked: true, physicalInputVerified: false, realGameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false };
	await writeFile(join(context.root, "diagnostic-application-proof.private.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
	return proof;
}
