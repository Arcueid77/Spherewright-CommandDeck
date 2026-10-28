import { WebmTiming } from "./webm-timing.mjs";
import { journalPrefixHash } from "./journal-evidence.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const timelineReasons = Object.freeze(["media_format_unsupported", "media_origin_unconfirmed", "journal_evidence_changed", "clock_unconfirmed"]);
export function validateVideoClock(value) {
	if (!value || Object.keys(value).sort().join(",") !== "elapsedMs,eventCount,journalId,prefixSha256,priorCount,priorSha256" || !uuid(value.journalId) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 2147483647 || !Number.isSafeInteger(value.eventCount) || value.eventCount < 1 || value.eventCount > 4096 || !Number.isSafeInteger(value.priorCount) || value.priorCount < 0 || value.priorCount > value.eventCount || !digest(value.prefixSha256) || !digest(value.priorSha256)) throw new Error("VIDEO_TIMELINE_CLOCK_INVALID");
	return value;
}
export class VideoTimeline {
	constructor(clock) {
		validateVideoClock(clock); if (clock.priorCount !== 0 || clock.priorSha256 !== journalPrefixHash(clock.journalId, [])) throw new Error("VIDEO_TIMELINE_CLOCK_INVALID");
		this.media = new WebmTiming(); this.value = { journalId: clock.journalId, originLowerMs: clock.elapsedMs, originUpperMs: null, sampledElapsedMs: clock.elapsedMs, mediaThroughMs: 0, frames: 0, eventCount: clock.eventCount, journalSha256: clock.prefixSha256, status: "pending", reason: null };
	}
	snapshot() { return { ...this.value }; }
	disable(reason) { Object.assign(this.value, { status: "unsupported", reason, originUpperMs: null, mediaThroughMs: 0, frames: 0 }); return this.snapshot(); }
	append(bytes, clock) {
		if (this.value.status === "unsupported") return this.snapshot();
		const media = this.media.push(bytes), value = this.value;
		if (clock !== null) {
			try { validateVideoClock(clock); } catch { return this.disable("clock_unconfirmed"); }
			if (clock.journalId !== value.journalId || clock.priorCount !== value.eventCount || clock.priorSha256 !== value.journalSha256) return this.disable("journal_evidence_changed");
			if (clock.elapsedMs < value.sampledElapsedMs) return this.disable("clock_unconfirmed");
			Object.assign(value, { sampledElapsedMs: clock.elapsedMs, eventCount: clock.eventCount, journalSha256: clock.prefixSha256 });
		}
		if (media.status === "unsupported") return this.disable("media_format_unsupported");
		if (media.frames) {
			if (media.firstMs !== 0) return this.disable("media_origin_unconfirmed");
			Object.assign(value, { mediaThroughMs: media.lastMs, frames: media.frames });
			if (clock !== null) {
				// Begin is sampled before the client creates its fresh encoder track.
				// Every complete frame in this chunk existed before host receipt. Add
				// two milliseconds for integer clock/container timestamp rounding.
				const upper = Math.ceil(clock.elapsedMs + 2 - media.lastMs);
				if (upper > 2147483647) return this.disable("clock_unconfirmed");
				value.originUpperMs = value.originUpperMs === null ? upper : Math.min(value.originUpperMs, upper);
				if (value.originUpperMs < value.originLowerMs) return this.disable("clock_unconfirmed"); value.status = "bounded";
			}
		}
		return this.snapshot();
	}
	finish(complete) { if (this.value.status !== "unsupported" && this.media.finish(complete).status === "unsupported") this.disable("media_format_unsupported"); return this.snapshot(); }
}
