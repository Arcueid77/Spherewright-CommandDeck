import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../vendor/pi/packages/coding-agent/dist/index.js";
import { readProfiles } from "./profiles.mjs";

export const PI_COMMIT = "71023aec1546d6d677a65669c5665c0927ce0dd0";
const toolNames = ["deck_echo"];
const resourceLoader = () => ({
	getExtensions: () => ({
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	}),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () =>
		'You are running a bounded connectivity probe. Call deck_echo exactly once with value "commanddeck-m0". Then briefly report the returned value. No other tools or actions are permitted.',
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources() {},
	async reload() {},
});
const schema = {
	type: "object",
	properties: { value: { type: "string", maxLength: 128 } },
	required: ["value"],
	additionalProperties: false,
};

async function fakeEndpoint(
	forbidden = false,
	stall = false,
	secondLegError = false,
) {
	let calls = 0;
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 65536) {
				response.writeHead(413).end();
				return;
			}
		}
		calls++;
		if (stall) return;
		const data = JSON.parse(body);
		const cap = data.max_tokens ?? data.max_completion_tokens;
		if (!Number.isInteger(cap) || cap < 1 || cap > 512) {
			response.writeHead(400).end();
			return;
		}
		const hasResult = data.messages.some((message) => message.role === "tool");
		if (hasResult && secondLegError) {
			response.writeHead(503, { "content-type": "application/json" }).end(
				JSON.stringify({
					error: { message: "synthetic second-leg failure" },
				}),
			);
			return;
		}
		const chunks = !hasResult
			? [
					{
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "deck-probe-call",
									type: "function",
									function: {
										name: forbidden ? "mcp__forbidden" : "deck_echo",
										arguments: '{"value":',
									},
								},
							],
						},
					},
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '"commanddeck-m0"}' } },
							],
						},
					},
					{ delta: {}, finish_reason: "tool_calls" },
				]
			: [
					{ delta: { role: "assistant", content: "commanddeck-m0 verified" } },
					{ delta: {}, finish_reason: "stop" },
				];
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of chunks)
			response.write(
				`data: ${JSON.stringify({ id: "deck-offline", object: "chat.completion.chunk", created: 1, model: "deck-fixture", choices: [{ index: 0, ...chunk }] })}\n\n`,
			);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}/v1`,
		calls: () => calls,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

export async function runPiProbe({
	mode = "offline",
	providerId,
	modelId,
	storageRoot,
	onEvent = () => {},
	signal,
	forbidden = false,
	stall = false,
	secondLegError = false,
	resumeFile,
} = {}) {
	if (!["offline", "live"].includes(mode))
		throw new Error("EXPLICIT_PROBE_MODE_REQUIRED");
	const directory =
		storageRoot ?? (await mkdtemp(join(tmpdir(), "commanddeck-pi-")));
	await mkdir(directory, { recursive: true });
	let endpoint, session;
	let executed = 0,
		modelRequests = 0;
	const events = [];
	try {
		let modelsPath;
		if (mode === "offline") {
			endpoint = await fakeEndpoint(forbidden, stall, secondLegError);
			providerId = "deck-offline";
			modelId = "deck-fixture";
			modelsPath = join(directory, "models.json");
			await writeFile(
				modelsPath,
				JSON.stringify({
					providers: {
						[providerId]: {
							baseUrl: endpoint.url,
							api: "openai-completions",
							apiKey: "offline-fixture",
							models: [{ id: modelId, contextWindow: 8192, maxTokens: 512 }],
						},
					},
				}),
			);
		} else {
			const profiles = readProfiles();
			modelsPath = profiles.path;
			if (
				!profiles.profiles.some(
					(profile) =>
						profile.providerId === providerId && profile.modelId === modelId,
				)
			)
				throw new Error("EXPLICIT_CONFIGURED_MODEL_REQUIRED");
		}
		const runtime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath,
			modelsStorePath: join(directory, "models-store.json"),
			allowModelNetwork: false,
		});
		const stream = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = (requestedModel, context, options) => {
			if (++modelRequests > 2)
				throw new Error("MODEL_REQUEST_BUDGET_EXHAUSTED");
			return stream(requestedModel, context, {
				...options,
				maxTokens: Math.min(requestedModel.maxTokens, 512),
				maxRetries: 0,
			});
		};
		const configuredModel = runtime.getModel(providerId, modelId);
		if (!configuredModel) throw new Error("CONFIGURED_MODEL_UNAVAILABLE");
		const model = {
			...configuredModel,
			maxTokens: Math.min(configuredModel.maxTokens, 512),
		};
		const manager = resumeFile
			? SessionManager.open(resumeFile, join(directory, "sessions"))
			: SessionManager.create(directory, join(directory, "sessions"));
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			model,
			modelRuntime: runtime,
			thinkingLevel: "off",
			resourceLoader: resourceLoader(),
			noTools: "all",
			tools: toolNames,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: {
					enabled: false,
					maxRetries: 0,
					provider: { maxRetries: 0, timeoutMs: 60000 },
				},
				cacheWarming: "off",
			}),
			sessionManager: manager,
			customTools: [
				{
					name: "deck_echo",
					label: "M0 echo",
					description:
						"Return a bounded synthetic value. Has no game, shell or file side effects.",
					parameters: schema,
					async execute(_callId, args) {
						if (
							executed > 0 ||
							Object.keys(args).length !== 1 ||
							typeof args.value !== "string" ||
							args.value.length > 128
						)
							throw new Error("ECHO_BUDGET_OR_ARGUMENTS");
						executed++;
						return {
							content: [{ type: "text", text: args.value }],
							details: { synthetic: true, gameCalls: 0 },
						};
					},
				},
			],
		}));
		const active = session.getActiveToolNames().sort();
		const callable = session.getCallableToolNames().sort();
		if (
			JSON.stringify(active) !== JSON.stringify(toolNames) ||
			JSON.stringify(callable) !== JSON.stringify(toolNames)
		)
			throw new Error("PI_TOOL_SET_MISMATCH");
		if (resumeFile)
			return {
				mode,
				sourceCommit: PI_COMMIT,
				active,
				callable,
				executed: 0,
				gameCalls: 0,
				requestCount: 0,
				restoredMessages: session.messages.length,
			};
		const abort = () => {
			void session.abort();
		};
		signal?.addEventListener("abort", abort, { once: true });
		session.subscribe((event) => {
			events.push(event.type);
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			)
				onEvent({ type: "text", text: event.assistantMessageEvent.delta });
			else if (
				["tool_execution_start", "tool_execution_end"].includes(event.type)
			)
				onEvent({ type: event.type, tool: event.toolName });
		});
		try {
			if (!signal?.aborted)
				await session.prompt("Run the one permitted synthetic echo probe now.");
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		const finalAssistant = session.messages
			.filter((message) => message.role === "assistant")
			.at(-1);
		const result = {
			mode,
			sourceCommit: PI_COMMIT,
			providerId,
			modelId,
			active,
			callable,
			executed,
			gameCalls: 0,
			events,
			cancelled: signal?.aborted === true,
			finalStopReason: finalAssistant?.stopReason,
			deniedToolResults: session.messages.filter(
				(message) => message.role === "toolResult" && message.isError,
			).length,
			text: session.getLastAssistantText(),
			sessionFile: manager.getSessionFile(),
			requestCount: endpoint?.calls() ?? modelRequests,
		};
		if (
			!signal?.aborted &&
			!forbidden &&
			(executed !== 1 ||
				modelRequests !== 2 ||
				finalAssistant?.stopReason !== "stop" ||
				!result.text?.trim())
		)
			throw new Error("TOOL_ROUNDTRIP_NOT_PROVEN");
		return result;
	} finally {
		session?.dispose();
		endpoint?.close();
	}
}
