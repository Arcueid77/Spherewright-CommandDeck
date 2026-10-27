import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";

export const commandFixtureFiles = Object.freeze({
	"package.json": JSON.stringify({ name: "commanddeck-command-loss-fixture", private: true, scripts: { test: "node check.cjs" } }) + "\n",
	".gitignore": ".local/\n",
	"check.cjs": `const fs = require('node:fs');
const {spawn} = require('node:child_process');
fs.mkdirSync('.local', {recursive:true});
const counter = '.local/count';
fs.writeFileSync(counter, String((fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0) + 1));
const descendant = spawn(process.execPath, ['-e', "const fs=require('node:fs');setInterval(()=>fs.appendFileSync('.local/heartbeat','x'),50);setTimeout(()=>process.exit(2),30000)"], {stdio:'ignore', detached:true, windowsHide:true});
fs.writeFileSync('.local/started.json', JSON.stringify({pid:process.pid,descendantPid:descendant.pid}));
console.log('COMMAND_FIXTURE_STARTED');
const deadline=Date.now()+25000;
setInterval(()=>{if(fs.existsSync('.local/release')){console.log('COMMAND_FIXTURE_FINISHED');process.exit(0)}if(Date.now()>deadline)process.exit(2)},25);
`,
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalFile = "command-original.private.json";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function validateCommandWorkspace(context) {
	const directory = join(context.root, "command-workspace"), info = await lstat(directory);
	assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase());
	for (const [name, expected] of Object.entries(commandFixtureFiles)) {
		const file = join(directory, name), entry = await lstat(file);
		assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= 8192);
		assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase()); assert.equal(await readFile(file, "utf8"), expected);
	}
	return directory;
}

export async function runCommandFaultSmoke(driver) {
	const { scenario, resume } = driver.commandCase, workspace = await validateCommandWorkspace(driver.context);
	const unknownCase = scenario === "runtime" || scenario === "helper", inFlightExit = !resume && scenario === "exit";
	const request = (action, args = {}) => driver.api("workbench", { action, args });
	const evaluate = source => driver.testCommand("evaluate", { source });
	const count = async () => Number(await readFile(join(workspace, ".local/count"), "utf8"));
	async function until(predicate, label) { const deadline = performance.now() + 18000; while (!await predicate()) { if (performance.now() >= deadline) throw new Error("COMMAND_FAULT_TIMEOUT_" + label); await delay(50); } }
	async function ready() { await until(() => evaluate("Boolean(document.querySelector('header')?.getAttribute('aria-busy')==='false')"), "UI_READY"); }
	await ready();
	const registered = await driver.registerCommandWorkspace(), root = registered.roots[0];
	assert.equal(registered.roots.length, 1); assert.equal(root.path, workspace); assert.equal(root.canWrite, false); assert.equal(root.canExecute, true);
	assert.deepEqual((await request("checks", { rootId: root.id })).map(value => value.id), ["npm:test"]);
	for (const [action, args] of [["bridge-select", "external"], ["probe", { mode: "offline" }], ["game", { action: "start" }], ["profiles-manage", { action: "save" }], ["workbench", { action: "add", args: { path: workspace } }]]) await assert.rejects(driver.api(action, args), /PORTABLE_SMOKE_ACTION_REJECTED/);
	const runtimePid = driver.getRuntimePid(); let original, task, runtimeExitObserved = false, helperExitObserved = false;
	if (!resume) {
		assert.deepEqual(registered.tasks, []); assert.equal(registered.executionBlocked, false);
		const started = await evaluate("window.deck.workbench('check'," + JSON.stringify({ rootId: root.id, checkId: "npm:test" }) + ")");
		await until(async () => { task = await request("task", { taskId: started.id }); if (!["queued", "running"].includes(task.state)) throw new Error("COMMAND_FIXTURE_FAILED_" + task.error); return task.events.some(event => event.kind === "command-output" && event.value.text.includes("COMMAND_FIXTURE_STARTED")); }, "ACTUAL_COMMAND_STARTED");
		await until(async () => { try { return (await readFile(join(workspace, ".local/heartbeat"))).length >= 2; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }, "DESCENDANT_RUNNING");
		assert.equal(await count(), 1); assert.equal(task.invocations.length, 1); assert.equal(task.invocations[0].state, "prepared");
		const draft = { prompt: "command fault fixture draft", model: "" }, selection = { rootId: root.id, taskId: task.id };
		await request("ui-save", { key: "draft", value: draft }); await request("ui-save", { key: "selection", value: selection });
		original = { version: 1, kind: "synthetic-command-original", runId: driver.context.runId, scenario, task, draft, selection };
		original.sha256 = digest({ task, draft, selection });
		await writeFile(join(driver.context.root, originalFile), JSON.stringify(original), { flag: "wx" });
		await until(async () => { try { return await readFile(join(driver.context.root, "command-observed.release"), "utf8") === "owned command images observed\n"; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }, "EXTERNAL_COMMAND_OBSERVATION");
		if (scenario === "runtime") {
			const stopped = await driver.stopRuntimeForSmoke(); assert.equal(stopped.pid, runtimePid); assert.equal(stopped.exitObserved, true); runtimeExitObserved = true;
			await until(() => evaluate("(()=>{const panel=document.querySelector('.development-panel');return Boolean(panel?.textContent.includes('开发运行时已停止')&&['开始任务','停止任务','运行检查'].every(label=>[...panel.querySelectorAll('button')].some(button=>button.textContent===label&&button.disabled)))})()"), "RUNTIME_STOP_NOTICE");
			await assert.rejects(request("state"), /INVALID_WORKBENCH_ACTION|RUNTIME_UNAVAILABLE/);
		} else if (scenario === "helper") {
			const stopped = await driver.stopCommandHelperForSmoke(task.id); assert.equal(stopped.exitObserved, true); assert.ok(stopped.pid > 0); helperExitObserved = true;
			await until(async () => { task = await request("task", { taskId: task.id }); return task.state === "failed" && (await request("state")).activeTask === null; }, "HELPER_LOSS_RECORDED");
			assert.equal(task.error, "COMMAND_OUTCOME_UNKNOWN"); assert.equal(task.result.outcomeUnknown, true); assert.equal(task.invocations[0].state, "unknown"); assert.equal(task.invocations[0].result.created, true); assert.equal(task.invocations[0].result.started, true); assert.equal(task.invocations[0].result.receipt ?? null, null);
			await assert.rejects(driver.tryCommandGameAdmission(), /DEVELOPMENT_RUNTIME_BUSY/);
			await driver.testCommand("reload"); await ready(); assert.equal((await request("state")).executionBlocked, true); assert.deepEqual(await request("task", { taskId: task.id }), task); assert.equal(driver.getRuntimePid(), runtimePid);
		} else if (scenario === "exit") {
			// The caller writes this pre-exit proof and then enters the normal
			// supervisor shutdown. Only the external post-exit database/OS checks
			// prove cancellation, receipt storage and descendant exit.
			assert.equal((await request("state")).activeTask, task.id); assert.equal(task.state, "running");
		} else {
			assert.equal(scenario, "reload");
			await driver.testCommand("reload"); await ready(); assert.equal(driver.getRuntimePid(), runtimePid);
			const running = await request("task", { taskId: task.id }); assert.equal(running.id, task.id); assert.equal(running.state, "running"); assert.equal(running.invocations[0].id, task.invocations[0].id); assert.equal(await count(), 1);
			await writeFile(join(workspace, ".local/release"), "release fixed fixture\n", { flag: "wx" });
			await until(async () => { task = await request("task", { taskId: task.id }); return task.state === "succeeded" && (await request("state")).activeTask === null; }, "ORIGINAL_COMMAND_COMPLETED");
			assert.equal(task.invocations.length, 1); assert.equal(task.invocations[0].state, "completed"); assert.equal(task.invocations[0].result.exitCode, 0); assert.equal(task.invocations[0].result.treeConfirmed, true); assert.equal(task.invocations[0].result.streamsDrained, true);
		}
	} else {
		const path = join(driver.context.root, originalFile), info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 262144);
		original = JSON.parse(await readFile(path, "utf8")); assert.equal(original.version, 1); assert.equal(original.kind, "synthetic-command-original"); assert.equal(original.runId, driver.context.runId); assert.equal(original.scenario, scenario); assert.equal(original.sha256, digest({ task: original.task, draft: original.draft, selection: original.selection }));
		assert.equal(registered.tasks.length, 1); assert.equal(registered.activeTask, null); assert.equal(registered.executionBlocked, unknownCase);
		task = await request("task", { taskId: original.task.id });
		assert.equal(task.id, original.task.id); assert.deepEqual(task.scope, original.task.scope); assert.equal(task.invocations.length, 1); assert.equal(task.invocations[0].id, original.task.invocations[0].id); assert.deepEqual(task.invocations[0].arguments, original.task.invocations[0].arguments);
		assert.deepEqual(task.events.slice(0, original.task.events.length), original.task.events);
		if (unknownCase) {
			if (scenario === "runtime") { assert.equal(task.state, "interrupted"); assert.equal(task.error, "RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY"); assert.equal(task.invocations[0].error, "RUNTIME_INTERRUPTED"); assert.equal(task.invocations[0].result, null); }
			else { assert.equal(task.state, "failed"); assert.equal(task.error, "COMMAND_OUTCOME_UNKNOWN"); assert.equal(task.invocations[0].error, "COMMAND_OUTCOME_UNKNOWN"); assert.equal(task.invocations[0].result.created, true); assert.equal(task.invocations[0].result.started, true); assert.equal(task.invocations[0].result.receipt ?? null, null); }
			assert.equal(task.invocations[0].state, "unknown");
			await assert.rejects(driver.tryCommandGameAdmission(), /DEVELOPMENT_RUNTIME_BUSY/);
			await assert.rejects(request("ui-save", { key: "execution-blocked", value: null }), /INVALID_UI_STATE_KEY/);
			await assert.rejects(request("agent", { rootId: root.id }), /PORTABLE_SMOKE_ACTION_REJECTED/);
			const refused = await evaluate("window.deck.workbench('check'," + JSON.stringify({ rootId: root.id, checkId: "npm:test" }) + ")");
			await until(async () => { const current = await request("task", { taskId: refused.id }); return current.state === "failed" && (await request("state")).activeTask === null; }, "EXPLICIT_RETRY_REFUSED");
			const refusal = await request("task", { taskId: refused.id }); assert.equal(refusal.error, "DEVELOPMENT_EXECUTION_BLOCKED"); assert.deepEqual(refusal.invocations, []); assert.equal(await count(), 1);
		} else if (scenario === "exit") { assert.equal(task.state, "cancelled"); assert.equal(task.invocations[0].state, "failed"); assert.equal(task.invocations[0].result.reason, "cancelled"); assert.equal(task.invocations[0].result.treeConfirmed, true); assert.equal(task.invocations[0].result.streamsDrained, true); }
		else { assert.equal(task.state, "succeeded"); assert.equal(task.invocations[0].state, "completed"); assert.equal(task.invocations[0].result.exitCode, 0); }
		await driver.testCommand("reload"); await ready(); assert.deepEqual(await request("task", { taskId: task.id }), task); assert.equal((await request("state")).executionBlocked, unknownCase); assert.equal(driver.getRuntimePid(), runtimePid);
	}
	if (!runtimeExitObserved) assert.deepEqual(await request("ui-get", { key: "draft" }), original.draft);
	assert.equal(await count(), 1); assert.equal(driver.getProbeSequence(), 0); assert.equal(driver.getBridgeClient(), undefined);
	// This only checks the fixed heartbeat. The external controller independently
	// inspects the owned image scopes after exit; neither check clears unknown.
	let stable = false;
	if (!inFlightExit) {
		for (let attempt = 0; attempt < 12; attempt++) { const before = (await readFile(join(workspace, ".local/heartbeat"))).length; await delay(150); if ((await readFile(join(workspace, ".local/heartbeat"))).length === before) { stable = true; break; } }
		assert.equal(stable, true, "COMMAND_DESCENDANT_HEARTBEAT_CONTINUES");
	}
	const proof = { runId: driver.context.runId, commandScenario: scenario, phase: resume ? "resume" : "fault", actualWorkbenchCommand: true, realDeveloperToolchainRequired: true, runtimeExitObserved, helperExitObserved, normalExitWhileCommandRunning: inFlightExit, uiReloadRetainsOriginalTask: scenario !== "exit" || resume, originalRecordSha256: original.sha256, originalInvocationRetained: true, originalCounter: 1, unknownRemainsBlocked: unknownCase && (resume || scenario === "helper"), explicitRetryRefusedBeforeInvocation: resume && unknownCase, noAutomaticReplay: true, stoppedHeartbeatObserved: stable, noProbeAllocated: true, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false, fullRecoveryMatrixVerified: false };
	return proof;
}
