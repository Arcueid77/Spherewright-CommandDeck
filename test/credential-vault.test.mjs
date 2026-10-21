import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir, devNull } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { CredentialVault } from "../apps/desktop/credential-vault.mjs";
import { createProtectedRuntime } from "../apps/desktop/protected-runtime.mjs";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { resolveTaskProfile } from "../apps/desktop/profile-access.mjs";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-vault-")), file = join(directory, "profiles.vault.json"), key = randomBytes(32);
	const protection = { available: () => true, async encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv), bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); }, async decrypt(bytes) { const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"); } };
	t.after(async () => { assert.equal(dirname(await realpath(directory)).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(directory).startsWith("commanddeck-vault-")); await rm(directory, { recursive: true, force: true }); });
	return { directory, file, protection, vault: new CredentialVault(file, protection) };
}
const profile = (extra = {}) => ({ id: "deckvault-" + randomUUID(), label: "Fixture provider", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", modelId: "fixture-model", contextWindow: 8192, maxTokens: 2048, apiKey: "fixture-secret-" + randomUUID(), expectedRevision: null, ...extra });

test("protected profile files contain only sealed records and public metadata never returns the key", async (t) => {
	const f = await fixture(t), input = profile();
	const saved = await f.vault.save(input), raw = await readFile(f.file, "utf8");
	for (const value of [input.apiKey, input.baseUrl, input.modelId, input.label]) assert.ok(!raw.includes(value));
	assert.deepEqual(Object.keys(saved.profiles[0]).sort(), ["api", "label", "modelId", "providerId", "source"].sort());
	const reopened = new CredentialVault(f.file, f.protection), resolved = await reopened.resolve(input.id, input.modelId);
	assert.equal(resolved.key, input.apiKey);
	assert.equal((await reopened.describe(input.id)).key, undefined);
	await assert.rejects(reopened.resolve(input.id, "another-model"), /NOT_FOUND/);
	const changed = await reopened.save({ ...input, apiKey: "", label: "Renamed fixture", expectedRevision: saved.revision });
	assert.equal((await reopened.resolve(input.id, input.modelId)).key, input.apiKey);
	await reopened.remove({ id: input.id, expectedRevision: changed.revision });
	assert.equal((await reopened.list()).profiles.length, 0);
});
test("concurrent stale updates cannot silently replace a protected profile", async (t) => {
	const f = await fixture(t), input = profile();
	const results = await Promise.allSettled([f.vault.save(input), f.vault.save(profile({ label: "second" }))]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.match(results.find((result) => result.status === "rejected").reason.message, /PROTECTED_STORE_CHANGED/);
});

test("the internal credential channel binds a running task and rechecks after decrypting", async (t) => {
	const f = await fixture(t), input = profile(); await f.vault.save(input);
	const request = { taskId: randomUUID(), providerId: input.id, modelId: input.modelId };
	const task = { id: request.taskId, provider: input.id, model: input.modelId, kind: "agent", state: "running" };
	assert.equal((await resolveTaskProfile(f.vault, async () => task, request)).key, input.apiKey);
	for (const difference of [{ state: "cancelled" }, { kind: "check" }, { provider: "another-provider" }, { model: "another-model" }]) await assert.rejects(resolveTaskProfile(f.vault, async () => ({ ...task, ...difference }), request), /REQUEST_REJECTED/);
	let reads = 0;
	await assert.rejects(resolveTaskProfile(f.vault, async () => ++reads === 1 ? task : { ...task, state: "cancelling" }, request), /REQUEST_REJECTED/);
});
test("unavailable protection, corrupt data and newer schemas never reset or expose the store", async (t) => {
	const f = await fixture(t), unavailable = new CredentialVault(f.file, { available: () => false });
	await assert.rejects(unavailable.save(profile()), /UNAVAILABLE/);
	await assert.rejects(readFile(f.file), { code: "ENOENT" });
	await writeFile(f.file, '{"version":99,"retained":true}'); const before = await readFile(f.file);
	await assert.rejects(f.vault.save(profile()), /VERSION_UNSUPPORTED/);
	assert.deepEqual(await readFile(f.file), before);
});
test("sealed profiles cannot be moved to another identity and endpoints reject credential channels", async (t) => {
	const f = await fixture(t), input = profile();
	await assert.rejects(f.vault.save({ ...input, baseUrl: "http://remote.invalid/v1" }), /TLS_REQUIRED/);
	await assert.rejects(f.vault.save({ ...input, baseUrl: "https://fixture.invalid/v1?key=hidden" }), /INVALID_PROFILE_ENDPOINT/);
	await f.vault.save(input);
	const data = JSON.parse(await readFile(f.file, "utf8")); data.entries[0].id = "deckvault-" + randomUUID(); await writeFile(f.file, JSON.stringify(data));
	await assert.rejects(f.vault.list(), /BINDING_MISMATCH/);
});
test("a protected runtime buffers split SSE echoes and emits only complete sanitized text", async (t) => {
	let received = false; const observedRequests = [], secret = "!literal-fixture-" + randomUUID();
	const server = createServer(async (request, response) => {
		received = request.headers.authorization === "Bearer " + secret;
		observedRequests.push({ method: request.method, path: request.url, authorizationMatched: received });
		for await (const _chunk of request) {}
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ delta: { role: "assistant", content: "provider echo: " + secret.slice(0, 15) } }, { delta: { content: secret.slice(15) } }, { delta: {}, finish_reason: "stop" }]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done)); t.after(() => { server.closeAllConnections(); server.close(); });
	const config = profile({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
	const runtime = await createProtectedRuntime({ ...config, key: secret }, new AbortController().signal);
	const stream = runtime.streamSimple(runtime.getModel(config.id, config.modelId), { messages: [{ role: "user", content: "Echo synthetic fixture", timestamp: Date.now() }] }, { maxTokens: 128, maxRetries: 0 });
	const events = []; for await (const event of stream) events.push(event);
	const completed = await stream.result(), diagnostic = JSON.stringify({ requests: observedRequests, stopReason: completed.stopReason, error: completed.errorMessage ?? null });
	assert.equal(completed.stopReason, "stop", diagnostic); assert.equal(received, true, diagnostic);
	assert.ok(!JSON.stringify(events).includes(secret)); assert.ok(JSON.stringify(events).includes("[redacted]"));
	assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""), "provider echo: [redacted]");
});

test("provider tool identifiers and argument property names cannot carry a credential", async (t) => {
	const secret = "synthetic-" + randomUUID(); let variant;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {}
		const tool = { index: 0, id: variant === "id" ? secret : "fixture-id", type: "function", function: { name: variant === "name" ? secret : "workspace_read", arguments: JSON.stringify(variant === "property" ? { [secret]: "hidden" } : { path: "code.mjs" }) } };
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ delta: { role: "assistant", tool_calls: [tool] } }, { delta: {}, finish_reason: "tool_calls" }]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done)); t.after(() => { server.closeAllConnections(); server.close(); });
	const config = profile({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
	const runtime = await createProtectedRuntime({ ...config, key: secret }, new AbortController().signal);
	for (variant of ["id", "name", "property"]) {
		const stream = runtime.streamSimple(runtime.getModel(config.id, config.modelId), { messages: [{ role: "user", content: "Synthetic fixture", timestamp: Date.now() }] }, { maxTokens: 128, maxRetries: 0 });
		const events = []; for await (const event of stream) events.push(event);
		assert.equal((await stream.result()).stopReason, "error", variant);
		assert.equal((await stream.result()).errorMessage, "MODEL_PROVIDER_FAILED");
		assert.ok(!JSON.stringify(events).includes(secret));
	}
});

test("initialization failures discard raw credential fields and nested causes", async () => {
	const secret = "synthetic-" + randomUUID(), config = { ...profile(), key: secret }; let overlay;
	const original = new Error("raw " + secret, { cause: new Error(secret) }); original.credential = { type: "api_key", key: secret };
	await assert.rejects(createProtectedRuntime(config, undefined, { createRuntime: async (options) => {
		assert.ok(options.credentials);
		return { registerProvider() {}, async setRuntimeApiKey(_id, key) { overlay = key; throw original; }, async removeRuntimeApiKey() { overlay = undefined; } };
	} }), (error) => {
		assert.equal(error.message, "PROTECTED_RUNTIME_INITIALIZATION_FAILED");
		assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"]);
		assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret)); return true;
	});
	assert.equal(overlay, undefined);
	await assert.rejects(createProtectedRuntime(config, undefined, { createRuntime: async () => { throw original; } }), (error) => error.message === "PROTECTED_RUNTIME_INITIALIZATION_FAILED" && error.cause === undefined && error.credential === undefined);
});

test("the actual Pi tool turn, session files and workbench receipts never persist a split echo", async (t) => {
	const f = await fixture(t), secret = "synthetic-session-" + randomUUID(), repo = join(f.directory, "source");
	await mkdir(repo); await writeFile(join(repo, "code.mjs"), "export const value = 1;\n");
	for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "fixture baseline"]]) execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.example", ...args], { cwd: repo, windowsHide: true, stdio: "pipe" });
	let requests = 0;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {}
		const first = ++requests === 1;
		const deltas = first ? [{ role: "assistant", tool_calls: [{ index: 0, id: "read-code", type: "function", function: { name: "workspace_read", arguments: '{"path":"code.mjs"}' } }] }] : [{ role: "assistant", content: "provider echo: " + secret.slice(0, 13) }, { content: secret.slice(13) }];
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [...deltas.map((delta) => ({ delta })), { delta: {}, finish_reason: first ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done)); t.after(() => { server.closeAllConnections(); server.close(); });
	const config = profile({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: secret }); await f.vault.save(config);
	const workbench = new Workbench({ directory: join(f.directory, "workbench"), resolveProfile: (task) => f.vault.resolve(task.provider, task.model) });
	try {
		await workbench.add({ path: repo, label: "Fixture", canWrite: false, canExecute: false });
		const task = await workbench.request("agent", { rootId: workbench.state().roots[0].id, providerId: config.id, modelId: config.modelId, prompt: "Read code.mjs and give a brief answer." });
		await workbench.operation.done;
		const receipt = await workbench.request("task", { taskId: task.id });
		assert.equal(receipt.state, "succeeded"); assert.equal(receipt.result.toolCalls, 1); assert.equal(receipt.result.requestCount, 2);
		assert.equal(receipt.response, "provider echo: [redacted]"); assert.ok(!JSON.stringify(receipt).includes(secret));
		assert.equal(receipt.result.gameCalls, 0);
	} finally { await workbench.close(); }
	let sessionSeen = false;
	async function inspect(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) await inspect(path); else { const bytes = await readFile(path); assert.ok(!bytes.includes(Buffer.from(secret)), item.name); if (item.name.endsWith(".jsonl")) { sessionSeen = true; assert.ok(bytes.includes(Buffer.from("[redacted]"))); } assert.ok(!["auth.json", "models.json", "models-store.json"].includes(item.name)); } } }
	await inspect(join(f.directory, "workbench")); assert.equal(sessionSeen, true);
});
