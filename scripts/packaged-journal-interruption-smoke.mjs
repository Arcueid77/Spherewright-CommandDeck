import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, realpath, lstat, readdir, rename, rm } from "node:fs/promises";
import { join, resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { bundleExecutable, copyBundleTree, verifyBundle } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { readGit } from "../apps/desktop/workspace.mjs";
import { journalInterruptionCaseFile, journalInterruptionStartedFile, journalInterruptionFrozenFile } from "../apps/desktop/journal-interruption-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_JOURNAL_INTERRUPTION_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
assert.equal(manifest.portableJournalInterruption, 1, "PACKAGED_JOURNAL_INTERRUPTION_REBUILD_REQUIRED"); assert.equal(manifest.eventJournal, 1); assert.equal(manifest.nativeProcessObserver, 1);
const driverRevision = (await readGit(root, ["rev-parse", "HEAD"])).trim();
async function driverUnchanged() { assert.equal((await readGit(root, ["rev-parse", "HEAD"])).trim(), driverRevision); assert.equal((await readGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"])).trim(), "", "JOURNAL_INTERRUPTION_REQUIRES_CLEAN_DRIVER"); }
await driverUnchanged();
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle"), profile = join(directory, "supervisor-profile/supervisor");
const proofRoot = join(root, ".local/packaged-journal-interruption", runId); await mkdir(proofRoot, { recursive: true });
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, directory, sourceRevision: manifest.sourceRevision, driverRevision }), { flag: "wx" });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
const env = { ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId };
const observer = () => observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory], env });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
function rows(file, tables) {
	const db = new DatabaseSync(file, { readOnly: true });
	try { return Object.fromEntries(tables.map(table => [table, db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all().map(row => ({ ...row }))])); } finally { db.close(); }
}
function execution() {
	return { work: rows(join(profile, "m1-smoke-" + runId, "workbench.sqlite"), ["roots", "tasks", "events", "changes", "invocations"]), game: rows(join(profile, "game-smoke-" + runId, "game-tasks.sqlite"), ["game_tasks", "game_intents", "game_gate", "game_task_details", "game_task_events"]) };
}
function journal() { return rows(join(profile, "journal-smoke-" + runId, "events.sqlite"), ["recordings", "recorded_events", "bookmarks"]); }
function archive(raw) {
	assert.equal(raw.recordings.length, 1); const value = raw.recordings[0];
	return { recording: { id: value.id, state: value.state, startedAt: value.started_at, stoppedAt: value.stopped_at, events: value.event_count, bytes: value.byte_count, reason: value.reason, build: JSON.parse(value.build) }, events: raw.recorded_events.map(row => ({ sequence: row.sequence, elapsedMs: row.elapsed_ms, ...JSON.parse(row.value) })), bookmarks: raw.bookmarks.map(row => ({ id: row.id, sequence: row.sequence, tag: row.tag, createdAt: row.created_at })), readOnly: false, executionAuthority: false };
}
async function piFiles() {
	const base = join(profile, "m0-probes"), files = [], pending = [base]; let count = 0;
	while (pending.length) {
		const parent = pending.pop(); assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
		for (const name of await readdir(parent)) {
			assert.ok(++count <= 256); const file = join(parent, name), info = await lstat(file); assert.equal(info.isSymbolicLink(), false);
			if (info.isDirectory()) pending.push(file);
			else { assert.ok(info.isFile() && info.nlink === 1 && info.size <= 8388608); files.push({ path: relative(base, file).replaceAll("\\", "/"), bytes: info.size, sha256: createHash("sha256").update(await readFile(file)).digest("hex") }); }
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path)); assert.ok(files.some(file => file.path.endsWith(".jsonl"))); return files;
}
let passed = false, original, originalExecution, originalPi; const phases = [];
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const phase of ["record", "resume", "reopen"]) {
		const before = await observer(); assert.equal(before.count, 0, "PREVIOUS_PACKAGED_IMAGES_REMAIN");
		await writeFile(join(directory, journalInterruptionCaseFile), JSON.stringify({ version: 1, runId, phase }), { flag: "wx" });
		const child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false, forced = false, phaseError, code, signal; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
		const exited = once(child, "exit"); exited.catch(() => {});
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90000);
		try {
			if (phase === "record") {
				const deadline = performance.now() + 40000; let started;
				while (!started) {
					assert.ok(child.exitCode === null && child.signalCode === null && performance.now() < deadline, "JOURNAL_RECORDING_NOT_OBSERVED");
					try { started = JSON.parse(await readFile(join(directory, journalInterruptionStartedFile), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
					if (!started) await pause();
				}
				assert.equal(started.runId, runId); assert.equal(started.sourceRevision, manifest.sourceRevision); assert.equal(started.supervisorPid, child.pid); assert.equal(started.archive.recording.state, "recording");
				const live = await observer(); assert.ok(live.members.some(member => member.pid === child.pid && member.rootIndex === 0 && member.relativeImage.toLowerCase() === ("bundle/" + bundleExecutable).toLowerCase()), "EXACT_PACKAGED_ROOT_NOT_OBSERVED");
				await writeFile(join(proofRoot, "live-before-termination.private.json"), JSON.stringify(live), { flag: "wx" });
				assert.equal(journal().recordings[0].state, "recording"); assert.equal(child.kill("SIGKILL"), true); forced = true;
			}
			[code, signal] = await exited;
		} catch (error) { phaseError = error; if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); [code, signal] = await exited; }
		finally { clearTimeout(timer); }
		await writeFile(join(proofRoot, phase + "-exit.private.json"), JSON.stringify({ runId, phase, code, signal, timedOut, forced, output, error: phaseError?.message }), { flag: "wx" });
		let remaining; const deadline = performance.now() + 25000;
		do { const observed = await observer(); remaining = observed.count; await writeFile(join(proofRoot, phase + "-process-observation.private.json"), JSON.stringify(observed)); if (!remaining) break; await pause(); } while (performance.now() < deadline);
		assert.equal(remaining, 0, "PACKAGED_JOURNAL_CHILDREN_REMAIN"); if (phaseError) throw phaseError; assert.equal(timedOut, false);
		const actual = journal();
		if (phase === "record") {
			assert.equal(forced, true); assert.ok(code !== 0 || signal); original = actual; assert.equal(original.recordings[0].state, "recording"); assert.equal(original.recordings[0].stopped_at, null);
			const started = JSON.parse(await readFile(join(directory, journalInterruptionStartedFile), "utf8")), retained = archive(original);
			assert.deepEqual(retained.events.slice(0, started.archive.events.length), started.archive.events); assert.deepEqual(retained.bookmarks, started.archive.bookmarks);
			await writeFile(join(directory, journalInterruptionFrozenFile), JSON.stringify({ runId, sourceRevision: manifest.sourceRevision, archive: retained }), { flag: "wx" });
			await writeFile(join(proofRoot, "interrupted-original.private.json"), JSON.stringify({ journal: original, archive: retained }), { flag: "wx" });
			originalExecution = execution(); originalPi = await piFiles();
			for (const group of Object.values(originalExecution)) for (const values of Object.values(group)) assert.equal(values.length, 0);
		} else {
			assert.equal(code, 0, signal ?? output); const expected = structuredClone(original); expected.recordings[0].state = "interrupted"; expected.recordings[0].reason = "application_interrupted";
			assert.deepEqual(actual, expected); assert.deepEqual(execution(), originalExecution); assert.deepEqual(await piFiles(), originalPi);
			const proof = JSON.parse(await readFile(join(directory, "journal-interruption-" + phase + ".json"), "utf8"));
			assert.equal(proof.runId, runId); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.phase, phase);
			for (const field of ["interruptedRecordingRetained", "automaticRecordingNotResumed", "noModelOrTaskReplay"]) assert.equal(proof[field], true);
			assert.equal(proof.syntheticModelRequests, 0); assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
			assert.equal(proof.playback.historicalReplayReadOnly, true); assert.equal(proof.playback.replayExecutionActionsRejected, true);
			await writeFile(join(proofRoot, phase + "-application.json"), JSON.stringify(proof), { flag: "wx" });
		}
		await writeFile(join(proofRoot, phase + "-sql.private.json"), JSON.stringify({ journal: actual, execution: execution(), pi: await piFiles() }), { flag: "wx" });
		phases.push({ phase, forcedTermination: forced, normalExit: code === 0 && !signal, noOwnedPackagedImagesRemain: true });
		await rename(join(directory, journalInterruptionCaseFile), join(directory, "journal-interruption-case-" + phase + ".private.json"));
	}
	await verifyBundle(copy); await verifyBundle(source); await driverUnchanged();
	const proof = { packagedJournalInterruption: "passed", runId, sourceRevision: manifest.sourceRevision, driverRevision, piCommit: manifest.piCommit, applicationRuns: 3, phases, actualPackagedApplication: true, exactSpawnHandleTerminatedAfterIndependentObservation: true, originalEventsAndBookmarksRetained: true, interruptionChangesOnlyRecordingStateAndReason: true, interruptedRecordSurvivesNormalReopen: true, automaticRecordingNotResumed: true, originalExecutionRowsAndPiFilesRetained: true, noModelOrTaskReplay: true, syntheticModelRequests: 2, realModelRequests: 0, gameCalls: 0, bundleUnchanged: true, cleanWindowsVmVerified: false, videoRecordingVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-journal-interruption-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedJournalInterruption: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: 3, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
