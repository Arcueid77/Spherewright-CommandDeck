import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { nativeExecutable } from "../apps/desktop/native-client.mjs";

const { stdout } = await promisify(execFile)(nativeExecutable, ["--test-layout-queue"], { timeout: 30000, windowsHide: true, maxBuffer: 4096 });
const proof = JSON.parse(stdout);
assert.equal(proof.requestBeforeCompletion, true);
assert.equal(proof.requestAfterCompletion, true);
assert.equal(proof.gameCalls, 0);
await mkdir(".local", { recursive: true });
await writeFile(".local/adapter-layout-smoke.json", JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
