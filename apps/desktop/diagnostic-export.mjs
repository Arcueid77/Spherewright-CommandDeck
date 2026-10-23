import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { buildDiagnosticReport, diagnosticLimits, diagnosticOptions } from "./diagnostic-snapshot.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => { const part = relative(root, path); return part === "" || !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep); };
const failed = code => new Error(code);
export async function readDiagnosticBuild(root, versions) {
	if (!versions.packaged) return { ...versions, sourceRevision: null, piCommit: null };
	try {
		const file = join(root, "../../commanddeck-bundle.json"), info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8388608) throw failed("INVALID_BUILD_METADATA");
		const data = JSON.parse(await readFile(file, "utf8"));
		if (data.version !== 1 || data.kind !== "commanddeck-windows-portable") throw failed("INVALID_BUILD_METADATA");
		return { ...versions, sourceRevision: data.sourceRevision, piCommit: data.piCommit };
	} catch { return { ...versions, sourceRevision: null, piCommit: null }; }
}
export async function writeNewDiagnostic(destination, bytes, protectedRoots = []) {
	if (typeof destination !== "string" || destination.length > 4096 || !isAbsolute(destination) || destination.includes("\0") || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > diagnosticLimits.bytes) throw failed("INVALID_DIAGNOSTIC_DESTINATION");
	const name = basename(destination);
	if (name.length > 240 || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) || extname(name).toLowerCase() !== ".json") throw failed("INVALID_DIAGNOSTIC_DESTINATION");
	let handle;
	try {
		const directory = await realpath(dirname(destination)), path = join(directory, name);
		for (const root of protectedRoots) if (inside(await realpath(root), path)) throw failed("DIAGNOSTIC_PROTECTED_DESTINATION");
		handle = await open(path, "wx+", 0o600); await handle.writeFile(bytes); await handle.sync();
		const actual = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
		if (!actual.isFile() || !named.isFile() || named.isSymbolicLink() || actual.nlink !== 1n || named.nlink !== 1n || actual.size !== BigInt(bytes.length) || actual.dev !== named.dev || actual.ino !== named.ino || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw failed("DIAGNOSTIC_WRITE_UNCONFIRMED");
		const verified = Buffer.alloc(bytes.length); let offset = 0;
		while (offset < verified.length) { const read = await handle.read(verified, offset, verified.length - offset, offset); if (!read.bytesRead) throw failed("DIAGNOSTIC_WRITE_UNCONFIRMED"); offset += read.bytesRead; }
		if (!verified.equals(bytes)) throw failed("DIAGNOSTIC_WRITE_UNCONFIRMED");
		return { saved: true, fileName: name, bytes: bytes.length, sha256: digest(bytes) };
	} catch (error) {
		if (["DIAGNOSTIC_PROTECTED_DESTINATION", "DIAGNOSTIC_WRITE_UNCONFIRMED"].includes(error?.message)) throw failed(error.message);
		throw failed(error?.code === "EEXIST" ? "DIAGNOSTIC_DESTINATION_EXISTS" : "DIAGNOSTIC_WRITE_FAILED");
	} finally { try { await handle?.close(); } catch { throw failed("DIAGNOSTIC_WRITE_UNCONFIRMED"); } }
}

// Preview and write capabilities never enter the exported report. A native
// picker chooses the destination; the renderer supplies only its preview ID.
export class DiagnosticExports {
	#preview = null; #grant = null; #capturing = false; #pending = new Set();
	constructor({ capture, isCurrent, protectedRoots = [], now = () => performance.now(), wallNow = () => Date.now(), write = writeNewDiagnostic, ttlMs = 300000 }) {
		if (typeof capture !== "function" || typeof isCurrent !== "function") throw failed("TRUSTED_DIAGNOSTIC_HOST_REQUIRED");
		this.capture = capture; this.isCurrent = isCurrent; this.protectedRoots = protectedRoots; this.now = now; this.wallNow = wallNow; this.write = write; this.ttlMs = ttlMs;
	}
	#scope(owner, generation) { if (!owner || !Number.isSafeInteger(generation) || generation <= 0 || !this.isCurrent(owner, generation)) throw failed("DIAGNOSTIC_UI_CHANGED"); }
	#match(owner, generation, id) {
		this.#scope(owner, generation); const value = this.#preview;
		if (typeof id !== "string" || id.length !== 36 || !value || value.owner !== owner || value.generation !== generation || value.id !== id) throw failed("DIAGNOSTIC_PREVIEW_REQUIRED");
		if (this.now() >= value.expiresAt) { this.#preview = null; this.#grant = null; throw failed("DIAGNOSTIC_PREVIEW_EXPIRED"); }
		return value;
	}
	async preview(owner, generation, options) {
		this.#scope(owner, generation);
		if (this.#capturing || this.#grant || this.#pending.size) throw failed("DIAGNOSTIC_BUSY");
		const selected = diagnosticOptions(options); this.#capturing = true; this.#preview = null;
		try {
			const snapshot = await this.capture(selected); this.#scope(owner, generation);
			const report = buildDiagnosticReport(snapshot, selected, { reportId: randomUUID(), generatedAt: new Date(this.wallNow()).toISOString() }), text = JSON.stringify(report, null, 2) + "\n", bytes = Buffer.from(text);
			if (bytes.length > diagnosticLimits.bytes) throw failed("DIAGNOSTIC_TOO_LARGE");
			const value = { id: randomUUID(), owner, generation, text, bytes, sha256: digest(bytes), expiresAt: this.now() + this.ttlMs, fileName: "CommandDeck-diagnostic-" + report.generatedAt.replace(/[-:.]/g, "").slice(0, 15) + "-" + report.reportId.slice(0, 8) + ".json" };
			this.#preview = value;
			return { id: value.id, text, sha256: value.sha256, bytes: bytes.length, expiresInMs: this.ttlMs, fileName: value.fileName };
		} finally { this.#capturing = false; }
	}
	beginSave(owner, generation, id) {
		const preview = this.#match(owner, generation, id);
		if (this.#grant || this.#capturing || this.#pending.size) throw failed("DIAGNOSTIC_BUSY");
		const grant = { id: randomUUID(), preview }; this.#grant = grant;
		return { grant: grant.id, fileName: preview.fileName, sha256: preview.sha256, bytes: preview.bytes.length };
	}
	cancelSave(owner, generation, id) {
		const grant = this.#grant;
		if (grant?.id === id && grant.preview.owner === owner && grant.preview.generation === generation) this.#grant = null;
		return { cancelled: true };
	}
	async save(owner, generation, id, destination) {
		const grant = this.#grant;
		if (!grant || grant.id !== id) throw failed("DIAGNOSTIC_PREVIEW_REQUIRED");
		const preview = this.#match(owner, generation, grant.preview.id);
		this.#grant = null; this.#preview = null;
		const pending = Promise.resolve().then(() => this.write(destination, preview.bytes, this.protectedRoots)); this.#pending.add(pending);
		try { return await pending; } finally { this.#pending.delete(pending); }
	}
	discard(owner, generation, id) {
		if (this.#preview?.owner === owner && this.#preview.generation === generation && this.#preview.id === id) { this.#preview = null; this.#grant = null; }
		return { discarded: true };
	}
	invalidate(owner) {
		if (this.#preview?.owner === owner) this.#preview = null;
		if (this.#grant?.preview.owner === owner) this.#grant = null;
	}
	async drain() { this.#preview = null; this.#grant = null; await Promise.allSettled([...this.#pending]); }
}
