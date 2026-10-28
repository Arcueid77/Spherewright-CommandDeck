import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, realpath, stat, lstat, readdir } from "node:fs/promises";
import { join, dirname, basename, delimiter, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { developmentUsageText } from "../apps/desktop/development-usage-smoke.mjs";

const execute = promisify(execFile);
export const developmentGitHash = async executable => createHash("sha256").update(await readFile(executable)).digest("hex");
async function scope(directory) { assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase()); assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(directory).startsWith("commanddeck-desktop-smoke-")); }
export async function developmentWorkspaceState(directory) {
	await scope(directory); const base = join(directory, "development-usage-workspace"), pending = [base], files = []; let count = 0, bytes = 0;
	while (pending.length) {
		const parent = pending.pop(), info = await lstat(parent); assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
		for (const name of await readdir(parent)) {
			assert.ok(++count <= 256); const file = join(parent, name), entry = await lstat(file); assert.ok(!entry.isSymbolicLink()); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
			if (entry.isDirectory()) pending.push(file);
			else { assert.ok(entry.isFile() && entry.nlink === 1 && entry.size <= 2097152); assert.ok((bytes += entry.size) <= 10485760); files.push({ path: relative(base, file).replaceAll("\\", "/"), bytes: entry.size, sha256: await developmentGitHash(file) }); }
		}
	}
	return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function prepareDevelopmentUsageCase(directory) {
	await scope(directory);
	let git;
	const path = Object.entries(process.env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? "";
	for (const entry of path.split(delimiter).filter(isAbsolute)) { try { const file = await realpath(join(entry, "git.exe")); if ((await stat(file)).isFile()) { git = file; break; } } catch {} }
	assert.ok(git, "DEVELOPMENT_USAGE_GIT_REQUIRED");
	const workspace = join(directory, "development-usage-workspace"), empty = join(directory, "empty-git-config"), template = join(directory, "empty-git-template");
	await mkdir(workspace); await mkdir(template); await writeFile(empty, "", { flag: "wx" });
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
	Object.assign(env, { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
	const run = args => execute(git, ["-c", "core.hooksPath=" + template, "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 });
	await run(["init", "--template=" + template, "-b", "main", "-q"]); await writeFile(join(workspace, "fixture.txt"), developmentUsageText, { flag: "wx" });
	await run(["add", "--", "fixture.txt"]); await run(["-c", "user.name=CommandDeck fixture", "-c", "user.email=fixture@invalid.example", "commit", "-qm", "Synthetic development usage"]);
	const version = (await run(["--version"])).stdout.trim();
	return { git, gitDirectory: dirname(git), gitSha256: await developmentGitHash(git), gitVersion: version, workspace };
}
