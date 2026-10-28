import { createHash } from "node:crypto";
import { journalLimits, validateJournalPoint } from "./journal-format.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function journalEvent(value) {
	if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > journalLimits.events || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) throw new Error("JOURNAL_RECORD_INVALID");
	return { sequence: value.sequence, elapsedMs: value.elapsedMs, ...validateJournalPoint({ domain: value.domain, kind: value.kind, task: value.task, facts: value.facts }) };
}
export function journalEventHash(journalId, value) { if (!uuid(journalId)) throw new Error("JOURNAL_RECORD_INVALID"); return createHash("sha256").update(JSON.stringify({ journalId, event: journalEvent(value) })).digest("hex"); }
export function journalPrefixHash(journalId, values, count = values?.length) {
	if (!uuid(journalId) || !Array.isArray(values) || values.length > journalLimits.events || !Number.isSafeInteger(count) || count < 0 || count > values.length) throw new Error("JOURNAL_RECORD_INVALID");
	const events = values.slice(0, count).map(journalEvent); let elapsed = 0;
	for (let index = 0; index < events.length; index++) { if (events[index].sequence !== index + 1 || events[index].elapsedMs < elapsed) throw new Error("JOURNAL_RECORD_INVALID"); elapsed = events[index].elapsedMs; }
	return createHash("sha256").update(JSON.stringify({ journalId, events })).digest("hex");
}
