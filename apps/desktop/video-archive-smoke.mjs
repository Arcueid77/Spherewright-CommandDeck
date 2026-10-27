import assert from "node:assert/strict";
import { lstat, readFile, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { VideoArchive } from "./video-archive.mjs";

export const videoArchiveCaseFile = "video-archive-case.private.json";
export async function readVideoArchiveCase(context) {
	const file = join(context.root, videoArchiveCaseFile); let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 4096); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8")); assert.deepEqual(Object.keys(value).sort(), ["phase", "runId", "version"]); assert.equal(value.version, 1); assert.equal(value.runId, context.runId); assert.ok(["record", "reopen"].includes(value.phase)); return value;
}

export const videoArchiveEncodeScript = `(async()=>{
let stream, recorder, timer;
try {
const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const context=canvas.getContext('2d');let frames=0;
const draw=()=>{context.fillStyle='rgb(64,128,192)';context.fillRect(0,0,160,90);context.fillStyle='rgb(224,80,32)';context.fillRect((frames++*11)%140,75,20,15)};draw();
stream=canvas.captureStream(10);if(stream.getAudioTracks().length)throw new Error('UNEXPECTED_AUDIO');
recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:200000});const chunks=[];
recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data.arrayBuffer().then(value=>Array.from(new Uint8Array(value))))};
const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=()=>reject(new Error('OWN_CANVAS_RECORDER_FAILED'))});
recorder.start(250);timer=setInterval(draw,100);await new Promise(resolve=>setTimeout(resolve,1800));recorder.stop();await stopped;
return {chunks:await Promise.all(chunks),mime:recorder.mimeType,canvasUpdates:frames,source:'generated-canvas-only',audioTracks:stream.getAudioTracks().length};
} catch(error){return {error:String(error?.message??error)}}
finally{clearInterval(timer);if(recorder?.state==='recording')recorder.stop();for(const track of stream?.getTracks()??[])track.stop()}
})()`;
export function videoArchiveDecodeScript(base64) { return `(async()=>{
let url,video;try{
const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),value=>value.charCodeAt(0));url=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));
video=document.createElement('video');video.muted=true;video.style.cssText='position:fixed;right:0;bottom:0;width:160px;height:90px';video.src=url;document.body.append(video);await video.play();
const deadline=performance.now()+7000;const wait=async time=>{while(video.readyState<2||video.currentTime<time){if(performance.now()>deadline)throw new Error('OWN_VIDEO_DECODE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,25))}};
const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const context=canvas.getContext('2d',{willReadFrequently:true});
const sample=()=>{context.drawImage(video,0,0,160,90);const row=context.getImageData(0,82,160,1).data;let hash=2166136261;for(const value of row)hash=Math.imul(hash^value,16777619);return {hash:hash>>>0,pixel:Array.from(context.getImageData(8,8,1,1).data)}};
await wait(0.15);const first=sample();await wait(1.1);const second=sample();video.pause();return {width:video.videoWidth,height:video.videoHeight,first,second,time:video.currentTime};
}catch(error){return {error:String(error?.message??error)}}finally{video?.pause();video?.remove();if(url)URL.revokeObjectURL(url)}
})()`; }

export async function runVideoArchiveSmoke(driver, fixture, manifest) {
	const archive = new VideoArchive(join(driver.privateDirectory, "video-archive-fixture")); let reader;
	const runtime = driver.getRuntimePid(), sequence = driver.getProbeSequence(); assert.equal(sequence, 0);
	try {
		const work = await driver.api("workbench", { action: "state" }), game = await driver.api("game", { action: "snapshot" }), bridge = await driver.api("bridge", { action: "snapshot" });
		assert.deepEqual(work.roots, []); assert.deepEqual(work.tasks, []); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null);
		let recording, updates = 0;
		if (fixture.phase === "record") {
			assert.equal(archive.snapshot().recordings.length, 0);
			const encoded = await driver.testCommand("evaluate", { source: videoArchiveEncodeScript }); assert.equal(encoded.error, undefined); assert.equal(encoded.source, "generated-canvas-only"); assert.equal(encoded.mime, "video/webm;codecs=vp8"); assert.equal(encoded.audioTracks, 0); assert.ok(encoded.canvasUpdates >= 8);
			await writeFile(join(driver.context.root, "video-archive-encoding.private.json"), JSON.stringify({ mime: encoded.mime, canvasUpdates: encoded.canvasUpdates, chunks: encoded.chunks.map(value => ({ bytes: value.length, header: Buffer.from(value).subarray(0, 16).toString("hex") })) }), { flag: "wx" });
			const id = (await archive.start({ width: 160, height: 90, frameRate: 10, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit })).activeId;
			for (let index = 0; index < encoded.chunks.length; index++) await archive.append(id, index + 1, Uint8Array.from(encoded.chunks[index]));
			await archive.finish(id); recording = archive.snapshot().recordings[0]; updates = encoded.canvasUpdates;
			await writeFile(join(driver.context.root, "video-archive-expected.private.json"), JSON.stringify({ runId: driver.context.runId, sourceRevision: manifest.sourceRevision, recording }), { flag: "wx" });
		} else {
			const expected = JSON.parse(await readFile(join(driver.context.root, "video-archive-expected.private.json"), "utf8")); assert.equal(expected.runId, driver.context.runId); assert.equal(expected.sourceRevision, manifest.sourceRevision);
			assert.equal(archive.snapshot().activeId, null); assert.deepEqual(archive.snapshot().recordings, [expected.recording]); recording = expected.recording;
		}
		assert.equal(recording.state, "complete"); assert.ok(recording.bytes < 32768); reader = await archive.openReader(recording.id); assert.equal(reader.readOnly, true); assert.equal(reader.executionAuthority, false); assert.equal(reader.observedSha256, recording.sha256);
		const bytes = await reader.read(0, recording.bytes), decoded = await driver.testCommand("evaluate", { source: videoArchiveDecodeScript(bytes.toString("base64")) });
		assert.equal(decoded.error, undefined); assert.equal(decoded.width, 160); assert.equal(decoded.height, 90); assert.notEqual(decoded.first.hash, decoded.second.hash, "DECODED_VIDEO_DID_NOT_ADVANCE");
		for (const pixel of [decoded.first.pixel, decoded.second.pixel]) for (let index = 0; index < 3; index++) assert.ok(Math.abs(pixel[index] - [64, 128, 192][index]) <= 15, "DECODED_CANVAS_PIXELS_UNCONFIRMED");
		await reader.close(); reader = null; await archive.close(); await driver.testCommand("reload");
		assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), sequence);
		const proof = { runId: driver.context.runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, phase: fixture.phase, encodedMediaArchivedAndDecoded: true, originalRecordingRetained: fixture.phase === "reopen", source: "generated-canvas-only", width: 160, height: 90, canvasUpdates: updates, encodedBytes: recording.bytes, chunks: recording.chunks, sha256: recording.sha256, decodedFrameContentChanges: true, readerReadOnly: true, uiReloadRetainsRuntimeWithoutModel: true, modelRequests: 0, gameCalls: 0, nativeWindowCaptureVerified: false, wholeRecordingUiVerified: false, physicalInputVerified: false };
		await writeFile(join(driver.context.root, "video-archive-" + fixture.phase + ".json"), JSON.stringify(proof), { flag: "wx" });
	} finally { await reader?.close(); if (!archive.closed) await archive.close(); }
	assert.equal(await driver.getTray().activate("exit"), true);
}
