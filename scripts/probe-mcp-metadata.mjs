import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintMcp, launchMcp } from "../apps/desktop/mcp-client.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), index = process.argv.indexOf("--executable"), path = process.argv[index + 1];
if (index < 0 || !path || !isAbsolute(path)) throw new Error("EXPLICIT_MCP_EXECUTABLE_REQUIRED");
const selection = await fingerprintMcp(path), runId = randomUUID(), directory = join(root, ".local", "mcp-metadata", runId);
await mkdir(directory, { recursive: true });
// An explicit nonexistent descriptor prevents fallback to any real Bridge. Metadata only.
const client = launchMcp(selection, { descriptorPath: join(directory, "disabled-runtime.json") });
try {
	const metadata = await client.discover();
	if (client.stats.toolCalls !== 0) throw new Error("METADATA_PROBE_CALLED_TOOL");
	await client.close();
	await writeFile(join(root, ".local/mcp-metadata.private.json"), JSON.stringify({ runId, selection, metadata, stats: client.stats, toolCalls: 0, gameCalls: 0, processExitConfirmed: client.exitConfirmed }, null, 2));
	console.log(JSON.stringify({ mcpMetadata: "passed", ...metadata, cohortHash: selection.cohortHash, fileCount: selection.fileCount, toolCalls: 0, gameCalls: 0 }));
} finally { await client.close(); }
