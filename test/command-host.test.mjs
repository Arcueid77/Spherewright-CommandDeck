import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { prepareCommandHost, runManagedCommand } from "../apps/desktop/command-host.mjs";

const source = fileURLToPath(new URL("../artifacts/commands", import.meta.url));
async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-command-"));
	t.after(async () => {
		const absolute = await realpath(resolve(directory));
		assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
		assert.ok(basename(absolute).startsWith("commanddeck-command-"));
		await rm(absolute, { recursive: true, force: true });
	});
	const host = await prepareCommandHost(source, join(directory, "helpers"));
	return { directory, host: host.executable };
}
const windows = { skip: process.platform !== "win32" };

test("managed commands retain their own exit code and child output cannot forge control replies", windows, async (t) => {
	const f = await fixture(t), output = [];
	const result = await runManagedCommand({ ...f, cwd: f.directory, executable: process.execPath, args: ["-e", "console.log(JSON.stringify({type:'result',exitCode:0}));console.error('fixture stderr');process.exitCode=17"], onOutput: (item) => output.push(item) });
	assert.equal(result.exitCode, 17); assert.equal(result.treeConfirmed, true);
	assert.match(output.map((item) => item.text).join(""), /fixture stderr/);
});

test("cancellation and timeout confirm the normal command tree has ended", windows, async (t) => {
	const f = await fixture(t), controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 800);
	try {
		const cancelled = await runManagedCommand({ ...f, cwd: f.directory, executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], signal: controller.signal });
		assert.equal(cancelled.reason, "cancelled"); assert.equal(cancelled.treeConfirmed, true);
	} finally { clearTimeout(timer); }
	const timeout = await runManagedCommand({ ...f, cwd: f.directory, executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 300 });
	assert.equal(timeout.reason, "timeout"); assert.equal(timeout.treeConfirmed, true);
});

test("a successful root does not leave a normal detached descendant behind", windows, async (t) => {
	const f = await fixture(t), marker = join(f.directory, "heartbeat.txt");
	const script = "require('node:fs').appendFileSync(process.argv[1],'x');setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),50)";
	const root = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{detached:true,stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),400)";
	const result = await runManagedCommand({ ...f, cwd: f.directory, executable: process.execPath, args: ["-e", root, script, marker] });
	assert.equal(result.exitCode, 0); assert.equal(result.treeConfirmed, true);
	const before = await readFile(marker, "utf8");
	await new Promise((done) => setTimeout(done, 200));
	assert.equal(await readFile(marker, "utf8"), before);
});

test("retained output is bounded while both pipes continue to drain", windows, async (t) => {
	const f = await fixture(t); let length = 0;
	const result = await runManagedCommand({ ...f, cwd: f.directory, executable: process.execPath, args: ["-e", "process.stdout.write('o'.repeat(600000));process.stderr.write('e'.repeat(600000))"], onOutput: ({ text }) => { length += text.length; } });
	assert.equal(result.exitCode, 0); assert.equal(result.outputTruncated, true);
	assert.ok(length <= 262144); assert.equal(result.streamsDrained, true);
});

test("control EOF cancels a command and is not inherited by the child", windows, async (t) => {
	const f = await fixture(t), child = spawn(f.host, [], { cwd: f.directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	const output = []; child.stdout.on("data", (chunk) => output.push(chunk)); child.stderr.on("data", () => {});
	child.stdin.end(JSON.stringify({ executable: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"], directory: f.directory, timeoutMs: 2000 }) + "\n");
	const [code] = await once(child, "close");
	assert.equal(code, 0);
	const result = Buffer.concat(output).toString("utf8").split("\n").filter(Boolean).map(JSON.parse).find((item) => item.type === "result");
	assert.equal(result.reason, "cancelled"); assert.equal(result.treeConfirmed, true);
});

test("helper loss closes its job and ends its own ordinary descendants", windows, async (t) => {
	const f = await fixture(t), marker = join(f.directory, "helper-loss.txt");
	await writeFile(marker, "");
	const child = spawn(f.host, [], { cwd: f.directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	child.stderr.on("data", () => {});
	const started = new Promise((done) => child.stdout.on("data", (chunk) => { if (chunk.toString().includes('"type":"started"')) done(); }));
	child.stdin.write(JSON.stringify({ executable: process.execPath, arguments: ["-e", "setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),50)", marker], directory: f.directory, timeoutMs: 3000 }) + "\n");
	await started;
	await new Promise((done) => setTimeout(done, 250));
	child.kill(); // Only this test's creation handle; no adopted PID or game process.
	await once(child, "close");
	await new Promise((done) => setTimeout(done, 100));
	const before = await readFile(marker, "utf8");
	assert.ok(before.length > 0);
	await new Promise((done) => setTimeout(done, 200));
	assert.equal(await readFile(marker, "utf8"), before);
});

test("helper loss after creation but before Resume cannot orphan a suspended root", windows, async (t) => {
	const f = await fixture(t), child = spawn(f.host, ["--fixture-hold-before-resume"], { cwd: f.directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	child.stderr.on("data", () => {});
	const created = new Promise((done) => {
		let buffer = "";
		child.stdout.on("data", (chunk) => { buffer += chunk.toString(); const line = buffer.split("\n")[0]; if (buffer.includes("\n")) done(JSON.parse(line)); });
	});
	child.stdin.write(JSON.stringify({ executable: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"], directory: f.directory, timeoutMs: 3000 }) + "\n");
	const processRecord = await created;
	assert.equal(processRecord.type, "created"); assert.equal(processRecord.inJob, true);
	assert.equal(child.exitCode, null);
	assert.equal(child.kill(), true); await once(child, "close");
	await new Promise((done) => setTimeout(done, 100));
	assert.throws(() => process.kill(processRecord.pid, 0), { code: "ESRCH" });
});

test("missing helper receipt reports unknown and never a successful command", windows, async (t) => {
	const f = await fixture(t);
	await assert.rejects(runManagedCommand({ ...f, host: join(f.directory, "missing.exe"), cwd: f.directory, executable: process.execPath }), (error) => error.message === "COMMAND_OUTCOME_UNKNOWN" && error.unknown === true);
});

test("wrapper reports unknown when its own running helper is lost", windows, async (t) => {
	const f = await fixture(t), original = ChildProcess.prototype.spawn;
	t.mock.method(ChildProcess.prototype, "spawn", function (options) {
		const result = original.call(this, options);
		if (options.file === f.host) {
			let buffer = "";
			this.stdout.on("data", (chunk) => { buffer += chunk.toString(); if (buffer.includes('"type":"started"')) { buffer = ""; this.kill(); } });
		}
		return result;
	});
	await assert.rejects(runManagedCommand({ ...f, cwd: f.directory, executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }), (error) => error.message === "COMMAND_OUTCOME_UNKNOWN" && error.unknown === true);
});
