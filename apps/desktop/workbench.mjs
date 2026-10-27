import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { WorkbenchStore } from "./workbench-store.mjs";
import { WorkspaceService } from "./workspace.mjs";
import { originalChangeDiff } from "./change-history.mjs";
import { prepareCommandHost, runManagedCommand } from "./command-host.mjs";
import { createHash } from "node:crypto";
import { captureWorkbenchDiagnostics } from "./diagnostic-snapshot.mjs";
import { journalFacts } from "./journal-format.mjs";

const codeOf = (error) => /^[A-Z0-9_]+$/.test(error?.message) ? error.message : "DEVELOPMENT_OPERATION_FAILED";
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const executableCache = new Map();
async function executable(name) {
	if (executableCache.has(name)) return executableCache.get(name);
	const search = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
	for (const directory of search.split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		try {
			const candidate = await realpath(join(directory, process.platform === "win32" ? name + ".exe" : name));
			if ((await stat(candidate)).isFile()) { executableCache.set(name, candidate); return candidate; }
		} catch {}
	}
	throw new Error("DEVELOPMENT_TOOLCHAIN_NOT_INSTALLED");
}

export class Workbench {
	constructor({ directory, helperSource, emit = () => {}, resolveProfile, onCommandHostSpawn }) {
		this.directory = directory; this.helperSource = helperSource; this.emit = emit;
		this.resolveProfile = resolveProfile; this.configurationBlocked = false;
		this.onCommandHostSpawn = onCommandHostSpawn;
		this.store = new WorkbenchStore(join(directory, "workbench.sqlite"));
		this.workspace = new WorkspaceService(this.store);
		this.store.recoverInterrupted();
		const unknown = this.store.unknownCommand();
		if (unknown) this.store.saveUi("execution-blocked", { reason: unknown.taskState === "interrupted" ? "INTERRUPTED_COMMAND_REQUIRES_RECONCILIATION" : "UNKNOWN_COMMAND_REQUIRES_RECONCILIATION", taskId: unknown.taskId });
		this.operation = null; this.closing = false; this.admissionGeneration = 0;
		// The trusted supervisor reserves this gate before a game task; renderer/model cannot toggle it.
		this.gameWritesFrozen = true;
	}
	notify(taskId, kind, value) {
		const sequence = this.store.event(taskId, kind, value);
		this.emit({ type: "workbench", taskId, sequence, kind, facts: journalFacts(value) });
	}
	state() {
		return {
			roots: this.store.roots().map((root) => {
				const { protectedPaths, dirtyPaths, ...metadata } = root.metadata;
				return { ...root, metadata: { ...metadata, dirtyCount: dirtyPaths?.length ?? 0, protectedCount: protectedPaths?.length ?? 0 } };
			}),
			tasks: this.store.tasks().map(({ response, prompt, ...task }) => ({ ...task, prompt: prompt.slice(0, 240) })),
			activeTask: this.store.activeTask()?.id ?? this.operation?.id ?? null,
			gameWriteAccess: this.gameWritesFrozen ? "not_connected" : "development_frozen", executionBlocked: !this.gameWritesFrozen || Boolean(this.store.ui("execution-blocked")),
		};
	}
	async add(args) {
		if (this.store.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING");
		await this.workspace.register(args, { beforeCommit: () => { if (this.operation || this.store.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING"); } });
		return this.state();
	}
	async catalog(rootId) {
		const root = this.workspace.root(rootId), files = await this.workspace.tracked(root), checks = [];
		if (files.has("package.json")) {
			const value = await this.workspace.read(rootId, "package.json");
			let packageFile; try { packageFile = JSON.parse(value.fullText); } catch { throw new Error("INVALID_PACKAGE_MANIFEST"); }
			for (const name of ["typecheck", "test", "build", "lint"]) if (typeof packageFile.scripts?.[name] === "string") checks.push({ id: `npm:${name}`, label: `npm run ${name}`, type: "npm", name });
		}
		for (const path of [...files].filter((path) => /\.(?:sln|slnx)$/i.test(path)).slice(0, 8)) checks.push({ id: `dotnet-build:${path}`, label: `构建 ${path}`, type: "dotnet-build", path });
		for (const path of [...files].filter((path) => /(?:tests?|specs?)[^/]*\.csproj$/i.test(path)).slice(0, 16)) checks.push({ id: `dotnet-test:${path}`, label: `测试 ${path}`, type: "dotnet-test", path });
		return checks;
	}
	async command(rootId, checkId) {
		const root = this.workspace.root(rootId);
		if (!root.canExecute || root.metadata.submodule) throw new Error("WORKSPACE_EXECUTION_NOT_GRANTED");
		if (!this.gameWritesFrozen || this.store.ui("execution-blocked")) throw new Error("DEVELOPMENT_EXECUTION_BLOCKED");
		const check = (await this.catalog(rootId)).find((entry) => entry.id === checkId);
		if (!check) throw new Error("UNKNOWN_WORKSPACE_CHECK");
		let program, args;
		if (check.type === "npm") {
			program = await executable("node");
			const cli = await realpath(join(dirname(program), "node_modules/npm/bin/npm-cli.js"));
			args = [cli, "run", check.name];
		} else {
			await this.workspace.resolveFile(rootId, check.path);
			program = await executable("dotnet");
			args = [check.type === "dotnet-test" ? "test" : "build", check.path, "--no-restore", "--nologo"];
		}
		// A PATH entry inside any approved repository is not a trusted toolchain installation.
		for (const member of this.store.roots()) {
			const parent = member.path.toLowerCase().replaceAll("\\", "/") + "/", candidate = program.toLowerCase().replaceAll("\\", "/");
			if (candidate.startsWith(parent)) throw new Error("WORKSPACE_LOCAL_TOOLCHAIN_NOT_ALLOWED");
		}
		return { executable: program, args, cwd: root.path, label: check.label };
	}
	async start({ rootId, kind, prompt = "", provider, model, parentId }, action) {
		if (this.closing) throw new Error("WORKBENCH_CLOSING");
		if (!this.gameWritesFrozen) throw new Error("GAME_EXECUTION_OWNS_RUNTIME");
		if (this.configurationBlocked) throw new Error("MODEL_CONFIGURATION_BUSY");
		if (kind === "agent" && this.store.ui("execution-blocked")) throw new Error("DEVELOPMENT_EXECUTION_BLOCKED");
		if (this.operation || this.store.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING");
		const generation = this.admissionGeneration;
		await this.workspace.refresh(rootId);
		if (this.closing || generation !== this.admissionGeneration) throw new Error("WORKBENCH_ADMISSION_EXPIRED");
		if (!this.gameWritesFrozen) throw new Error("GAME_EXECUTION_OWNS_RUNTIME");
		if (this.configurationBlocked) throw new Error("MODEL_CONFIGURATION_BUSY");
		if (kind === "agent" && this.store.ui("execution-blocked")) throw new Error("DEVELOPMENT_EXECUTION_BLOCKED");
		if (this.operation || this.store.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING");
		if (kind === "agent") {
			this.workspace.protectCurrentChanges(rootId);
		}
		const task = this.store.createTask({ rootId, kind, prompt, provider, model, parentId });
		const controller = new AbortController();
		this.store.setTaskState(task.id, "running");
		// Install the running operation synchronously before allowing another request to start.
		const operation = { id: task.id, controller, done: null };
		this.operation = operation;
		let timedOut = false;
		let recordedOutcome = journalFacts({});
		const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 300000);
		operation.done = Promise.resolve().then(async () => {
			try {
				const result = await action(task, controller.signal);
				this.store.setTaskState(task.id, timedOut ? "failed" : controller.signal.aborted ? "cancelled" : "succeeded", { result, error: timedOut ? "TASK_TIME_LIMIT" : null });
				recordedOutcome = journalFacts({ state: timedOut ? "failed" : controller.signal.aborted ? "cancelled" : "succeeded", error: timedOut ? "TASK_TIME_LIMIT" : null });
			} catch (error) {
				this.store.setTaskState(task.id, controller.signal.aborted && !timedOut && !error.unknown ? "cancelled" : "failed", { error: timedOut ? "TASK_TIME_LIMIT" : codeOf(error), result: { outcomeUnknown: error.unknown === true } });
				recordedOutcome = journalFacts({ state: controller.signal.aborted && !timedOut && !error.unknown ? "cancelled" : "failed", error: timedOut ? "TASK_TIME_LIMIT" : codeOf(error) });
			} finally {
				clearTimeout(deadline);
				try { await this.workspace.refresh(rootId); } catch {}
				this.operation = null;
				this.emit({ type: "workbench", taskId: task.id, kind: "settled", facts: recordedOutcome });
			}
		});
		this.emit({ type: "workbench", taskId: task.id, kind: "started", facts: journalFacts({ state: "running" }) });
		return task;
	}
	async invokeCheck(task, checkId, signal) {
		await this.workspace.assertTaskRevision(task.id, task.rootId);
		const command = await this.command(task.rootId, checkId);
		const host = await prepareCommandHost(this.helperSource, join(this.directory, "command-hosts"));
		if (signal.aborted) throw new Error("COMMAND_CANCELLED_BEFORE_START");
		await this.workspace.assertTaskRevision(task.id, task.rootId);
		const current = this.workspace.root(task.rootId);
		if (!current.canExecute || current.metadata.submodule) throw new Error("WORKSPACE_EXECUTION_NOT_GRANTED");
		if (!this.gameWritesFrozen || this.store.ui("execution-blocked")) throw new Error("DEVELOPMENT_EXECUTION_BLOCKED");
		if (signal.aborted) throw new Error("COMMAND_CANCELLED_BEFORE_START");
		const invocation = this.store.beginInvocation(task.id, "workspace_check", { checkId, label: command.label, helper: host.identity });
		try {
			const result = await runManagedCommand({ ...command, host: host.executable, signal, onOutput: (value) => this.notify(task.id, "command-output", value), onHostSpawn: child => this.onCommandHostSpawn?.({ child, taskId: task.id, host: host.executable }) });
			this.store.finishInvocation(invocation, { result, error: result.exitCode !== 0 || result.reason !== "exited" ? "CHECK_DID_NOT_PASS" : null });
			this.notify(task.id, "check-result", { checkId, ...result });
			if (result.exitCode !== 0 || result.reason !== "exited") throw new Error(result.reason === "timeout" ? "CHECK_TIMED_OUT" : "CHECK_DID_NOT_PASS");
			return { checkId, ...result };
		} catch (error) {
			this.store.finishInvocation(invocation, { error: codeOf(error), unknown: error.unknown === true, result: error.diagnostic ?? null });
			if (error.unknown) this.store.saveUi("execution-blocked", { reason: codeOf(error), taskId: task.id });
			throw error;
		}
	}
	async request(action, args = {}) {
		if (!record(args)) throw new Error("INVALID_WORKBENCH_REQUEST");
		if (this.closing) throw new Error("WORKBENCH_CLOSING");
		if (action === "state") return this.state();
		if (action === "diagnostics") return captureWorkbenchDiagnostics(this.store, { active: Boolean(this.operation || this.store.activeTask()), executionBlocked: !this.gameWritesFrozen || Boolean(this.store.ui("execution-blocked")), configurationBlocked: this.configurationBlocked });
		if (action === "add") return this.add(args);
		if (action === "refresh") { await this.workspace.refresh(args.rootId); return this.state(); }
		if (action === "grants") {
			if (this.store.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING");
			const root = await this.workspace.refresh(args.rootId);
			if (this.operation || this.store.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING");
			if (typeof args.canWrite !== "boolean" || typeof args.canExecute !== "boolean" || root.metadata.submodule && (args.canWrite || args.canExecute)) throw new Error("INVALID_WORKSPACE_GRANT");
			this.store.setRootGrants(root.id, { canWrite: args.canWrite, canExecute: args.canExecute });
			return this.state();
		}
		if (action === "list") return this.workspace.list(args.rootId, args.directory);
		if (action === "read") return this.workspace.read(args.rootId, args.path, { lineCount: 1000 });
		if (action === "diff") return this.workspace.diff(args.rootId, args.path);
		if (action === "change-diff") {
			const task = this.store.task(args.taskId), root = this.workspace.root(task.rootId);
			const change = this.store.changes(task.id).find(value => value.id === args.changeId);
			return originalChangeDiff({ directory: join(this.directory, "history"), root, task, change });
		}
		if (action === "attach-reference") {
			const available = () => { if (this.closing || !this.gameWritesFrozen || this.operation || this.store.activeTask()) throw new Error("REFERENCE_ATTACHMENT_BUSY"); };
			available();
			const generation = this.admissionGeneration, task = this.store.task(args.taskId);
			if (!["succeeded", "failed", "cancelled", "interrupted"].includes(task.state)) throw new Error("REFERENCE_REQUIRES_SETTLED_TASK");
			this.workspace.root(task.rootId);
			if (typeof args.label !== "string" || !args.label.trim() || args.label.length > 80 || /[\x00-\x1f]/.test(args.label)) throw new Error("INVALID_REFERENCE_LABEL");
			const target = await this.workspace.refresh(args.rootId);
			if (args.revision !== target.metadata.sha) throw new Error("REFERENCE_REVISION_CHANGED");
			const file = await this.workspace.readAtRevision(target.id, args.revision, args.path);
			available();
			if (generation !== this.admissionGeneration) throw new Error("REFERENCE_ATTACHMENT_EXPIRED");
			this.workspace.root(target.id);
			return this.store.attachReference(task.id, { rootId: target.id, path: file.path, revision: file.revision, sha256: file.sha256, label: args.label.trim() });
		}
		if (action === "read-reference") {
			const task = this.store.task(args.taskId); this.workspace.root(task.rootId);
			const reference = this.store.references(task.id).find(value => value.id === args.referenceId);
			if (!reference) throw new Error("TASK_REFERENCE_NOT_FOUND");
			const file = await this.workspace.readAtRevision(reference.rootId, reference.revision, reference.path);
			if (file.sha256 !== reference.sha256) throw new Error("TASK_REFERENCE_CONTENT_CHANGED");
			return { ...file, referenceId: reference.id, taskId: task.id, label: reference.label };
		}
		if (action === "search") return this.workspace.search(args.rootId, args.query, args.directory);
		if (action === "checks") return this.catalog(args.rootId);
		if (action === "save") return this.start({ rootId: args.rootId, kind: "edit", prompt: `保存 ${args.path}` }, (task) => this.workspace.write({ taskId: task.id, rootId: task.rootId, path: args.path, expectedSha256: args.expectedSha256, content: args.content, actor: "user" }));
		if (action === "revert") {
			const source = this.store.task(args.sourceTaskId), original = this.store.changes(source.id).find((change) => change.id === args.changeId);
			if (["queued", "running", "cancelling", "interrupted"].includes(source.state) || !original || original.state !== "applied") throw new Error("CHANGE_NOT_REVERTIBLE");
			return this.start({ rootId: original.rootId, kind: "revert", prompt: `撤回 ${original.path}`, parentId: source.id }, async (task) => {
				if (original.beforeText === null) return this.workspace.removeCreated({ taskId: task.id, rootId: task.rootId, original });
				if (createHash("sha256").update(original.beforeText, "utf8").digest("hex") !== original.beforeHash) throw new Error("FILE_BEFORE_IMAGE_INVALID");
				const result = await this.workspace.write({ taskId: task.id, rootId: task.rootId, path: original.path, expectedSha256: original.afterHash, content: original.beforeText, actor: "user", normalizeUserLineEndings: false });
				if (result.sha256 !== original.beforeHash) { this.store.finishChange(original.id, "unknown"); const error = new Error("FILE_REVERT_HASH_MISMATCH"); error.unknown = true; throw error; }
				this.store.finishChange(original.id, "reverted"); return result;
			});
		}
		if (action === "check") return this.start({ rootId: args.rootId, kind: "check", prompt: args.checkId }, (task, signal) => this.invokeCheck(task, args.checkId, signal));
		if (action === "task") {
			const task = this.store.task(args.taskId);
			return { ...task, invocations: this.store.invocations(task.id), changes: this.store.changes(task.id).map(({ beforeText, afterText, ...change }) => change), references: this.store.references(task.id), events: this.store.events(task.id, args.after ?? 0) };
		}
		if (action === "cancel") {
			if (this.operation?.id !== args.taskId) throw new Error("TASK_NOT_RUNNING");
			if (this.store.task(args.taskId).state === "running") this.store.setTaskState(args.taskId, "cancelling");
			this.operation.controller.abort();
			return { requested: true };
		}
		if (action === "ui-get") { if (!["layout", "selection", "draft", "editor"].includes(args.key)) throw new Error("INVALID_UI_STATE_KEY"); return this.store.ui(args.key); }
		if (action === "ui-save") { if (!["layout", "selection", "draft", "editor"].includes(args.key)) throw new Error("INVALID_UI_STATE_KEY"); this.store.saveUi(args.key, args.value); return { saved: true }; }
		if (action === "agent") {
			const { runDevelopmentAgent } = await import("./development-agent.mjs");
			return this.start({ rootId: args.rootId, kind: "agent", prompt: args.prompt, provider: args.providerId, model: args.modelId, parentId: args.parentId }, (task, signal) => runDevelopmentAgent({ workbench: this, task, signal }));
		}
		throw new Error("UNKNOWN_WORKBENCH_ACTION");
	}
	async drain() {
		this.closing = true;
		this.admissionGeneration++;
		if (this.operation) { this.operation.controller.abort(); await this.operation.done; }
		await this.workspace.mutationTail;
		return { drained: true };
	}
	async close() {
		await this.drain();
		this.store.close();
	}
}
