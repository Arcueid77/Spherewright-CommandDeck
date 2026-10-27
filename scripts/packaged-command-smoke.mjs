import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { dirname, basename, join, resolve, delimiter } from "node:path";
import { tmpdir, devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { bundleExecutable, copyBundleTree, verifyBundle, inventoryBundle } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { commandFixtureFiles } from "../apps/desktop/command-fault-smoke.mjs";
import { portableCommandScenarios } from "../apps/desktop/portable-mode.mjs";
import { copyCommandToolchain } from "./command-toolchain-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_COMMAND_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
assert.equal(manifest.portableCommandFaults, 1, "PACKAGED_COMMAND_MODE_UNSUPPORTED_REBUILD_REQUIRED"); assert.equal(manifest.nativeCommandProcessObserver, 1);
const proofRoot = join(root, ".local/packaged-command", runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(directory); return directory; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle"), toolchain = join(copyRoot, "trusted-toolchain");
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, copyRoot, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	// Developer checks use an explicit real Node/npm and Git installation. They
	// are outside the approved workspace; this is not an SDK-free acceptance.
	const originalNode = await realpath(process.execPath), originalNpm = await realpath(join(dirname(originalNode), "node_modules/npm"));
	await mkdir(toolchain); await copyBundleTree(originalNode, join(toolchain, "node.exe")); await mkdir(join(toolchain, "node_modules")); await copyCommandToolchain(originalNpm, join(toolchain, "node_modules/npm"));
	const gitExe = execFileSync(join(process.env.SystemRoot, "System32/where.exe"), ["git.exe"], { windowsHide: true, encoding: "utf8" }).trim().split(/\r?\n/)[0]; assert.ok((await lstat(gitExe)).isFile());
	const toolchainBefore = await inventoryBundle(toolchain), nodeSha256 = createHash("sha256").update(await readFile(originalNode)).digest("hex");
	for (const scenario of portableCommandScenarios) {
		const directory = await temporary(), caseId = randomUUID(), evidence = join(proofRoot, scenario), workspace = join(directory, "command-workspace"); await mkdir(evidence); await mkdir(workspace);
		await writeFile(join(evidence, "context.private.json"), JSON.stringify({ runId, caseId, scenario, directory, copy, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
		for (const [name, text] of Object.entries(commandFixtureFiles)) await writeFile(join(workspace, name), text, { flag: "wx" });
		const emptyConfig = join(directory, "empty-config"); await writeFile(emptyConfig, "", { flag: "wx" });
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|NPM_|GIT_|PSModulePath$|PATH$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		const env = { ...inherited, PATH: [toolchain, dirname(gitExe), join(process.env.SystemRoot, "System32")].join(delimiter), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId, NPM_CONFIG_USERCONFIG: emptyConfig, NPM_CONFIG_GLOBALCONFIG: join(directory, "empty-global-npm-config"), NPM_CONFIG_CACHE: join(directory, "npm-cache"), NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false", GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
		await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "", { flag: "wx" });
		const git = (...values) => execFileSync(gitExe, ["-c", "core.hooksPath=" + devNull, "-c", "user.name=CommandDeck fixture", "-c", "user.email=fixture@invalid.example", ...values], { cwd: workspace, env, windowsHide: true, stdio: "pipe" });
		git("init", "-q"); git("add", "--", ...Object.keys(commandFixtureFiles)); git("commit", "-qm", "fixed command fixture");
		const phases = []; let originalBytes, heartbeatAfterFault;
		for (const resume of [false, true]) {
			const phase = resume ? "resume" : "fault", child = spawn(join(copy, bundleExecutable), ["--portable-smoke", "--portable-command-loss=" + scenario, ...(resume ? ["--portable-command-resume"] : [])], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
			const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000); let code, signal;
			const exited = once(child, "exit"); let observationError;
			try {
				if (!resume) {
					const deadline = performance.now() + 40000; let started;
					while (!started) {
						assert.ok(child.exitCode === null && child.signalCode === null, "COMMAND_APPLICATION_EXITED_BEFORE_OBSERVATION"); assert.ok(performance.now() < deadline, "COMMAND_START_OBSERVATION_TIMEOUT");
						try { await readFile(join(directory, "command-original.private.json")); started = JSON.parse(await readFile(join(workspace, ".local/started.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
						if (!started) await new Promise(resolve => setTimeout(resolve, 50));
					}
					const live = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env, includeNode: true });
					for (const pid of [started.pid, started.descendantPid]) assert.ok(live.members.some(member => member.pid === pid && member.rootIndex === 1 && member.relativeImage === "trusted-toolchain/node.exe"), "OWNED_COMMAND_NODE_NOT_OBSERVED");
					assert.ok(live.members.some(member => member.rootIndex === 0 && member.relativeImage.endsWith("/CommandDeck.CommandHost.exe")), "OWNED_COMMAND_HOST_NOT_OBSERVED");
					await writeFile(join(evidence, "running-command-observation.private.json"), JSON.stringify(live), { flag: "wx" });
					await writeFile(join(directory, "command-observed.release"), "owned command images observed\n", { flag: "wx" });
				}
				[code, signal] = await exited;
			} catch (error) { observationError = error; [code, signal] = await exited; }
			finally { clearTimeout(timer); }
			await writeFile(join(evidence, phase + "-exit.private.json"), JSON.stringify({ code, signal, timedOut, output, observationError: observationError?.message }), { flag: "wx" });
			let remaining; const deadline = performance.now() + 25000;
			do {
				const budget = Math.floor(deadline - performance.now()); if (budget <= 0) break;
				const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env, timeoutMs: Math.min(20000, budget), includeNode: true });
				await writeFile(join(evidence, phase + "-process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
				if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
			} while (performance.now() < deadline);
			assert.equal(remaining, 0); if (observationError) throw observationError; assert.equal(timedOut, false); assert.equal(code, 0, "COMMAND_APPLICATION_" + phase.toUpperCase() + "_FAILED");
			const proofBytes = await readFile(join(directory, "command-" + phase + "-application.json")), proof = JSON.parse(proofBytes);
			assert.equal(proof.runId, caseId); assert.equal(proof.commandScenario, scenario); assert.equal(proof.phase, phase); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit);
			for (const key of ["packaged", "visibleRenderer", "rendererNodeDisabled", "actualWorkbenchCommand", "realDeveloperToolchainRequired", "originalInvocationRetained", "noAutomaticReplay", "stoppedHeartbeatObserved", "noProbeAllocated"]) assert.equal(proof[key], true, key);
			assert.equal(proof.originalCounter, 1); assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0); assert.equal(proof.runtimeExitObserved, !resume && scenario === "runtime"); assert.equal(proof.unknownRemainsBlocked, resume && scenario === "runtime");
			await writeFile(join(evidence, phase + "-application-proof.json"), proofBytes, { flag: "wx" }); phases.push(proof);
			assert.equal(await readFile(join(workspace, ".local/count"), "utf8"), "1");
			const heartbeat = await readFile(join(workspace, ".local/heartbeat"));
			if (!resume) { heartbeatAfterFault = heartbeat; originalBytes = await readFile(join(directory, "command-original.private.json")); await writeFile(join(evidence, "original.private.json"), originalBytes, { flag: "wx" }); }
			else { assert.deepEqual(heartbeat, heartbeatAfterFault); assert.deepEqual(await readFile(join(directory, "command-original.private.json")), originalBytes); }
			const original = JSON.parse(originalBytes), db = new DatabaseSync(join(directory, "supervisor-profile/supervisor", "m1-smoke-" + caseId, "workbench.sqlite"), { readOnly: true });
			try {
				const tasks = db.prepare("SELECT id,state,scope,error FROM tasks").all(), originalTask = tasks.find(task => task.id === original.task.id); assert.equal(tasks.length, resume && scenario === "runtime" ? 2 : 1); assert.ok(originalTask); assert.deepEqual(JSON.parse(originalTask.scope), original.task.scope);
				assert.equal(originalTask.state, scenario === "reload" ? "succeeded" : resume ? "interrupted" : "running");
				if (tasks.length === 2) { const refusal = tasks.find(task => task.id !== originalTask.id); assert.equal(refusal.state, "failed"); assert.equal(refusal.error, "DEVELOPMENT_EXECUTION_BLOCKED"); }
				const invocations = db.prepare("SELECT * FROM invocations").all(); assert.equal(invocations.length, 1); assert.equal(invocations[0].id, original.task.invocations[0].id); assert.equal(invocations[0].state, scenario === "reload" ? "completed" : resume ? "unknown" : "prepared");
				assert.deepEqual(JSON.parse(invocations[0].arguments), original.task.invocations[0].arguments);
				const frozen = db.prepare("SELECT value FROM ui_state WHERE key='execution-blocked'").get(); assert.equal(Boolean(frozen), resume && scenario === "runtime");
			} finally { db.close(); }
		}
		assert.equal(git("status", "--porcelain").toString().trim(), "");
		cases.push({ scenario, applicationRuns: 2, phases, independentOwnedImageExitObservedAfterEachRun: true, externalCounterRemainsOne: true, externalHeartbeatUnchangedAcrossRestart: true, originalRecordsVerifiedReadOnlyAfterEachExit: true });
	}
	assert.deepEqual(await inventoryBundle(toolchain), toolchainBefore); await verifyBundle(copy); await verifyBundle(source);
	const proof = { packagedCommandSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, cases, applicationRuns: 4, actualPackagedApplication: true, outsideSourceCheckout: true, realDeveloperToolchainRequired: true, npmConfigurationExcluded: true, nodeSha256, bundleAndCopiedToolchainUnchanged: true, scopedImagesOnly: true, cleanWindowsVmVerified: false, fullRecoveryMatrixVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-command-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedCommandSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: 4, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
