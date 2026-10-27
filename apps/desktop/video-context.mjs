import { createHash } from "node:crypto";
import { journalLimits, validateJournalPoint } from "./journal-format.mjs";

export const videoContextPageSize = 128;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function point(value) {
	if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > journalLimits.events || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) throw new Error("JOURNAL_RECORD_INVALID");
	return { sequence: value.sequence, elapsedMs: value.elapsedMs, ...validateJournalPoint({ domain: value.domain, kind: value.kind, task: value.task, facts: value.facts }) };
}
function journalFor(recording, readJournal) {
	if (recording.journalId === null) return { status: "none", events: [] };
	if (!uuid(recording.journalId) || typeof readJournal !== "function") return { status: "unavailable", events: [] };
	try {
		const journal = readJournal(recording.journalId);
		if (!journal || journal.executionAuthority !== false || journal.recording?.id !== recording.journalId || !Array.isArray(journal.events) || journal.events.length > journalLimits.events) throw new Error("JOURNAL_RECORD_INVALID");
		const events = journal.events.map(point); let elapsed = 0;
		for (let index = 0; index < events.length; index++) { if (events[index].sequence !== index + 1 || events[index].elapsedMs < elapsed) throw new Error("JOURNAL_RECORD_INVALID"); elapsed = events[index].elapsedMs; }
		return { status: "available", events };
	} catch (error) { return { status: error?.message === "JOURNAL_RECORDING_NOT_FOUND" ? "missing" : "unavailable", events: [] }; }
}
const pointHash = (journalId, event) => createHash("sha256").update(JSON.stringify({ journalId, event })).digest("hex");
const display = event => ({ sequence: event.sequence, elapsedMs: event.elapsedMs, domain: event.domain, kind: event.kind, task: event.task, state: event.facts.state, tool: event.facts.tool });

// An explicit browsing annotation. Media and event clocks remain independent;
// neither this relation nor its hash grants execution or approval authority.
export function videoRelation(recording, sequence, readJournal) {
	if (sequence === null) return null;
	if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > journalLimits.events) throw new Error("VIDEO_JOURNAL_EVENT_INVALID");
	const journal = journalFor(recording, readJournal), event = journal.events[sequence - 1];
	if (journal.status !== "available" || event?.sequence !== sequence) throw new Error("VIDEO_JOURNAL_EVENT_UNAVAILABLE");
	return { journalId: recording.journalId, sequence, pointSha256: pointHash(recording.journalId, event) };
}
export function videoContext(archive, id, readJournal, offset = 0) {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset >= journalLimits.events || offset % videoContextPageSize !== 0) throw new Error("VIDEO_CONTEXT_PAGE_INVALID");
	const annotations = archive.annotations(id), journal = journalFor(annotations.recording, readJournal);
	const bookmarks = annotations.bookmarks.map(bookmark => {
		if (bookmark.relation === null) return { ...bookmark, link: { status: "none", event: null } };
		const event = journal.events[bookmark.relation.sequence - 1];
		const status = journal.status !== "available" ? journal.status : !event ? "missing" : pointHash(bookmark.relation.journalId, event) !== bookmark.relation.pointSha256 ? "changed" : "matching";
		return { ...bookmark, link: { status, event: status === "matching" ? display(event) : null } };
	});
	return { ...annotations, bookmarks, journal: { status: journal.status, total: journal.events.length, offset, nextOffset: offset + videoContextPageSize < journal.events.length ? offset + videoContextPageSize : null, events: journal.events.slice(offset, offset + videoContextPageSize).map(display) } };
}
