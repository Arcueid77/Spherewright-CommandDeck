import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export const protectedProvider = (id) => typeof id === "string" && /^deckvault-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const digest = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const cleanText = (value, maximum) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
function validate(value) {
	if (!value || !protectedProvider(value.id) || !cleanText(value.label, 80) || !cleanText(value.modelId, 200) || !["openai-completions", "anthropic-messages"].includes(value.api)) throw new Error("INVALID_PROTECTED_PROFILE");
	let endpoint; try { endpoint = new URL(value.baseUrl); } catch { throw new Error("INVALID_PROFILE_ENDPOINT"); }
	if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.href.length > 2048) throw new Error("INVALID_PROFILE_ENDPOINT");
	if (endpoint.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("PROFILE_REMOTE_TLS_REQUIRED");
	if (!Number.isInteger(value.contextWindow) || value.contextWindow < 4096 || value.contextWindow > 2097152 || !Number.isInteger(value.maxTokens) || value.maxTokens < 128 || value.maxTokens > 131072 || value.maxTokens > value.contextWindow) throw new Error("INVALID_PROFILE_MODEL_LIMITS");
	if (typeof value.key !== "string" || value.key.length < 8 || value.key.length > 16384 || /[\x00-\x1f\x7f]/.test(value.key)) throw new Error("INVALID_PROFILE_CREDENTIAL");
	if ([value.id, value.label, value.modelId, value.baseUrl, value.api].some((item) => item.includes(value.key))) throw new Error("CREDENTIAL_IN_PROFILE_METADATA");
	return { id: value.id, label: value.label.trim(), api: value.api, baseUrl: endpoint.href.replace(/\/+$/, ""), modelId: value.modelId, contextWindow: value.contextWindow, maxTokens: value.maxTokens, key: value.key };
}
const metadata = (profile) => ({ providerId: profile.id, modelId: profile.modelId, label: profile.label, api: profile.api, source: "protected" });

// Main-process only. Entire profiles are authenticated ciphertext, including endpoint/credential binding.
export class CredentialVault {
	constructor(file, protection) { this.file = file; this.protection = protection; this.tail = Promise.resolve(); }
	available() { return this.protection.available() === true; }
	async bytes() {
		let info; try { info = await lstat(this.file); } catch (error) { if (error.code === "ENOENT") return null; throw new Error("PROTECTED_STORE_UNREADABLE"); }
		if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 1048576) throw new Error("PROTECTED_STORE_INVALID");
		return readFile(this.file);
	}
	async read() {
		if (!this.available()) throw new Error("PROTECTED_STORE_UNAVAILABLE");
		const bytes = await this.bytes();
		if (bytes === null) return { revision: null, profiles: [] };
		let data; try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("PROTECTED_STORE_INVALID"); }
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("PROTECTED_STORE_INVALID");
		if (data.version !== 1) throw new Error("PROTECTED_STORE_VERSION_UNSUPPORTED");
		if (!Array.isArray(data.entries) || data.entries.length > 16) throw new Error("PROTECTED_STORE_INVALID");
		const profiles = [], identifiers = new Set();
		for (const entry of data.entries) {
			if (!entry || !protectedProvider(entry.id) || identifiers.has(entry.id) || typeof entry.encrypted !== "string" || entry.encrypted.length > 131072) throw new Error("PROTECTED_STORE_INVALID");
			identifiers.add(entry.id);
			const sealed = Buffer.from(entry.encrypted, "base64");
			if (!sealed.length || sealed.toString("base64") !== entry.encrypted) throw new Error("PROTECTED_STORE_INVALID");
			let envelope; try { envelope = JSON.parse(await this.protection.decrypt(sealed)); } catch { throw new Error("PROTECTED_STORE_DECRYPT_FAILED"); }
			if (!envelope || envelope.version !== 1 || envelope.profile?.id !== entry.id) throw new Error("PROTECTED_PROFILE_BINDING_MISMATCH");
			try { profiles.push(validate(envelope.profile)); } catch { throw new Error("PROTECTED_STORE_INVALID"); }
		}
		return { revision: digest(bytes), profiles };
	}
	async list() { const value = await this.read(); return { available: true, revision: value.revision, profiles: value.profiles.map(metadata) }; }
	async describe(id) {
		const value = await this.read(), profile = value.profiles.find((entry) => entry.id === id);
		if (!profile) throw new Error("PROTECTED_PROFILE_NOT_FOUND");
		const { key, ...configuration } = profile;
		return { ...configuration, revision: value.revision, credentialPresent: true };
	}
	async resolve(id, modelId) {
		const profile = (await this.read()).profiles.find((entry) => entry.id === id && entry.modelId === modelId);
		if (!profile) throw new Error("PROTECTED_PROFILE_NOT_FOUND");
		return profile; // Only the utility runtime's internal credential channel can receive this value.
	}
	mutate(action) { const operation = this.tail.then(action); this.tail = operation.catch(() => {}); return operation; }
	save(input) {
		return this.mutate(async () => {
			if (!input || typeof input !== "object") throw new Error("INVALID_PROTECTED_PROFILE");
			const current = await this.read();
			if (input.expectedRevision !== current.revision) throw new Error("PROTECTED_STORE_CHANGED");
			const previous = current.profiles.find((entry) => entry.id === input.id);
			const value = validate({ ...input, key: input.apiKey === "" && previous ? previous.key : input.apiKey });
			if (current.profiles.some((entry) => entry.id !== value.id && entry.label.toLowerCase() === value.label.toLowerCase())) throw new Error("PROFILE_LABEL_ALREADY_EXISTS");
			const profiles = current.profiles.filter((entry) => entry.id !== value.id).concat(value);
			if (profiles.length > 16) throw new Error("TOO_MANY_PROTECTED_PROFILES");
			await this.write(profiles, current.revision);
			return this.list();
		});
	}
	remove({ id, expectedRevision }) {
		return this.mutate(async () => {
			const current = await this.read();
			if (expectedRevision !== current.revision) throw new Error("PROTECTED_STORE_CHANGED");
			if (!current.profiles.some((entry) => entry.id === id)) throw new Error("PROTECTED_PROFILE_NOT_FOUND");
			await this.write(current.profiles.filter((entry) => entry.id !== id), current.revision);
			return this.list();
		});
	}
	async write(profiles, expectedRevision) {
		const entries = [];
		for (const profile of profiles) {
			let encrypted; try { encrypted = await this.protection.encrypt(JSON.stringify({ version: 1, profile })); } catch { throw new Error("PROTECTED_STORE_ENCRYPT_FAILED"); }
			if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error("PROTECTED_STORE_ENCRYPT_FAILED");
			entries.push({ id: profile.id, encrypted: encrypted.toString("base64") });
		}
		const text = JSON.stringify({ version: 1, entries });
		if (Buffer.byteLength(text) > 1048576) throw new Error("PROTECTED_STORE_TOO_LARGE");
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = join(dirname(this.file), `.protected-profiles-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
			if (digest(await this.bytes()) !== expectedRevision) throw new Error("PROTECTED_STORE_CHANGED");
			await rename(temporary, this.file);
			if (digest(await this.bytes()) !== digest(Buffer.from(text))) throw new Error("PROTECTED_STORE_WRITE_UNCONFIRMED");
		} finally { try { await unlink(temporary); } catch {} }
	}
}
