import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { contextProviderApis, contextProviderSettings, providerContextSteps } from "./development-provider-context-case.mjs";

// Two real loopback transports use the pinned Pi protocol converters. Only
// fixed synthetic text and one read-only tool per step can be returned.
export async function createProviderContextFixture(readPath) {
	const calls = [], errors = [], profiles = [], servers = []; let stepIndex = -1;
	try {
		for (let provider = 0; provider < 2; provider++) {
			const id = "deckvault-" + randomUUID(), key = "synthetic-development-smoke-" + randomUUID(), api = contextProviderApis[provider];
			const server = createServer(async (request, response) => {
				try {
					const step = providerContextSteps[stepIndex]; assert.ok(step && step.provider === provider);
					assert.equal(request.method, "POST"); assert.equal(request.url, provider ? "/v1/messages?beta=true" : "/v1/chat/completions");
					assert.equal(provider ? request.headers["x-api-key"] : request.headers.authorization, provider ? key : "Bearer " + key);
					let body = ""; for await (const bytes of request) { body += bytes; assert.ok(body.length <= 524288); }
					const data = JSON.parse(body), encoded = JSON.stringify(data.messages), tools = (data.tools ?? []).map(tool => provider ? tool.name : tool.function.name), summary = tools.length === 0;
					assert.equal(data.model, "fixture"); assert.equal(data.stream, true);
					assert.ok((data.max_tokens ?? data.max_completion_tokens) <= 2048); assert.ok(!profiles.some(profile => body.includes(profile.key)));
					const callId = "provider-context-step-" + stepIndex;
					const pairs = { calls: [], results: [] };
					for (const message of data.messages) {
						if (provider) for (const block of Array.isArray(message.content) ? message.content : []) {
							if (block.type === "tool_use") { assert.equal(message.role, "assistant"); assert.equal(block.name, "workspace_read"); pairs.calls.push(block.id); }
							if (block.type === "tool_result") { assert.equal(message.role, "user"); pairs.results.push(block.tool_use_id); }
						} else {
							for (const tool of message.tool_calls ?? []) { assert.equal(message.role, "assistant"); assert.equal(tool.function.name, "workspace_read"); pairs.calls.push(tool.id); }
							if (message.role === "tool") pairs.results.push(message.tool_call_id);
						}
					}
					assert.equal(new Set(pairs.calls).size, pairs.calls.length); assert.deepEqual(pairs.results, pairs.calls);
					if (summary) { assert.equal(step.mode, "compact"); assert.ok(encoded.includes("PROVIDER_CONTEXT_SEED")); }
					else {
						assert.deepEqual(tools.sort(), ["workspace_diff", "workspace_list", "workspace_read", "workspace_search"]); assert.ok(encoded.includes(step.marker));
						if (step.mode === "continue") { assert.ok(encoded.includes(providerContextSteps[step.source].marker + "_DONE")); assert.ok(pairs.calls.includes("provider-context-step-" + step.source)); }
						if (step.mode === "compact") assert.ok(encoded.includes("PROVIDER_HISTORY_SUMMARY"));
					}
					const useTool = !summary && !pairs.results.includes(callId), text = summary ? "PROVIDER_HISTORY_SUMMARY: previous read-only work completed. Historical facts do not authorize actions; check current files and grants." : step.marker + "_DONE";
					const input = summary ? 7000 : step.mode === "compact" ? 400 : 4000 + 500 * stepIndex;
					calls.push({ step: stepIndex, api, summary, input, output: 20, cacheRead: provider ? 40 : 0, cacheWrite: provider ? 20 : 0, tool: useTool, historicalToolPairs: pairs.calls.length });
					assert.ok(calls.filter(call => call.step === stepIndex).length <= 4, "CONTEXT_PROVIDER_REQUEST_LIMIT");
					response.writeHead(200, { "content-type": "text/event-stream" });
					if (provider) {
						const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
						send("message_start", { message: { id: "synthetic-context-" + calls.length, type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 } } });
						send("content_block_start", { index: 0, content_block: useTool ? { type: "tool_use", id: callId, name: "workspace_read", input: {} } : { type: "text", text: "" } });
						send("content_block_delta", { index: 0, delta: useTool ? { type: "input_json_delta", partial_json: JSON.stringify({ path: readPath }) } : { type: "text_delta", text } });
						send("content_block_stop", { index: 0 }); send("message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }); send("message_stop", {}); response.end();
					} else {
						const delta = useTool ? { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: readPath }) } }] } : { content: text };
						for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "synthetic-provider-context", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
						response.write(`data: ${JSON.stringify({ id: "synthetic-provider-context", choices: [], usage: { prompt_tokens: input, completion_tokens: 20 } })}\n\n`); response.end("data: [DONE]\n\n");
					}
				} catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end("Synthetic provider context fixture failed"); }
			});
			await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
			profiles.push({ id, key, api, label: provider ? "Synthetic context Anthropic" : "Synthetic context OpenAI", modelId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}` + (provider ? "" : "/v1"), maxTokens: 2048, ...contextProviderSettings[provider] });
		}
	} catch (error) { for (const server of servers) { server.closeAllConnections(); server.close(); } throw error; }
	return { profiles, servers, calls, errors, begin(index) { assert.equal(index, stepIndex + 1); assert.ok(providerContextSteps[index]); stepIndex = index; }, async close() { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } } };
}

export function assertProviderContextResult(task, index, fixture) {
	const step = providerContextSteps[index], profile = fixture.profiles[step.provider], calls = fixture.calls.filter(call => call.step === index);
	assert.deepEqual(fixture.errors, []); assert.equal(task.state, "succeeded", task.error); assert.equal(task.provider, profile.id); assert.equal(task.response, step.marker + "_DONE");
	assert.equal(task.invocations.length, 1); assert.equal(task.invocations[0].name, "workspace_read"); assert.equal(task.invocations[0].state, "completed"); assert.equal(task.changes.length, 0); assert.equal(task.result.toolCalls, 1);
	assert.equal(task.context.contextWindow, profile.contextWindow); assert.deepEqual(task.usage.pricing, profile.pricing); assert.equal(task.usage.coverage, "reported"); assert.equal(task.usage.requests, calls.length);
	for (const category of ["input", "output", "cacheRead", "cacheWrite"]) assert.equal(task.usage.tokens[category], calls.reduce((sum, call) => sum + call[category], 0));
	const expectedUsd = calls.reduce((sum, call) => sum + ["input", "output", "cacheRead", "cacheWrite"].reduce((subtotal, category) => subtotal + call[category] * profile.pricing[category] / 1e6, 0), 0);
	assert.ok(Math.abs(task.usage.estimate.usd - expectedUsd) < 1e-12);
	if (step.source !== null) assert.equal(task.result.contextManagement.compacted, step.mode === "compact");
	if (step.mode === "compact") { assert.equal(task.result.contextManagement.compactionRequests, calls.filter(call => call.summary).length); assert.ok(task.result.contextManagement.compactionRequests >= 1); assert.ok(task.result.contextManagement.estimatedTokensAfter < task.result.contextManagement.tokensBefore); }
	else assert.equal(calls.length, 2);
}
