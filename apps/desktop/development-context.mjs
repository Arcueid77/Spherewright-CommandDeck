import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const developmentCompactionSettings = Object.freeze({ enabled: false, reserveTokens: 2048, keepRecentTokens: 2048 });
export const developmentContextLimit = 16 * 1024 * 1024;
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const entryTypes = new Set(["message", "model_change", "thinking_level_change", "usage", "compaction", "branch_summary", "custom", "custom_message", "context_edit", "label", "session_info"]);
const invalid = (stage = "TRANSCRIPT") => new Error("DEVELOPMENT_CONTEXT_SOURCE_INVALID_" + stage);

function parseTranscript(bytes, cwd) {
	let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid(); }
	const lines = text.split(/\r?\n/); if (!lines.at(-1)) lines.pop();
	if (lines.length < 2 || lines.length > 65536 || lines.some(line => !line || line.length > 1048576)) throw invalid();
	let entries; try { entries = lines.map(line => JSON.parse(line)); } catch { throw invalid(); }
	const header = entries[0];
	if (header?.type !== "session" || header.version !== 3 || !uuid(header.id) || typeof header.cwd !== "string" || !samePath(resolve(header.cwd), resolve(cwd))) throw invalid("HEADER");
	const ids = new Set(); let messages = 0;
	for (const entry of entries.slice(1)) {
		if (!entry || !entryTypes.has(entry.type) || typeof entry.id !== "string" || !(/^[a-f0-9]{8}$/.test(entry.id) || uuid(entry.id)) || ids.has(entry.id) || entry.parentId !== null && !ids.has(entry.parentId)) throw invalid("ENTRY");
		ids.add(entry.id);
		if (entry.type === "message") { if (!entry.message || typeof entry.message.role !== "string") throw invalid(); messages++; }
		if (entry.type === "compaction" && (!ids.has(entry.firstKeptEntryId) || typeof entry.summary !== "string")) throw invalid();
		if (entry.type === "context_edit" && (entry.targetId === entry.id || !ids.has(entry.targetId) || entry.replacement !== null && (!entry.replacement || typeof entry.replacement !== "object" || !("content" in entry.replacement)))) throw invalid();
	}
	if (!messages) throw invalid(); return { entries, messages };
}

async function source(workbench, rootId, sourceTaskId) {
	if (!uuid(sourceTaskId)) throw invalid("TASK");
	const task = workbench.store.task(sourceTaskId, { privateFields: true }), root = workbench.workspace.root(rootId);
	if (task.kind !== "agent" || task.rootId !== rootId || !["succeeded", "failed", "cancelled", "interrupted"].includes(task.state) || task.result?.outcomeUnknown || !task.sessionFile) throw invalid("TASK");
	if (workbench.store.invocations(task.id).some(value => ["prepared", "unknown"].includes(value.state)) || workbench.store.changes(task.id).some(value => ["prepared", "unknown"].includes(value.state))) throw new Error("DEVELOPMENT_CONTEXT_OUTCOME_UNRESOLVED");
	const declaredBase = resolve(workbench.directory), base = await realpath(declaredBase), directory = join(base, "agent", task.id, "sessions"), registered = resolve(task.sessionFile);
	// Existing Windows profile roots can be aliases. Bind the exact registered
	// child path first, then read it beneath the canonical root; no child redirect is allowed.
	if ((!samePath(dirname(registered), join(declaredBase, "agent", task.id, "sessions")) && !samePath(dirname(registered), directory)) || !basename(registered).endsWith(".jsonl")) throw invalid("PATH");
	const file = join(directory, basename(registered));
	for (const path of [join(base, "agent"), join(base, "agent", task.id), directory]) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) throw invalid("DIRECTORY"); }
	const named = await lstat(file);
	if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > developmentContextLimit || !samePath(await realpath(file), file)) throw invalid("FILE");
	const handle = await open(file, "r"); let bytes;
	try {
		const first = await handle.stat(); if (first.ino !== named.ino || first.dev !== named.dev || first.size !== named.size || first.nlink !== 1) throw invalid("READ");
		const buffer = Buffer.alloc(first.size + 1); let offset = 0;
		while (offset < buffer.length) { const value = await handle.read(buffer, offset, buffer.length - offset, offset); if (!value.bytesRead) break; offset += value.bytesRead; }
		const after = await handle.stat(), current = await lstat(file);
		if (offset !== first.size || [after, current].some(info => !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.ino !== first.ino || info.dev !== first.dev || info.size !== first.size || info.mtimeMs !== first.mtimeMs || info.ctimeMs !== first.ctimeMs)) throw invalid("READ");
		bytes = buffer.subarray(0, offset);
	} finally { await handle.close(); }
	const parsed = parseTranscript(bytes, root.path);
	const { SessionManager } = await import("../../vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const { prepareCompaction } = await import("../../vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/index.js");
	const manager = SessionManager.inMemory(root.path, undefined, parsed.entries);
	return { bytes, preview: { version: 1, sourceTaskId: task.id, sourceSha256: createHash("sha256").update(bytes).digest("hex"), sourceBytes: bytes.length, messages: parsed.messages, canCompact: Boolean(prepareCompaction(manager.getBranch(), developmentCompactionSettings)) } };
}

export async function developmentContextInfo(workbench, rootId, sourceTaskId) { return (await source(workbench, rootId, sourceTaskId)).preview; }
export async function prepareDevelopmentContext(workbench, rootId, value) {
	if (!value || !["continue", "compact"].includes(value.mode) || !uuid(value.sourceTaskId) || !sha(value.sourceSha256) || Object.keys(value).some(key => !["mode", "sourceTaskId", "sourceSha256"].includes(key))) throw new Error("INVALID_DEVELOPMENT_CONTEXT_REQUEST");
	const { preview } = await source(workbench, rootId, value.sourceTaskId);
	if (preview.sourceSha256 !== value.sourceSha256) throw new Error("DEVELOPMENT_CONTEXT_SOURCE_CHANGED");
	if (value.mode === "compact" && !preview.canCompact) throw new Error("DEVELOPMENT_CONTEXT_TOO_SMALL_TO_COMPACT");
	return { version: 1, mode: value.mode, sourceTaskId: preview.sourceTaskId, sourceSha256: preview.sourceSha256, sourceBytes: preview.sourceBytes };
}

export async function createDevelopmentSession(workbench, task, directory, SessionManager) {
	const root = workbench.workspace.root(task.rootId), plan = task.scope.context;
	if (!plan) return SessionManager.create(root.path, join(directory, "sessions"));
	if (plan.version !== 1 || !["continue", "compact"].includes(plan.mode) || task.parentId !== plan.sourceTaskId) throw invalid();
	const current = await source(workbench, task.rootId, plan.sourceTaskId);
	if (current.preview.sourceSha256 !== plan.sourceSha256 || current.bytes.length !== plan.sourceBytes) throw new Error("DEVELOPMENT_CONTEXT_SOURCE_CHANGED");
	// Pi may repair/migrate a loaded file. It only receives this new task's exact copy.
	const copy = join(directory, "context-source.jsonl"); await writeFile(copy, current.bytes, { flag: "wx", mode: 0o600 });
	return SessionManager.forkFrom(copy, root.path, join(directory, "sessions"));
}
