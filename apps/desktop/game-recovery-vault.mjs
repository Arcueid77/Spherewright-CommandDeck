import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";

const hash = bytes => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
function validate(record) {
	if (!record || !/^[0-9a-f-]{36}$/.test(record.id ?? "") || !["ready", "pending", "used"].includes(record.state)
		|| !text(record.token) || !text(record.sourceSessionId) || !text(record.gameVersion)
		|| !Number.isSafeInteger(record.planetId) || record.planetId <= 0 || !Number.isSafeInteger(record.savedTick) || record.savedTick < 0
		|| !digest(record.cohortHash) || !digest(record.schemaHash) || !Number.isFinite(record.createdAt)
		|| record.worldLabel !== undefined && (!text(record.worldLabel) || record.worldLabel.length > 160)
		|| record.state === "pending" && !/^[0-9a-f-]{36}$/.test(record.pendingAttempt ?? "")
		|| record.cancelledBeforeDispatch !== undefined && (!Number.isSafeInteger(record.cancelledBeforeDispatch) || record.cancelledBeforeDispatch < 0)) throw new Error("GAME_RECOVERY_STORE_INVALID");
	return record;
}

// Only the main process can read this encrypted envelope. Native tickets and
// journals are never edited; a pending original is never silently reset.
export class GameRecoveryVault {
	constructor(file, protection, now = () => Date.now()) { this.file = file; this.protection = protection; this.now = now; this.tail = Promise.resolve(); }
	available() { return this.protection.available() === true; }
	async bytes() {
		let info; try { info = await lstat(this.file); } catch (error) { if (error.code === "ENOENT") return null; throw new Error("GAME_RECOVERY_STORE_UNREADABLE"); }
		if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 262144) throw new Error("GAME_RECOVERY_STORE_INVALID");
		return readFile(this.file);
	}
	async read() {
		if (!this.available()) throw new Error("GAME_RECOVERY_STORE_UNAVAILABLE");
		const bytes = await this.bytes(); if (bytes === null) return { revision: null, records: [] };
		let envelope, data;
		try {
			envelope = JSON.parse(bytes.toString("utf8"));
			if (envelope?.version !== 1 || typeof envelope.encrypted !== "string") throw new Error();
			const encrypted = Buffer.from(envelope.encrypted, "base64");
			if (!encrypted.length || encrypted.toString("base64") !== envelope.encrypted) throw new Error();
			data = JSON.parse(await this.protection.decrypt(encrypted));
		} catch { throw new Error("GAME_RECOVERY_STORE_INVALID"); }
		if (data?.version !== 1 || !Array.isArray(data.records) || data.records.length > 16) throw new Error("GAME_RECOVERY_STORE_INVALID");
		const records = data.records.map(validate);
		if (new Set(records.map(row => row.id)).size !== records.length) throw new Error("GAME_RECOVERY_STORE_INVALID");
		return { revision: hash(bytes), records };
	}
	async snapshot() {
		if (!this.available()) return { state: "unavailable" };
		const { records } = await this.read(), latest = records.at(-1);
		return latest ? { state: latest.state, id: latest.id, createdAt: latest.createdAt } : { state: "empty" };
	}
	mutate(action) { const operation = this.tail.then(action); this.tail = operation.catch(() => {}); return operation; }
	async write(records, revision) {
		let encrypted; try { encrypted = await this.protection.encrypt(JSON.stringify({ version: 1, records })); } catch { throw new Error("GAME_RECOVERY_STORE_ENCRYPT_FAILED"); }
		if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error("GAME_RECOVERY_STORE_ENCRYPT_FAILED");
		const bytes = Buffer.from(JSON.stringify({ version: 1, encrypted: encrypted.toString("base64") }));
		if (bytes.length > 262144) throw new Error("GAME_RECOVERY_STORE_LIMIT");
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = join(dirname(this.file), `.game-recovery-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
			if (hash(await this.bytes()) !== revision) throw new Error("GAME_RECOVERY_STORE_CHANGED");
			await rename(temporary, this.file);
			if (hash(await this.bytes()) !== hash(bytes)) throw new Error("GAME_RECOVERY_STORE_WRITE_UNCONFIRMED");
		} finally { try { await unlink(temporary); } catch {} }
	}
	save(candidate) { return this.mutate(async () => {
		const current = await this.read();
		if (current.records.some(row => row.state === "pending")) throw new Error("GAME_RECOVERY_ORIGINAL_PENDING");
		if (current.records.length >= 16) throw new Error("GAME_RECOVERY_STORE_LIMIT");
		const record = validate({ ...candidate, id: randomUUID(), state: "ready", createdAt: this.now() });
		await this.write([...current.records, record], current.revision); return { state: "ready", id: record.id, createdAt: record.createdAt };
	}); }
	peek(id) { return this.mutate(async () => {
		const current = await this.read(), record = current.records.at(-1);
		if (!record || record.id !== id || record.state !== "ready") throw new Error("GAME_RECOVERY_CANDIDATE_CHANGED");
		return { ...record };
	}); }
	transition(id, from, to, attemptId) { return this.mutate(async () => {
		const current = await this.read(), latest = current.records.at(-1);
		if (!latest || latest.id !== id || latest.state !== from || !((from === "ready" && to === "pending") || (from === "pending" && to === "used"))) throw new Error("GAME_RECOVERY_CANDIDATE_CHANGED");
		if (to === "pending" && !/^[0-9a-f-]{36}$/.test(attemptId ?? "")) throw new Error("GAME_RECOVERY_ATTEMPT_REQUIRED");
		const records = current.records.slice(); records[records.length - 1] = validate({ ...latest, state: to, ...(to === "pending" ? { pendingAttempt: attemptId } : {}) });
		await this.write(records, current.revision); return { state: to, id, createdAt: latest.createdAt };
	}); }
	cancelUnsent(id, attemptId) { return this.mutate(async () => {
		const current = await this.read(), latest = current.records.at(-1);
		if (!latest || latest.id !== id || latest.state !== "pending" || latest.pendingAttempt !== attemptId) throw new Error("GAME_RECOVERY_CANDIDATE_CHANGED");
		const records = current.records.slice(); records[records.length - 1] = validate({ ...latest, state: "ready", pendingAttempt: null, cancelledBeforeDispatch: (latest.cancelledBeforeDispatch ?? 0) + 1 });
		await this.write(records, current.revision); return { state: "ready", id, createdAt: latest.createdAt };
	}); }
}
