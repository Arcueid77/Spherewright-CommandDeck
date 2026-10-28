import test from "node:test";
import assert from "node:assert/strict";
import { WebmTiming } from "../apps/desktop/webm-timing.mjs";
import { hex, element, uint, block, cluster, movie } from "./fixtures/webm.mjs";
test("streamed WebM timings read container timestamps and skip payloads rather than scanning magic bytes", () => {
	const bytes = movie([cluster(0, [block(0), block(100)]), cluster(1000, [block(-50), block(50, { flags: 0 })], true), cluster(2000, [block(0)], true)]);
	const reader = new WebmTiming(); for (const byte of bytes) reader.push(Buffer.from([byte]));
	assert.deepEqual(reader.finish(), { status: "available", source: "encoded-webm-pts-v1", reason: null, firstMs: 0, lastMs: 2000, frames: 5, executionAuthority: false }); assert.ok(reader.buffer.length <= 12);
});
test("incomplete frame payloads do not extend timing coverage and interrupted prefixes retain only complete frames", () => {
	const bytes = movie([cluster(0, [block(0), block(100)])]), reader = new WebmTiming(); reader.push(bytes.subarray(0, bytes.length - 1));
	assert.equal(reader.finish(false).lastMs, 0); assert.equal(reader.finish(false).frames, 1); assert.equal(reader.finish(true).status, "unsupported"); assert.equal(reader.snapshot().reason, "WEBM_TIMING_INCOMPLETE");
});
test("BlockGroup timing waits for the complete group and accepts VP8 alpha additions without treating them as frames", () => {
	const grouped = relative => element("a0", Buffer.concat([element("a1", Buffer.concat([hex("81"), Buffer.from([relative >> 8 & 255, relative & 255, 0, 17])])), element("75a1", hex("a381001f43b675"))]));
	const bytes = movie([cluster(0, [grouped(0), grouped(100)])]), reader = new WebmTiming(); reader.push(bytes.subarray(0, bytes.length - 1)); assert.equal(reader.snapshot().frames, 1); reader.push(bytes.subarray(-1)); assert.equal(reader.finish().frames, 2); assert.equal(reader.snapshot().lastMs, 100);
	const reference = new WebmTiming(); reference.push(movie([cluster(0, [element("a0", Buffer.concat([element("a1", hex("8100000011")), element("fb", hex("ff"))]))])])); assert.equal(reference.finish().reason, "WEBM_TIMING_TIMESTAMP_UNCONFIRMED");
});
test("timestamp scale is applied and invisible frames do not extend visible coverage", () => {
	const reader = new WebmTiming(); reader.push(movie([cluster(0, [block(0), block(100), block(200, { flags: 8 })])], { scale: 2000000 })); assert.equal(reader.finish().lastMs, 200); assert.equal(reader.snapshot().frames, 2);
});
test("lacing, extra tracks, speed/offset changes and foreign codecs never receive a timing claim", () => {
	const cases = [movie([cluster(0, [block(0, { flags: 130 })])]), movie([cluster(0, [block(0)])], { type: 2 }), movie([cluster(0, [block(0)])], { codec: "V_VP9" }), movie([cluster(0, [block(0)])], { extras: [uint("56aa", 1)] }), movie([cluster(0, [block(0)])], { extras: [element("23314f", hex("4000000000000000"))] })];
	for (const bytes of cases) { const reader = new WebmTiming(); reader.push(bytes); assert.equal(reader.finish().status, "unsupported"); assert.equal(reader.snapshot().firstMs, null); }
});
test("negative, regressing and oversized timestamps remain unconfirmed", () => {
	for (const data of [[cluster(0, [block(-1)])], [cluster(100, [block(0), block(-1)])], [cluster(2147483647, [block(1)])]]) { const reader = new WebmTiming(); reader.push(movie(data)); assert.equal(reader.finish().reason, "WEBM_TIMING_TIMESTAMP_UNCONFIRMED"); }
});
test("unknown leaf sizes, parent-bound overflows and element floods remain bounded", () => {
	const variants = [Buffer.concat([movie([]), hex("ecff")]), Buffer.concat([movie([]), hex("1f43b67581e78400000000")])];
	for (const bytes of variants) { const reader = new WebmTiming(); reader.push(bytes); assert.equal(reader.finish().status, "unsupported"); }
	const flood = new WebmTiming(); flood.push(Buffer.concat([movie([]), Buffer.from("ec80".repeat(8193), "hex")])); assert.equal(flood.snapshot().reason, "WEBM_TIMING_LIMIT"); assert.equal(flood.buffer.length, 0);
	assert.throws(() => new WebmTiming().push(Buffer.alloc(2097153)), /WEBM_TIMING_CHUNK_INVALID/);
});
