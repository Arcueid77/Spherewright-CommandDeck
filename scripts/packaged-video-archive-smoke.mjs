import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile, readFile, rename, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bundleExecutable, copyBundleTree, verifyBundle } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { videoArchiveCaseFile } from "../apps/desktop/video-archive-smoke.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_VIDEO_ARCHIVE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source); assert.equal(manifest.portableVideoArchive, 1, "PACKAGED_VIDEO_ARCHIVE_REBUILD_REQUIRED"); assert.equal(manifest.videoPlaybackUi, 1, "PACKAGED_VIDEO_PLAYBACK_UI_REBUILD_REQUIRED"); assert.equal(manifest.nativeProcessObserver, 1);
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle"), proofRoot = join(root, ".local/packaged-video-archive", runId); await mkdir(proofRoot, { recursive: true });
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, directory, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
const env = { ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId };
const observer = () => observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory], env });
let passed = false, original; const phases = [];
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const phase of ["record", "reopen"]) {
		assert.equal((await observer()).count, 0); await writeFile(join(directory, videoArchiveCaseFile), JSON.stringify({ version: 1, runId, phase }), { flag: "wx" });
		const child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90000); let code, signal; try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
		await writeFile(join(proofRoot, phase + "-exit.private.json"), JSON.stringify({ runId, phase, code, signal, timedOut, output }), { flag: "wx" });
		let observed; const deadline = performance.now() + 25000; do { observed = await observer(); if (!observed.count) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() < deadline);
		await writeFile(join(proofRoot, phase + "-process-observation.private.json"), JSON.stringify(observed), { flag: "wx" }); assert.equal(observed.count, 0); assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
		const proof = JSON.parse(await readFile(join(directory, "video-archive-" + phase + ".json"), "utf8")); assert.equal(proof.runId, runId); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.phase, phase);
		for (const field of ["encodedMediaArchivedAndDecoded", "decodedFrameContentChanges", "readerReadOnly", "uiReloadRetainsRuntimeWithoutModel", "videoPlaybackUiVerified", "staleVideoUrlRefusedAfterReload", "videoUiExecutionMethodsRefused", "playbackReadersClosed"]) assert.equal(proof[field], true);
		assert.equal(proof.source, "generated-canvas-only"); assert.equal(proof.modelRequests, 0); assert.equal(proof.gameCalls, 0); assert.equal(proof.nativeWindowCaptureVerified, false);
		if (phase === "record") original = { sha256: proof.sha256, bytes: proof.encodedBytes, chunks: proof.chunks }; else { assert.equal(proof.originalRecordingRetained, true); assert.deepEqual({ sha256: proof.sha256, bytes: proof.encodedBytes, chunks: proof.chunks }, original); }
		await writeFile(join(proofRoot, phase + "-application.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); phases.push(proof);
		await rename(join(directory, videoArchiveCaseFile), join(directory, "video-archive-case-" + phase + ".private.json")); await verifyBundle(copy);
	}
	await verifyBundle(source);
	const proof = { packagedVideoArchive: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, applicationRuns: 2, phases, encodedClipRetainedAcrossApplicationRestart: true, videoPlaybackUiVerified: true, staleVideoUrlRefusedAfterReload: true, videoUiExecutionMethodsRefused: true, playbackReadersClosed: true, independentlyObservedOwnedImagesExited: true, completeBundlesUnchanged: true, source: "generated-canvas-only", nativeWindowCaptureVerified: false, wholeRecordingUiVerified: false, gameCalls: 0, modelRequests: 0, physicalInputVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-video-archive-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedVideoArchive: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: 2, gameCalls: 0, modelRequests: 0, nativeWindowCaptureVerified: false }));
} finally { if (passed) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } }
