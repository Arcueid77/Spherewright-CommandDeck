import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, stat, realpath, readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { devNull } from "node:os";

const execute = promisify(execFile);
const MAX_FILE = 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const blocked = /^(?:\.git|\.local|\.pi|node_modules|artifacts|userdata|dist|out|coverage|bin|obj|\.env(?:\..*)?|auth\.json|models\.json|.*(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini)|.*\.(?:pem|pfx|p12|key))$/i;
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
function safeRelative(value, directory = false) {
	if (directory && (value === "" || value === ".")) return "";
	if (typeof value !== "string" || value.length > 2048 || /[\x00-\x1f:]/.test(value) || isAbsolute(value)) throw new Error("INVALID_WORKSPACE_PATH");
	const parts = value.replaceAll("\\", "/").split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.trim() !== part || part.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("INVALID_WORKSPACE_PATH");
	if (parts.some((part) => blocked.test(part))) throw new Error("PRIVATE_WORKSPACE_PATH");
	return parts.join("/");
}
const permittedName = (value) => { try { safeRelative(value); return true; } catch { return false; } };
const within = (root, candidate) => { const name = relative(pathKey(root), pathKey(candidate)); return name === "" || (!name.startsWith(".." + sep) && name !== ".." && !isAbsolute(name)); };
const decode = (bytes) => { try { const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes("\0")) throw 0; return text; } catch { throw new Error("WORKSPACE_FILE_NOT_TEXT"); } };
let gitExecutable;
function trustedGit(cwd) {
	if (!gitExecutable) {
		// Resolve only explicit absolute PATH entries. Windows executable search otherwise checks repository cwd first.
		const search = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
		for (const directory of search.split(delimiter)) {
			if (!isAbsolute(directory)) continue;
			try {
				const candidate = realpathSync(join(directory, process.platform === "win32" ? "git.exe" : "git"));
				if (within(cwd, candidate) || !statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				gitExecutable = candidate;
				break;
			} catch {}
		}
	}
	if (!gitExecutable || within(cwd, gitExecutable)) throw new Error("TRUSTED_GIT_EXECUTABLE_UNAVAILABLE");
	return gitExecutable;
}

// Git reads must not activate repository fsmonitor, diff/textconv drivers, clean filters or a pager.
export async function readGit(cwd, args, { allowMissing = false, maxBuffer = 1024 * 1024 } = {}) {
	const executable = trustedGit(cwd);
	const env = { ...cleanEnvironment(), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
	const base = ["--no-pager", "--no-lazy-fetch", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.hooksPath=${devNull}`, "-c", `core.attributesFile=${devNull}`, "-c", "log.showSignature=false"];
	let keys = "";
	try { keys = (await execute(executable, [...base, "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], { cwd, env, windowsHide: true, timeout: 5000, maxBuffer: 65536 })).stdout; }
	catch (error) { if (error.code !== 1) { if (allowMissing) return null; throw new Error("WORKSPACE_GIT_CONFIGURATION_UNAVAILABLE"); } }
	const filters = [...new Set(keys.trim().split(/\r?\n/).filter(Boolean).map((key) => key.slice(7, key.lastIndexOf("."))))];
	if (filters.length > 64 || filters.some((name) => !/^[A-Za-z0-9_.-]{1,100}$/.test(name))) throw new Error("WORKSPACE_GIT_FILTER_CONFIGURATION_UNSUPPORTED");
	for (const name of filters) for (const operation of ["clean", "smudge", "process", "required"]) base.push("-c", `filter.${name}.${operation}=${operation === "required" ? "false" : ""}`);
	try { return (await execute(executable, [...base, ...args], { cwd, env, windowsHide: true, timeout: 10000, maxBuffer })).stdout; }
	catch { if (allowMissing) return null; throw new Error("WORKSPACE_GIT_READ_FAILED"); }
}
function parseStatus(text) {
	const values = text.split("\0"), changes = [];
	for (let index = 0; index < values.length; index++) {
		const entry = values[index]; if (!entry) continue;
		const code = entry.slice(0, 2), path = entry.slice(3).replaceAll("\\", "/");
		const originalPath = /[RC]/.test(code) ? values[++index] : undefined;
		if (permittedName(path)) changes.push({ path, code, ...(originalPath && permittedName(originalPath) ? { originalPath } : {}) });
	}
	return changes;
}

export class WorkspaceService {
	constructor(store) { this.store = store; this.index = new Map(); this.mutationTail = Promise.resolve(); }
	async register({ path, label, canWrite = false, canExecute = false }) {
		if (typeof path !== "string" || !isAbsolute(path) || typeof label !== "string" || !label.trim() || label.length > 80 || /[\x00-\x1f]/.test(label) || typeof canWrite !== "boolean" || typeof canExecute !== "boolean") throw new Error("INVALID_WORKSPACE_GRANT");
		const canonical = await realpath(path);
		if (!(await stat(canonical)).isDirectory()) throw new Error("WORKSPACE_DIRECTORY_REQUIRED");
		const top = (await readGit(canonical, ["rev-parse", "--show-toplevel"], { allowMissing: true }))?.trim();
		if (!top || pathKey(await realpath(top)) !== pathKey(canonical)) throw new Error("SELECT_GIT_REPOSITORY_ROOT");
		const previous = this.store.roots().find((root) => pathKey(root.path) === pathKey(canonical));
		const metadata = await this.inspect(canonical);
		metadata.protectedPaths = [...new Set([...(previous?.metadata.protectedPaths ?? []), ...metadata.dirtyPaths])];
		if (metadata.submodule) { canWrite = false; canExecute = false; }
		return this.store.upsertRoot({ pathKey: pathKey(canonical), path: canonical, label: label.trim(), canWrite, canExecute, metadata });
	}
	async inspect(path) {
		const [branch, sha, statusText, superproject] = await Promise.all([
			readGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowMissing: true }),
			readGit(path, ["rev-parse", "--verify", "HEAD"], { allowMissing: true }),
			readGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
			readGit(path, ["rev-parse", "--show-superproject-working-tree"], { allowMissing: true }),
		]);
		const changes = parseStatus(statusText);
		if (changes.length > 30000) throw new Error("WORKSPACE_STATUS_TOO_LARGE");
		return { branch: branch?.trim() || null, sha: sha?.trim() || null, detached: !branch?.trim() && Boolean(sha?.trim()), submodule: Boolean(superproject?.trim()), changes: changes.slice(0, 1000), dirtyPaths: [...new Set(changes.flatMap((change) => [change.path, change.originalPath].filter(Boolean)))], changesTruncated: changes.length > 1000, checkedAt: new Date().toISOString() };
	}
	root(id) {
		const root = this.store.root(id);
		if (!root.enabled) throw new Error("WORKSPACE_ROOT_DISABLED");
		return root;
	}
	async refresh(id) {
		const root = this.root(id);
		const metadata = await this.inspect(root.path);
		const dirty = new Set(metadata.dirtyPaths.map(pathKey));
		metadata.protectedPaths = (root.metadata.protectedPaths ?? []).filter((path) => dirty.has(pathKey(path)));
		this.index.delete(id);
		return this.store.updateRootMetadata(id, metadata);
	}
	async tracked(root) {
		const cached = this.index.get(root.id);
		if (cached && Date.now() - cached.time < 2000) return cached.files;
		const text = await readGit(root.path, ["ls-files", "--cached", "-z"], { maxBuffer: 2 * 1024 * 1024 });
		const files = new Set(text.split("\0").filter((path) => path && permittedName(path)));
		if (files.size > 30000) throw new Error("WORKSPACE_INDEX_TOO_LARGE");
		this.index.set(root.id, { files, time: Date.now() });
		return files;
	}
	async resolveFile(rootId, requested, { write = false, create = false, actor = "agent" } = {}) {
		const root = this.root(rootId), path = safeRelative(requested);
		if (write && (!root.canWrite || root.metadata.submodule)) throw new Error("WORKSPACE_WRITE_NOT_GRANTED");
		if (write && actor !== "user" && (root.metadata.protectedPaths ?? []).some((value) => pathKey(value) === pathKey(path))) throw new Error("EXISTING_USER_CHANGE_PROTECTED");
		const canonicalRoot = await realpath(root.path);
		if (pathKey(canonicalRoot) !== pathKey(root.path)) throw new Error("WORKSPACE_ROOT_CHANGED");
		let current = root.path, existingParent = root.path, missing = false;
		const parts = path.split("/");
		for (let index = 0; index < parts.length; index++) {
			current = join(current, parts[index]);
			let entry;
			try { entry = await lstat(current); } catch (error) { if (error.code !== "ENOENT") throw error; missing = true; }
			if (!entry) { if (!create) throw new Error("WORKSPACE_FILE_NOT_FOUND"); continue; }
			if (missing || entry.isSymbolicLink() || !within(root.path, await realpath(current))) throw new Error("WORKSPACE_LINK_OR_PATH_ESCAPE");
			if (index < parts.length - 1) {
				if (!entry.isDirectory()) throw new Error("WORKSPACE_DIRECTORY_REQUIRED");
				existingParent = current;
			} else if (!entry.isFile() || entry.nlink > 1) throw new Error("WORKSPACE_REGULAR_FILE_REQUIRED");
		}
		const repository = (await readGit(existingParent, ["rev-parse", "--show-toplevel"], { allowMissing: true }))?.trim();
		if (!repository || pathKey(await realpath(repository)) !== pathKey(root.path)) throw new Error("NESTED_REPOSITORY_REQUIRES_OWN_ROOT");
		return { root, path, absolute: current };
	}
	async assertReadable(root, path) {
		const tracked = await this.tracked(root);
		if (basename(path).toUpperCase() !== "AGENTS.MD" && !tracked.has(path) && !(process.platform === "win32" && [...tracked].some((value) => pathKey(value) === pathKey(path))) && !this.store.wasCreated(root.id, path)) throw new Error("UNTRACKED_FILE_NOT_APPROVED");
	}
	async assertTaskRevision(taskId, rootId) {
		const task = this.store.task(taskId), root = this.root(rootId);
		if (task.state !== "running" || task.rootId !== rootId) throw new Error("WORKSPACE_TASK_SCOPE_MISMATCH");
		const [branch, sha] = await Promise.all([
			readGit(root.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowMissing: true }),
			readGit(root.path, ["rev-parse", "--verify", "HEAD"], { allowMissing: true }),
		]);
		if ((branch?.trim() || null) !== task.scope.branch || (sha?.trim() || null) !== task.scope.sha) throw new Error("WORKSPACE_REVISION_CHANGED");
	}
	async list(rootId, directory = "") {
		const root = this.root(rootId), prefix = safeRelative(directory, true);
		const paths = new Set([...(await this.tracked(root)), ...this.store.createdPaths(rootId)]);
		const entries = new Map();
		for (const path of [...paths].sort()) {
			if (!permittedName(path) || (prefix && !path.startsWith(prefix + "/"))) continue;
			const suffix = prefix ? path.slice(prefix.length + 1) : path;
			if (!suffix) continue;
			const name = suffix.split("/")[0], child = prefix ? prefix + "/" + name : name;
			entries.set(child, { path: child, name, directory: suffix.includes("/"), protected: (root.metadata.protectedPaths ?? []).includes(child) });
		}
		return { rootId, directory: prefix, entries: [...entries.values()].slice(0, 300), truncated: entries.size > 300 };
	}
	async read(rootId, path, { startLine = 1, lineCount = 400 } = {}) {
		if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 1000) throw new Error("INVALID_FILE_LINE_RANGE");
		const file = await this.resolveFile(rootId, path);
		await this.assertReadable(file.root, file.path);
		const info = await stat(file.absolute);
		if (info.size > MAX_FILE) throw new Error("WORKSPACE_FILE_TOO_LARGE");
		const bytes = await readFile(file.absolute), text = decode(bytes), lines = text.split("\n");
		const selected = lines.slice(startLine - 1, startLine - 1 + lineCount).join("\n");
		if (selected.length > 65536) throw new Error("FILE_LINE_RANGE_TOO_LARGE");
		return { rootId, path: file.path, sha256: digest(bytes), text: selected, fullText: text, startLine, totalLines: lines.length, complete: startLine === 1 && lineCount >= lines.length, lineEnding: text.includes("\r\n") ? "crlf" : "lf", protected: (file.root.metadata.protectedPaths ?? []).includes(file.path) };
	}
	async rules(rootId, path = "") {
		const root = this.root(rootId), normalized = path ? safeRelative(path) : "";
		const dirs = [""], parts = normalized ? dirname(normalized).replaceAll("\\", "/").split("/").filter((part) => part && part !== ".") : [];
		for (let index = 0; index < parts.length; index++) dirs.push(parts.slice(0, index + 1).join("/"));
		const result = [];
		for (const directory of dirs) {
			const name = directory ? directory + "/AGENTS.md" : "AGENTS.md";
			try {
				const rule = await this.resolveFile(rootId, name);
				if ((await stat(rule.absolute)).size > 131072) throw new Error("WORKSPACE_RULES_TOO_LARGE");
				const bytes = await readFile(rule.absolute);
				result.push({ path: name, content: decode(bytes), sha256: digest(bytes) });
			} catch (error) { if (!/^(?:WORKSPACE_FILE_NOT_FOUND|UNTRACKED_FILE_NOT_APPROVED)$/.test(error.message)) throw error; }
		}
		return result;
	}
	async replace({ taskId, rootId, path, expectedSha256, oldText, newText, actor = "agent" }) {
		if (typeof oldText !== "string" || !oldText || oldText.length > 65536 || typeof newText !== "string" || newText.length > 65536) throw new Error("INVALID_EDIT_TEXT");
		const before = await this.read(rootId, path);
		if (before.sha256 !== expectedSha256) throw new Error("STALE_FILE_CONTENT");
		const position = before.fullText.indexOf(oldText);
		if (position < 0 || position !== before.fullText.lastIndexOf(oldText)) throw new Error("OLD_TEXT_MUST_MATCH_EXACTLY_ONCE");
		const replacement = before.lineEnding === "crlf" ? newText.replace(/\r?\n/g, "\r\n") : newText;
		return this.write({ taskId, rootId, path, expectedSha256, content: before.fullText.slice(0, position) + replacement + before.fullText.slice(position + oldText.length), actor });
	}
	write(args) {
		const operation = this.mutationTail.then(() => this.writeLocked(args));
		this.mutationTail = operation.catch(() => {});
		return operation;
	}
	async writeLocked({ taskId, rootId, path, expectedSha256, content, actor = "agent" }) {
		const task = this.store.task(taskId);
		if (task.state !== "running" || task.rootId !== rootId) throw new Error("WORKSPACE_TASK_SCOPE_MISMATCH");
		if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE || content.includes("\0")) throw new Error("INVALID_FILE_CONTENT");
		const create = expectedSha256 === null;
		if (!create && (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))) throw new Error("EXPECTED_FILE_HASH_REQUIRED");
		const file = await this.resolveFile(rootId, path, { write: true, create, actor });
		await this.assertTaskRevision(taskId, rootId);
		let before = null;
		let entry;
		try { entry = await stat(file.absolute); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (create && entry) throw new Error("FILE_ALREADY_EXISTS");
		if (entry && entry.size > MAX_FILE) throw new Error("WORKSPACE_FILE_TOO_LARGE");
		if (!create) {
			await this.assertReadable(file.root, file.path);
			if (entry) before = await readFile(file.absolute);
			if (before === null || digest(before) !== expectedSha256) throw new Error("STALE_FILE_CONTENT");
		}
		if (before?.length > MAX_FILE) throw new Error("WORKSPACE_FILE_TOO_LARGE");
		const beforeText = before === null ? null : decode(before);
		if (actor === "user" && beforeText?.includes("\r\n") && !beforeText.replaceAll("\r\n", "").includes("\n")) content = content.replace(/\r?\n/g, "\r\n");
		const bytes = Buffer.from(content, "utf8"), afterHash = digest(bytes);
		const changeId = this.store.prepareChange({ taskId, rootId, path: file.path, beforeText, beforeHash: before === null ? null : digest(before), afterText: content, afterHash });
		const temporary = join(dirname(file.absolute), `.commanddeck-${randomUUID()}.tmp`);
		let mutationStarted = false;
		try {
			await mkdir(dirname(file.absolute), { recursive: true });
			await this.resolveFile(rootId, path, { write: true, create, actor });
			await this.assertTaskRevision(taskId, rootId);
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
			await this.resolveFile(rootId, path, { write: true, create, actor });
			await this.assertTaskRevision(taskId, rootId);
			// Serialize Deck mutations and reject observed external drift. Rename is not an OS-level compare-and-swap.
			let latest = null;
			try { latest = await readFile(file.absolute); } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (create ? latest !== null : latest === null || digest(latest) !== expectedSha256) throw new Error("STALE_FILE_CONTENT");
			const currentRoot = this.root(rootId), currentTask = this.store.task(taskId);
			if (!currentRoot.canWrite || currentRoot.metadata.submodule) throw new Error("WORKSPACE_WRITE_NOT_GRANTED");
			if (currentTask.state !== "running" || currentTask.rootId !== rootId) throw new Error("WORKSPACE_TASK_SCOPE_MISMATCH");
			if (create) {
				// The exclusive target create prevents racing a new user file. Recovery retains the before-image intent.
				mutationStarted = true;
				const target = await open(file.absolute, "wx", 0o600);
				try { await target.writeFile(bytes); await target.sync(); } finally { await target.close(); }
				await unlink(temporary);
			} else { mutationStarted = true; await rename(temporary, file.absolute); }
			if (digest(await readFile(file.absolute)) !== afterHash) throw new Error("FILE_WRITE_READBACK_MISMATCH");
			this.store.finishChange(changeId, "applied");
			this.index.delete(rootId);
			return { changeId, rootId, path: file.path, sha256: afterHash, created: create };
		} catch (error) {
			this.store.finishChange(changeId, mutationStarted ? "unknown" : "failed");
			throw error;
		} finally { try { await unlink(temporary); } catch {} }
	}
	async diff(rootId, path) {
		const file = await this.resolveFile(rootId, path);
		await this.assertReadable(file.root, file.path);
		if (this.store.wasCreated(rootId, file.path) && !(await this.tracked(file.root)).has(file.path)) {
			const value = await this.read(rootId, file.path);
			return { path: file.path, text: `--- /dev/null\n+++ ${file.path}\n${value.fullText.split("\n").map((line) => "+" + line).join("\n")}`.slice(0, 131072) };
		}
		if (!file.root.metadata.sha) {
			const value = await this.read(rootId, file.path);
			return { path: file.path, text: `--- /dev/null\n+++ ${file.path}\n${value.fullText.split("\n").map((line) => "+" + line).join("\n")}`.slice(0, 131072) };
		}
		const text = await readGit(file.root.path, ["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { maxBuffer: 262144 });
		return { path: file.path, text };
	}
	async search(rootId, query, directory = "") {
		if (typeof query !== "string" || !query || query.length > 200) throw new Error("INVALID_SEARCH_QUERY");
		const root = this.root(rootId), prefix = safeRelative(directory, true), matches = [];
		let files = 0, bytes = 0, truncated = false;
		for (const path of await this.tracked(root)) {
			if (prefix && !path.startsWith(prefix + "/")) continue;
			if (++files > 200 || bytes > 2 * 1024 * 1024) { truncated = true; break; }
			let value;
			try { value = await this.read(rootId, path, { lineCount: 1000 }); } catch { continue; }
			bytes += Buffer.byteLength(value.fullText);
			for (const [index, line] of value.fullText.split("\n").entries()) if (line.includes(query)) {
				matches.push({ path, line: index + 1, text: line.slice(0, 500) });
				if (matches.length === 100) { truncated = true; break; }
			}
			if (truncated) break;
		}
		return { matches, truncated, filesScanned: files };
	}
}
