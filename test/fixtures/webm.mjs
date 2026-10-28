import assert from "node:assert/strict";
export const hex = value => Buffer.from(value, "hex");
export function element(id, data) { assert.ok(data.length < 127); return Buffer.concat([hex(id), Buffer.from([128 | data.length]), data]); }
export const uint = (id, value) => { const data = Buffer.alloc(4); data.writeUInt32BE(value); return element(id, data); };
export const block = (relative, { flags = 128, track = 129, payload = hex("111f43b675a341") } = {}) => { const header = Buffer.alloc(4); header[0] = track; header.writeInt16BE(relative, 1); header[3] = flags; return element("a3", Buffer.concat([header, payload])); };
export const cluster = (timestamp, blocks, unknown = false) => { const data = Buffer.concat([uint("e7", timestamp), ...blocks]); return unknown ? Buffer.concat([hex("1f43b675ff"), data]) : element("1f43b675", data); };
export function movie(clusters, { scale = 1000000, type = 1, codec = "V_VP8", extras = [] } = {}) {
	const header = element("1a45dfa3", element("4282", Buffer.from("webm"))), info = element("1549a966", uint("2ad7b1", scale));
	const entry = element("ae", Buffer.concat([uint("d7", 1), uint("83", type), element("86", Buffer.from(codec)), ...extras])), tracks = element("1654ae6b", entry);
	return Buffer.concat([header, hex("1853806701ffffffffffffff"), info, tracks, ...clusters]);
}
