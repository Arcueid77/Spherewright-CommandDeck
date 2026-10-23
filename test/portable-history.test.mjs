import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { seedPortableHistory } from "../scripts/portable-history-fixture.mjs";
import { readPortableHistory, assertPortableHistory, portableHistoryFile } from "../apps/desktop/portable-history.mjs";
import { assertPortableAction } from "../apps/desktop/portable-mode.mjs";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";

async function fixture(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID();
	t.after(async () => { const canonical = await realpath(directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	const bundle = join(directory, "bundle"), modules = join(bundle, "resources/app/apps/desktop"), profile = join(directory, "supervisor-profile/supervisor");
	await mkdir(modules, { recursive: true }); await mkdir(profile, { recursive: true });
	const source = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
	for (const file of await readdir(source, { withFileTypes: true })) if (file.isFile() && file.name.endsWith(".mjs")) await copyFile(join(source, file.name), join(modules, file.name));
	await writeFile(join(directory, "application-proof.json"), JSON.stringify({ runId, emptyIsolatedWorkspace: true }), { flag: "wx" });
	return { directory, bundle, runId, profile };
}

test("nonempty closed history survives new workbench/game coordinators without running tools or reacquiring a writer", async t => {
	const f = await fixture(t), expected = await seedPortableHistory(f);
	assert.equal((await readPortableHistory({ root: f.directory, runId: f.runId })).sha256, expected.sha256);
	for (let reopen = 0; reopen < 2; reopen++) {
		let unexpectedCalls = 0;
		const reject = () => { unexpectedCalls++; throw new Error("SYNTHETIC_REOPEN_MUST_NOT_EXECUTE"); };
		const workbench = new Workbench({ directory: join(f.profile, "m1-smoke-" + f.runId), helperSource: join(f.directory, "unused") });
		const game = new GameTasks({ directory: join(f.profile, "game-smoke-" + f.runId), bridge: {}, researchAuthority: {}, approvalAuthority: {}, freezeDevelopment: reject, releaseDevelopment: reject, planner: reject });
		try {
			await game.initialize();
			const api = async (action, args) => { assertPortableAction(action, args); return action === "workbench" ? workbench.request(args.action, args.args) : game.snapshot(); };
			const proof = await assertPortableHistory(api, expected); assert.equal(proof.draftPreserved, true); assert.equal(proof.unresolvedIntents, 0);
			assert.equal(unexpectedCalls, 0); assert.equal(game.currentTaskId, expected.game.tasks[0].id);
		} finally { game.ledger.close(); await workbench.close(); }
	}
});

test("history mismatches and another run's fixture cannot pass a reopen check", async t => {
	const f = await fixture(t), expected = await seedPortableHistory(f), context = { root: f.directory, runId: f.runId };
	await assert.rejects(readPortableHistory({ ...context, runId: randomUUID() }));
	const changed = structuredClone(expected); changed.workbench.draft.prompt = "replaced draft";
	await writeFile(join(f.directory, portableHistoryFile), JSON.stringify(changed)); await assert.rejects(readPortableHistory(context));
	await writeFile(join(f.directory, portableHistoryFile), JSON.stringify(expected));
	const api = async (action, args) => {
		if (action === "game") return { busy: false, developmentFrozen: false, unresolved: [], ...changed.game };
		if (args.action === "state") return { roots: changed.workbench.roots, tasks: changed.workbench.tasks, activeTask: null, executionBlocked: false };
		return args.action === "task" ? changed.workbench.task : changed.workbench.draft;
	};
	await assert.rejects(assertPortableHistory(api, expected), /PORTABLE_CLOSED_HISTORY_CHANGED/);
	for (const action of ["start", "save", "check", "add", "grants"]) assert.throws(() => assertPortableAction("workbench", { action }), /PORTABLE_SMOKE_ACTION_REJECTED/);
});
