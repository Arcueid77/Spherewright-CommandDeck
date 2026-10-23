import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { verifyRendererNotices, rendererNoticePackages } from "../scripts/renderer-notices.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-renderer-notices-"))), lock = { packages: {} }, sections = [];
	t.after(async () => { const canonical = await realpath(root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-renderer-notices-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	for (const name of rendererNoticePackages) {
		const directory = join(root, "node_modules", name), license = "Copyright fixture " + name + "\nFull permission and redistribution terms are retained.";
		await mkdir(directory, { recursive: true }); await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.2.3", license: "MIT" }));
		await writeFile(join(directory, name.startsWith("dockview") ? "LICENCE.md" : "LICENSE"), license.replaceAll("\n", "\r\n"));
		lock.packages["node_modules/" + name] = { version: "1.2.3" }; sections.push("## " + name + " - 1.2.3 (MIT)\n\n" + license);
	}
	const path = join(root, "THIRD-PARTY-LICENSES.md"), text = sections.join("\n\n"); await writeFile(path, text);
	return { root, lock, path, text };
}

test("renderer notices retain full source licenses with exact locked package versions, including British licence filenames", async t => {
	const { root, path, lock } = await fixture(t), value = await verifyRendererNotices(root, path, lock);
	assert.equal(value.packages.length, 5); assert.match(value.sha256, /^[a-f0-9]{64}$/); assert.equal(value.packages[0].name, "dockview-core");
	for (const pkg of value.packages) assert.match(pkg.sourceLicenseSha256, /^[a-f0-9]{64}$/);
});

test("package labels alone cannot replace complete license text and wrong dependency versions are rejected", async t => {
	const { root, path, lock, text } = await fixture(t);
	await writeFile(path, text.replace("Full permission and redistribution terms are retained.", "MIT"));
	await assert.rejects(verifyRendererNotices(root, path, lock), /COMPLETE_NOTICE_MISSING/); await writeFile(path, text);
	const altered = structuredClone(lock); altered.packages["node_modules/react"].version = "9.9.9";
	await assert.rejects(verifyRendererNotices(root, path, altered), /PACKAGE_PIN_MISMATCH/);
});

test("an absent or ambiguous source license is a build failure instead of a guessed notice", async t => {
	const { root, path, lock } = await fixture(t);
	await rm(join(root, "node_modules/react/LICENSE")); await assert.rejects(verifyRendererNotices(root, path, lock), /SOURCE_AMBIGUOUS/);
	await writeFile(join(root, "node_modules/react/LICENSE"), "source license"); await writeFile(join(root, "node_modules/react/LICENCE.md"), "other source");
	await assert.rejects(verifyRendererNotices(root, path, lock), /SOURCE_AMBIGUOUS/);
});
