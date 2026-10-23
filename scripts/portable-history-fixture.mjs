import assert from "node:assert/strict";
import { mkdir, realpath, writeFile, lstat, readFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { historyHash, portableHistoryFile } from "../apps/desktop/portable-history.mjs";

export async function seedPortableHistory({ directory, bundle, runId }) {
	const canonical = await realpath(directory);
	assert.equal(canonical.toLowerCase(), directory.toLowerCase());
	assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
	assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-"));
	assert.match(runId, /^[a-f0-9-]{36}$/);
	const first = JSON.parse(await readFile(join(canonical, "application-proof.json"), "utf8"));
	assert.equal(first.runId, runId); assert.equal(first.emptyIsolatedWorkspace, true);
	const profile = await realpath(join(canonical, "supervisor-profile/supervisor"));
	assert.equal(profile.toLowerCase(), join(canonical, "supervisor-profile/supervisor").toLowerCase());
	assert.equal((await lstat(profile)).isSymbolicLink(), false);
	const moduleAt = name => import(pathToFileURL(join(bundle, "resources/app/apps/desktop", name)).href);
	const [{ Workbench }, { GameIntentLedger }, { nativeResearchStateHash }] = await Promise.all([moduleAt("workbench.mjs"), moduleAt("game-intent-ledger.mjs"), moduleAt("research-preview.mjs")]);
	const workbench = new Workbench({ directory: join(profile, "m1-smoke-" + runId), helperSource: join(bundle, "resources/app/artifacts/commands") });
	let ledger;
	try {
		assert.deepEqual(workbench.store.roots(), []); assert.deepEqual(workbench.store.tasks(), []);
		const workspacePath = join(canonical, "synthetic-disabled-workspace"); await mkdir(workspacePath);
		const root = workbench.store.upsertRoot({ pathKey: workspacePath.toLowerCase(), path: workspacePath, label: "Synthetic closed history", canWrite: false, canExecute: false, metadata: { branch: null, sha: null, submodule: false, fixtureOnly: true } });
		const task = workbench.store.createTask({ rootId: root.id, kind: "check", prompt: "Synthetic history; no command was executed." });
		workbench.store.setTaskState(task.id, "running");
		const invocation = workbench.store.beginInvocation(task.id, "workspace_check", { fixtureOnly: true, checkId: "synthetic-history-only" });
		const result = { fixtureOnly: true, exitCode: 0, executed: false };
		workbench.store.finishInvocation(invocation, { result }); workbench.store.event(task.id, "check-result", result);
		workbench.store.setResponse(task.id, "Synthetic result retained across application restart."); workbench.store.setTaskState(task.id, "succeeded", { result });
		workbench.store.setRootGrants(root.id, { enabled: false, canWrite: false, canExecute: false });
		workbench.store.saveUi("draft", { prompt: "Unsent synthetic draft " + runId, model: "" });
		const now = 100000, authority = {}, scope = { bridgeInstanceId: "synthetic-bridge-" + runId, sessionId: "synthetic-session-" + runId, planetId: 1, techId: 100, capturedAtGameTick: 1200, selectionStateHash: "sha256:" + "a".repeat(64) };
		const budget = [{ itemId: 1202, name: "Synthetic material", count: 10, direction: "research-consumption" }];
		const context = { ...scope, owned: true, accessRestricted: false, writeHealth: "healthy", observedAt: now, researchBudget: budget };
		const actionId = "synthetic-action-" + runId;
		ledger = new GameIntentLedger(join(profile, "game-smoke-" + runId, "game-tasks.sqlite"), { approvalAuthority: authority, now: () => now,
			prepareResearch: async request => ({ request, researchBudget: budget, plan: { prepared: true, actionKind: "select-research", planToken: "synthetic-private-plan-" + randomUUID(), expiresAtUtc: new Date(now + 30000).toISOString(), expectedStateHash: nativeResearchStateHash({ kind: "select-research", ...scope }), stateHashVersion: 1, researchQueueReadbackVersion: 1, commitAllowedNow: true, itemBudget: budget, commitBlockers: [] } }),
			readResearchProof: async request => ({ request, terminal: { actionId, actionKind: "select-research", sessionId: scope.sessionId, planetId: 1, idempotencyKey: ledger.intent(request.intentId).idempotencyKey, terminal: true, succeeded: true, state: "completed", completedAtGameTick: 1201, researchQueueReadback: { capturedAtGameTick: 1201, beforeQueue: [99], afterQueue: [99, 100], previousCurrentTechId: 99, currentTechId: 99, inventoryPreserved: true, researchProgressPreserved: true } }, freshProgression: { sessionId: scope.sessionId, planetId: 1, capturedAtGameTick: 1202, observedAt: now, selectionStateHash: "sha256:" + "b".repeat(64), techQueue: [99, 100] }, context: { ...context, gameTick: 1202, selectionStateHash: "sha256:" + "b".repeat(64) } }),
		});
		assert.deepEqual(ledger.tasks(), []); const gameTask = ledger.createResearchTask(scope);
		ledger.details(gameTask.id, { mode: "assist", techName: "Synthetic closed research", prompt: "Synthetic history only; no MCP or game transport.", provider: "synthetic", model: "fixture" });
		const review = await ledger.prepare(gameTask.id); ledger.approve(authority, gameTask.id, review.previewHash);
		const intent = ledger.beginIntent(gameTask.id, review.previewHash, context);
		ledger.accept(intent.intentId, { accepted: true, actionKind: "select-research", actionId, idempotencyKey: intent.idempotencyKey });
		await ledger.reconcile(intent.intentId); ledger.note(gameTask.id, "result", { text: "Synthetic completed receipt; zero real game calls." });
		assert.deepEqual(ledger.unresolved(), []);
		const state = workbench.state(), expected = { workbench: { roots: state.roots, tasks: state.tasks, task: await workbench.request("task", { taskId: task.id }), draft: workbench.store.ui("draft") }, game: { tasks: ledger.tasks(), events: ledger.events(gameTask.id) } };
		const value = { version: 1, kind: "closed-synthetic-history", runId, ...expected, sha256: historyHash(expected) };
		await writeFile(join(canonical, portableHistoryFile), JSON.stringify(value, null, 2), { flag: "wx" });
		return value;
	} finally { ledger?.close(); workbench.store.close(); }
}
