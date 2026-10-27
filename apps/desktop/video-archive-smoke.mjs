import assert from "node:assert/strict";
import { lstat, readFile, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { paintMaskedVideo } from "./video-frame.mjs";
import { VideoRecording } from "./video-recording.mjs";

export const videoArchiveCaseFile = "video-archive-case.private.json";
export async function readVideoArchiveCase(context) {
	const file = join(context.root, videoArchiveCaseFile); let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 4096); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8")); assert.deepEqual(Object.keys(value).sort(), ["phase", "runId", "version"]); assert.equal(value.version, 1); assert.equal(value.runId, context.runId); assert.ok(["record", "reopen"].includes(value.phase)); return value;
}

export const videoArchiveEncodeScript = `(async()=>{
let stream, previewStream, recorder, timer;
try {
const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const context=canvas.getContext('2d');let frames=0;
const raw=document.createElement('canvas'),staging=document.createElement('canvas');raw.width=staging.width=160;raw.height=staging.height=90;const rawContext=raw.getContext('2d'),stagingContext=staging.getContext('2d');const paint=${paintMaskedVideo.toString()};let masks=[];
const draw=()=>{rawContext.fillStyle='rgb(64,128,192)';rawContext.fillRect(0,0,160,90);rawContext.fillStyle='rgb(224,80,32)';rawContext.fillRect((frames++*11)%140,75,20,15);paint(stagingContext,raw,160,90,masks);context.drawImage(staging,0,0)};draw();previewStream=canvas.captureStream(15);await new Promise(resolve=>setTimeout(resolve,100));masks=[{x:0,y:0,width:2500,height:2500}];draw();
stream=canvas.captureStream(15);if(stream.getAudioTracks().length)throw new Error('UNEXPECTED_AUDIO');
recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:200000});const chunks=[];
recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data.arrayBuffer().then(value=>Array.from(new Uint8Array(value))))};
const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=()=>reject(new Error('OWN_CANVAS_RECORDER_FAILED'))});
recorder.start(250);timer=setInterval(draw,100);await new Promise(resolve=>setTimeout(resolve,1800));recorder.stop();await stopped;
return {chunks:await Promise.all(chunks),mime:recorder.mimeType,canvasUpdates:frames,source:'generated-canvas-only',audioTracks:stream.getAudioTracks().length,maskedBeforeEncoding:true,freshEncoderTrackAfterMask:true};
} catch(error){return {error:String(error?.message??error)}}
finally{clearInterval(timer);if(recorder?.state==='recording')recorder.stop();for(const track of [...stream?.getTracks()??[],...previewStream?.getTracks()??[]])track.stop()}
})()`;
export function videoArchiveDecodeScript(base64) { return `(async()=>{
let url,video;try{
const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),value=>value.charCodeAt(0));url=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));
video=document.createElement('video');video.muted=true;video.preload='auto';video.style.cssText='position:fixed;right:0;bottom:0;width:160px;height:90px';video.src=url;document.body.append(video);
const deadline=performance.now()+7000;const wait=async time=>{while(video.readyState<2||video.currentTime<time){if(performance.now()>deadline)throw new Error('OWN_VIDEO_DECODE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,25))}};
const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const context=canvas.getContext('2d',{willReadFrequently:true});
const sample=()=>{context.drawImage(video,0,0,160,90);const row=context.getImageData(0,82,160,1).data;let hash=2166136261;for(const value of row)hash=Math.imul(hash^value,16777619);return {hash:hash>>>0,pixel:Array.from(context.getImageData(8,8,1,1).data),visiblePixel:Array.from(context.getImageData(80,30,1,1).data)}};
await wait(0);const first=sample(),firstTime=video.currentTime;await video.play();await wait(1.1);const second=sample();video.pause();return {width:video.videoWidth,height:video.videoHeight,first,second,firstTime,time:video.currentTime};
}catch(error){return {error:String(error?.message??error)}}finally{video?.pause();video?.remove();if(url)URL.revokeObjectURL(url)}
})()`; }

export async function runVideoArchiveSmoke(driver, fixture, manifest, archive) {
	assert.ok(archive && !archive.closed && !archive.error, "HOST_VIDEO_ARCHIVE_REQUIRED"); let reader;
	const runtime = driver.getRuntimePid(), sequence = driver.getProbeSequence(); assert.equal(sequence, 0);
	try {
		const work = await driver.api("workbench", { action: "state" }), game = await driver.api("game", { action: "snapshot" }), bridge = await driver.api("bridge", { action: "snapshot" });
		assert.deepEqual(work.roots, []); assert.deepEqual(work.tasks, []); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null);
		let recording, updates = 0;
		if (fixture.phase === "record") {
			assert.equal(archive.snapshot().recordings.length, 0);
			const encoded = await driver.testCommand("evaluate", { source: videoArchiveEncodeScript }); assert.equal(encoded.error, undefined); assert.equal(encoded.source, "generated-canvas-only"); assert.equal(encoded.mime, "video/webm;codecs=vp8"); assert.equal(encoded.audioTracks, 0); assert.ok(encoded.canvasUpdates >= 8);
			await writeFile(join(driver.context.root, "video-archive-encoding.private.json"), JSON.stringify({ mime: encoded.mime, canvasUpdates: encoded.canvasUpdates, chunks: encoded.chunks.map(value => ({ bytes: value.length, header: Buffer.from(value).subarray(0, 16).toString("hex") })) }), { flag: "wx" });
			assert.equal(encoded.maskedBeforeEncoding, true);
			assert.equal(encoded.freshEncoderTrackAfterMask, true);
			// Synthetic ports exercise the actual coordinator/archive with generated
			// canvas bytes. They never invoke OS capture or the production UI grant.
			const owner = {}, source = { version: 1, sourceId: "window:1:0", windowBinding: "f".repeat(32), width: 160, height: 90, layoutRevision: 1, gamePid: 1, gameStartedTicks: "639000000000000000", kind: "fixture", targetId: "generated-canvas-only" };
			const coordinator = new VideoRecording({ getArchive: () => archive, getBuild: () => manifest, getSource: async () => source, isCurrent: (value, generation) => value === owner && generation === 1, isLocked: () => false });
			try {
				const { permit } = await coordinator.prepare(owner, 1, { profile: "720p15", masks: [{ x: 0, y: 0, width: 2500, height: 2500 }] }); await coordinator.authorize(owner, 1, permit);
				await coordinator.ready(owner, 1, permit, { audioTracks: 0, videoTracks: 1, displaySurface: "window", width: 160, height: 90, frameRate: 15 }); await coordinator.start(owner, 1, permit);
				for (let index = 0; index < encoded.chunks.length; index++) await coordinator.append(owner, 1, permit, index + 1, Uint8Array.from(encoded.chunks[index]));
				await coordinator.finish(owner, 1, permit); coordinator.closed(owner, 1, permit); assert.equal(coordinator.snapshot().phase, "idle");
			} finally { await coordinator.dispose(); }
			recording = archive.snapshot().recordings[0]; updates = encoded.canvasUpdates;
			await writeFile(join(driver.context.root, "video-archive-expected.private.json"), JSON.stringify({ runId: driver.context.runId, sourceRevision: manifest.sourceRevision, recording }), { flag: "wx" });
		} else {
			const expected = JSON.parse(await readFile(join(driver.context.root, "video-archive-expected.private.json"), "utf8")); assert.equal(expected.runId, driver.context.runId); assert.equal(expected.sourceRevision, manifest.sourceRevision);
			assert.equal(archive.snapshot().activeId, null); assert.deepEqual(archive.snapshot().recordings, [expected.recording]); recording = expected.recording;
		}
		assert.equal(recording.state, "complete"); assert.ok(recording.bytes < 32768); reader = await archive.openReader(recording.id); assert.equal(reader.readOnly, true); assert.equal(reader.executionAuthority, false); assert.equal(reader.observedSha256, recording.sha256);
		const bytes = await reader.read(0, recording.bytes), decoded = await driver.testCommand("evaluate", { source: videoArchiveDecodeScript(bytes.toString("base64")) });
		assert.equal(decoded.error, undefined); assert.equal(decoded.width, 160); assert.equal(decoded.height, 90); assert.notEqual(decoded.first.hash, decoded.second.hash, "DECODED_VIDEO_DID_NOT_ADVANCE");
		assert.equal(decoded.firstTime, 0, "FIRST_DECODED_FRAME_NOT_SAMPLED");
		for (const pixel of [decoded.first.pixel, decoded.second.pixel]) for (let index = 0; index < 3; index++) assert.ok(pixel[index] <= 8, "DECODED_PRIVACY_MASK_UNCONFIRMED");
		for (const pixel of [decoded.first.visiblePixel, decoded.second.visiblePixel]) for (let index = 0; index < 3; index++) assert.ok(Math.abs(pixel[index] - [64, 128, 192][index]) <= 15, "DECODED_CANVAS_PIXELS_UNCONFIRMED");
		await reader.close(); reader = null;
		await checkVideoPlaybackUi(driver, recording, archive);
		assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), sequence);
		const proof = { runId: driver.context.runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, phase: fixture.phase, encodedMediaArchivedAndDecoded: true, originalRecordingRetained: fixture.phase === "reopen", source: "generated-canvas-only", width: 160, height: 90, canvasUpdates: updates, encodedBytes: recording.bytes, chunks: recording.chunks, sha256: recording.sha256, decodedFrameContentChanges: true, privacyMaskRetainedOnDecode: true, privacyFirstDecodedFrameVerified: true, generatedCanvasCoordinatorRoundtrip: fixture.phase === "record", readerReadOnly: true, videoPlaybackUiVerified: true, staleVideoUrlRefusedAfterReload: true, videoUiExecutionMethodsRefused: true, playbackReadersClosed: true, uiReloadRetainsRuntimeWithoutModel: true, modelRequests: 0, gameCalls: 0, nativeWindowCaptureVerified: false, wholeRecordingUiVerified: false, physicalInputVerified: false };
		await writeFile(join(driver.context.root, "video-archive-" + fixture.phase + ".json"), JSON.stringify(proof), { flag: "wx" });
	} finally { await reader?.close(); }
	assert.equal(await driver.getTray().activate("exit"), true);
}

async function checkVideoPlaybackUi(driver, recording, archive) {
	const evaluate = source => driver.testCommand("evaluate", { source });
	const until = async (predicate, label) => { const deadline = performance.now() + 10000; while (!await predicate()) { assert.ok(performance.now() < deadline, "VIDEO_UI_TIMEOUT_" + label); await new Promise(resolve => setTimeout(resolve, 40)); } };
	const open = async () => {
		await until(() => evaluate("[...document.querySelectorAll('header button')].some(button=>button.textContent==='录像'&&!button.disabled)"), "HEADER");
		await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='录像').click();true");
		await until(() => evaluate("[...document.querySelectorAll('.videos-panel button')].some(button=>button.textContent==='打开播放'&&!button.disabled)"), "OPEN");
		assert.equal(await evaluate("document.querySelector('.videos-panel select[aria-label=本地录像]').value"), recording.id);
		await evaluate("[...document.querySelectorAll('.videos-panel button')].find(button=>button.textContent==='打开播放').click();true");
		await until(() => evaluate("Boolean(document.querySelector('.videos-panel video[aria-label=本地录像播放器]')?.readyState>=1)"), "METADATA");
		const played = await evaluate("(async()=>{const video=document.querySelector('.videos-panel video[aria-label=本地录像播放器]');await video.play();const deadline=performance.now()+7000;while(video.currentTime<1.1){if(video.error||performance.now()>deadline)throw new Error('VIDEO_PLAYBACK_DID_NOT_ADVANCE');await new Promise(resolve=>setTimeout(resolve,25))}video.pause();return {width:video.videoWidth,height:video.videoHeight,time:video.currentTime,frames:video.getVideoPlaybackQuality().totalVideoFrames,url:video.src}})()");
		assert.equal(played.width, 160); assert.equal(played.height, 90); assert.ok(played.frames >= 2); assert.ok(played.time >= 1.1); assert.match(played.url, /^deck-video:\/\/stream\/[a-f0-9-]{36}$/); return played.url;
	};
	const first = await open();
	const denied = await evaluate("(async()=>{const rows=[];for(const action of ['start','commit','replay','resume','read']){try{await window.deck.video(action);rows.push(false)}catch{rows.push(true)}}return rows})()"); assert.deepEqual(denied, [true, true, true, true, true]);
	await driver.testCommand("reload"); await until(async () => archive.readers.size === 0, "RELOAD_CLOSE");
	const stale = await evaluate(`(async()=>{const video=document.createElement('video');video.muted=true;video.src=${JSON.stringify(first)};try{return await new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),4000);video.onerror=()=>{clearTimeout(timer);resolve('refused')};video.onloadedmetadata=()=>{clearTimeout(timer);resolve('opened')};video.load()})}finally{video.removeAttribute('src');video.load()}})()`); assert.equal(stale, "refused");
	const second = await open(); assert.notEqual(second, first);
	await evaluate("[...document.querySelectorAll('.videos-panel button')].find(button=>button.textContent==='关闭播放').click();true");
	await until(async () => archive.readers.size === 0 && !await evaluate("Boolean(document.querySelector('.videos-panel video[aria-label=本地录像播放器]'))"), "PLAYER_CLOSE");
	assert.deepEqual(archive.snapshot().recordings, [recording]); assert.equal(archive.active, null);
}
