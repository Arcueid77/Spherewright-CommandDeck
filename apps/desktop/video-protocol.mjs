import { videoByteRange, videoPlaybackChunkBytes } from "./video-playback.mjs";

export const videoScheme = "deck-video";
const pattern = /^deck-video:\/\/stream\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
export function videoPlaybackUrl(grant) { const url = "deck-video://stream/" + grant; if (!pattern.test(url)) throw new Error("VIDEO_PLAYBACK_CHANGED"); return url; }

// The UI process has no archive path. It serves only a root-issued, current
// document grant through bounded encoded-media reads.
export function createVideoProtocol({ entries, generation, read }) {
	return async request => {
		const match = pattern.exec(request.url), state = match && entries.get(match[1]);
		if (!state || state.generation !== generation()) return new Response(null, { status: 410 });
		if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
		let range; try { range = videoByteRange(request.headers.get("range"), state.recording.bytes); }
		catch { return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + state.recording.bytes } }); }
		const headers = { "Content-Type": "video/webm", "Content-Length": String(range.length), "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" };
		if (range.status === 206) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${state.recording.bytes}`;
		let offset = range.start, cancelled = false;
		const stream = request.method === "HEAD" ? null : new ReadableStream({
			async pull(controller) {
				if (cancelled) return;
				if (offset > range.end) { controller.close(); return; }
				try {
					if (state.generation !== generation() || entries.get(match[1]) !== state) throw new Error("VIDEO_UI_CHANGED");
					const length = Math.min(videoPlaybackChunkBytes, range.end - offset + 1), reply = await read(match[1], state.generation, offset, length);
					if (cancelled) return;
					if (state.generation !== generation() || entries.get(match[1]) !== state || typeof reply.data !== "string" || reply.data.length > 87384) throw new Error("VIDEO_PLAYBACK_CHANGED");
					const bytes = Buffer.from(reply.data, "base64"); if (bytes.length !== length || reply.bytes !== length) throw new Error("VIDEO_PLAYBACK_UNCONFIRMED"); offset += length; controller.enqueue(bytes);
				} catch { cancelled = true; controller.error(new Error("VIDEO_PLAYBACK_UNAVAILABLE")); }
			},
			cancel() { cancelled = true; },
		});
		return new Response(stream, { status: range.status, headers });
	};
}
