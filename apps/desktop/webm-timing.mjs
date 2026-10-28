// A bounded timing reader for the single VP8 video track produced by this
// recorder. It skips encoded payloads, never decodes pixels or edits media.
const id = { ebml: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, entry: 0xae, video: 0xe0, cluster: 0x1f43b675, block: 0xa3, group: 0xa0 };
const masters = new Map([[id.ebml, null], [id.segment, null], [id.info, id.segment], [id.tracks, id.segment], [id.entry, id.tracks], [id.video, id.entry], [id.cluster, id.segment], [id.group, id.cluster]]);
const topLevel = new Set([id.cluster, id.info, id.tracks, 0x114d9b74, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469]);
function vint(bytes, offset, identifier = false) {
	if (offset >= bytes.length) return null;
	let mask = 128, length = 1; while (length <= 8 && !(bytes[offset] & mask)) { mask /= 2; length++; }
	if (length > (identifier ? 4 : 8)) throw new Error("WEBM_TIMING_FORMAT"); if (offset + length > bytes.length) return null;
	let value = BigInt(identifier ? bytes[offset] : bytes[offset] & (mask - 1)); for (let index = 1; index < length; index++) value = value * 256n + BigInt(bytes[offset + index]);
	return { length, value, unknown: !identifier && value === (1n << BigInt(7 * length)) - 1n };
}
function unsigned(bytes, size) {
	if (size < 1 || size > 8 || bytes.length < size) throw new Error("WEBM_TIMING_FORMAT");
	let value = 0n; for (let index = 0; index < size; index++) value = value * 256n + BigInt(bytes[index]); return value;
}
export class WebmTiming {
	constructor() { this.buffer = Buffer.alloc(0); this.position = 0; this.stack = []; this.pending = null; this.reason = null; this.frames = 0; this.elements = 0; this.scale = 1000000n; this.firstMs = null; this.lastMs = null; this.lastNs = -1n; this.track = null; this.header = false; this.segment = false; this.info = false; this.tracks = false; }
	snapshot() { return { status: this.reason ? "unsupported" : this.frames ? "available" : "pending", source: "encoded-webm-pts-v1", reason: this.reason, firstMs: this.reason ? null : this.firstMs, lastMs: this.reason ? null : this.lastMs, frames: this.reason ? 0 : this.frames, executionAuthority: false }; }
	completeContainer() {
		while (this.stack.length && this.stack.at(-1).end === this.position) {
			const container = this.stack.pop();
			if (container.id === id.ebml) { if (!container.webm) throw new Error("WEBM_TIMING_FORMAT"); this.header = true; }
			if (container.id === id.entry) {
				if (this.track || !container.number || container.type !== 1n || container.codec !== "V_VP8") throw new Error("WEBM_TIMING_TRACK_UNSUPPORTED"); this.track = container.number;
			}
			if (container.id === id.group) { if (!container.block) throw new Error("WEBM_TIMING_FORMAT"); this.frame(container.block, !container.reference); }
		}
		if (this.stack.some(container => container.end !== null && this.position > container.end)) throw new Error("WEBM_TIMING_FORMAT");
	}
	leaf(element, bytes, size, parent) {
		if (element === 0x4282 && parent?.id === id.ebml) { if (parent.webm || bytes.toString("ascii") !== "webm" || size !== 4) throw new Error("WEBM_TIMING_FORMAT"); parent.webm = true; }
		else if (element === 0x2ad7b1 && parent?.id === id.info) { if (parent.scale || this.frames) throw new Error("WEBM_TIMING_FORMAT"); this.scale = unsigned(bytes, size); if (this.scale < 1n || this.scale > 1000000000n) throw new Error("WEBM_TIMING_FORMAT"); parent.scale = true; }
		else if (parent?.id === id.entry && [0xd7, 0x83, 0x86, 0x23314f, 0x537f, 0x56aa, 0x6d80].includes(element)) {
			if (element === 0xd7) { if (parent.number) throw new Error("WEBM_TIMING_FORMAT"); parent.number = unsigned(bytes, size); }
			if (element === 0x83) { if (parent.type) throw new Error("WEBM_TIMING_FORMAT"); parent.type = unsigned(bytes, size); }
			if (element === 0x86) { if (parent.codec || size > 32) throw new Error("WEBM_TIMING_TRACK_UNSUPPORTED"); parent.codec = bytes.toString("ascii"); }
			if (element === 0x23314f && ![4, 8].includes(size) || element === 0x23314f && (size === 4 ? bytes.readFloatBE() : bytes.readDoubleBE()) !== 1 || [0x537f, 0x56aa].includes(element) && unsigned(bytes, size) !== 0n || element === 0x6d80) throw new Error("WEBM_TIMING_TRACK_UNSUPPORTED");
		}
		else if (element === 0xe7 && parent?.id === id.cluster) { if (parent.timestamp !== undefined) throw new Error("WEBM_TIMING_FORMAT"); parent.timestamp = unsigned(bytes, size); }
		else if (element === 0xfb && parent?.id === id.group) { unsigned(bytes, size); parent.reference = true; }
		else if (element === 0xa4 && parent?.id === id.group || [0xa1, 0xaf].includes(element) && parent?.id === id.cluster) throw new Error("WEBM_TIMING_BLOCK_UNSUPPORTED");
		else if (element === id.block || element === 0xa1) {
			const simple = element === id.block, cluster = simple ? parent : parent?.cluster;
			if (simple && parent?.id !== id.cluster || !simple && (parent?.id !== id.group || parent.block) || cluster?.timestamp === undefined || !this.track || !this.info || !this.tracks) throw new Error("WEBM_TIMING_FORMAT");
			const track = vint(bytes, 0); if (!track || track.unknown || track.value !== this.track || size < track.length + 4) throw new Error("WEBM_TIMING_FORMAT");
			const flags = bytes[track.length + 2]; if (flags & 6 || simple && flags & 0x70 || !simple && flags & 0xf1) throw new Error("WEBM_TIMING_BLOCK_UNSUPPORTED");
			const block = { nanos: (cluster.timestamp + BigInt(bytes.readInt16BE(track.length))) * this.scale, visible: !(flags & 8) };
			if (simple) this.frame(block, Boolean(flags & 128)); else parent.block = block;
		}
	}
	frame(block, keyframe) {
		if (!block.visible) return; const nanos = block.nanos;
		if (nanos < 0n || nanos < this.lastNs || nanos > 2147483647000000n || !this.frames && !keyframe) throw new Error("WEBM_TIMING_TIMESTAMP_UNCONFIRMED");
		const ms = Number(nanos / 1000000n) + Number(nanos % 1000000n) / 1000000; this.firstMs ??= ms; this.lastMs = ms; this.lastNs = nanos;
		if (++this.frames > 1048576) throw new Error("WEBM_TIMING_LIMIT");
	}
	push(chunk) {
		if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > 2097152) throw new Error("WEBM_TIMING_CHUNK_INVALID"); if (this.reason) return this.snapshot();
		try {
			if (this.position + this.buffer.length + chunk.length > 134217728) throw new Error("WEBM_TIMING_LIMIT");
			const bytes = Buffer.concat([this.buffer, chunk]); let cursor = 0, elements = 0;
			while (cursor < bytes.length) {
				if (this.pending) {
					const pending = this.pending, length = Math.min(pending.remaining, bytes.length - cursor), keep = Math.min(length, 32 - pending.head.length);
					if (keep > 0) pending.head = Buffer.concat([pending.head, bytes.subarray(cursor, cursor + keep)]);
					cursor += length; this.position += length; pending.remaining -= length;
					if (!pending.remaining) { this.leaf(pending.id, pending.head, pending.size, pending.parent); this.pending = null; this.completeContainer(); } continue;
				}
				this.completeContainer(); const element = vint(bytes, cursor, true); if (!element) break; const size = vint(bytes, cursor + element.length); if (!size) break;
				if (++elements > 8192 || ++this.elements > 1048576) throw new Error("WEBM_TIMING_LIMIT");
				const elementId = Number(element.value), length = element.length + size.length;
				if (this.stack.at(-1)?.id === id.cluster && this.stack.at(-1).end === null && topLevel.has(elementId)) this.stack.pop();
				const parent = this.stack.at(-1), end = size.unknown ? null : this.position + length + Number(size.value);
				if (!size.unknown && size.value > 134217728n || end !== null && (!Number.isSafeInteger(end) || parent?.end !== null && parent?.end !== undefined && end > parent.end)) throw new Error("WEBM_TIMING_FORMAT");
				if (!parent && elementId !== id.ebml && elementId !== id.segment || elementId === id.segment && (!this.header || this.segment) || elementId === id.ebml && this.position !== 0) throw new Error("WEBM_TIMING_FORMAT");
				cursor += length; this.position += length;
				if (masters.has(elementId)) {
					if ((parent?.id ?? null) !== masters.get(elementId) || this.stack.length >= 8 || size.unknown && ![id.segment, id.cluster].includes(elementId)) throw new Error("WEBM_TIMING_FORMAT");
					if (elementId === id.segment) this.segment = true;
					if (elementId === id.info) { if (this.info || this.frames) throw new Error("WEBM_TIMING_FORMAT"); this.info = true; }
					if (elementId === id.tracks) { if (this.tracks || this.frames) throw new Error("WEBM_TIMING_FORMAT"); this.tracks = true; }
					this.stack.push({ id: elementId, end, ...(elementId === id.group ? { cluster: parent } : {}) }); this.completeContainer();
				} else {
					if (size.unknown || !parent) throw new Error("WEBM_TIMING_FORMAT");
					this.pending = { id: elementId, size: Number(size.value), remaining: Number(size.value), head: Buffer.alloc(0), parent };
					if (!this.pending.remaining) { this.leaf(elementId, this.pending.head, 0, parent); this.pending = null; this.completeContainer(); }
				}
			}
			this.buffer = Buffer.from(bytes.subarray(cursor));
		} catch (error) { this.reason = /^WEBM_TIMING_[A-Z_]+$/.test(error?.message ?? "") ? error.message : "WEBM_TIMING_FORMAT"; this.buffer = Buffer.alloc(0); this.pending = null; this.stack = []; }
		return this.snapshot();
	}
	finish(complete = true) {
		if (complete && !this.reason && (this.buffer.length || this.pending || this.stack.some(container => container.end !== null && container.end !== this.position) || !this.frames)) this.reason = "WEBM_TIMING_INCOMPLETE";
		return this.snapshot();
	}
}
