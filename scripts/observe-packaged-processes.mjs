import { execFile } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";

export function parseProcessObservation(text, { observerPid, roots, includeNode = false }) {
	if (typeof text !== "string" || Buffer.byteLength(text) > 131072) throw new Error("PROCESS_COHORT_REPLY_INVALID");
	const value = JSON.parse(text);
	if (typeof includeNode !== "boolean" || includeNode && value.nodeImagesIncluded !== true || !includeNode && value.nodeImagesIncluded === true || value.nodeImagesIncluded !== undefined && typeof value.nodeImagesIncluded !== "boolean") throw new Error("PROCESS_COHORT_REPLY_INVALID");
	if (value.version !== 1 || value.observerPid !== observerPid || !Number.isSafeInteger(observerPid) || observerPid <= 0 || !isDeepStrictEqual(value.roots, roots) || !Array.isArray(value.members) || value.members.length > 256 || value.count !== value.members.length) throw new Error("PROCESS_COHORT_REPLY_INVALID");
	const pids = new Set();
	for (const member of value.members) {
		if (!Number.isSafeInteger(member.pid) || member.pid <= 0 || member.pid === observerPid || pids.has(member.pid) || !/^[1-9][0-9]{0,18}$/.test(member.startedUtcTicks ?? "") || !Number.isInteger(member.rootIndex) || member.rootIndex < 0 || member.rootIndex >= roots.length || typeof member.relativeImage !== "string" || member.relativeImage.length > 4096 || member.relativeImage.includes("\\") || member.relativeImage.split("/").some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)) || isAbsolute(member.relativeImage) || !/(?:^|\/)(?:Spherewright-CommandDeck|CommandDeck.NativeHost|CommandDeck.CommandHost)\.exe$/i.test(member.relativeImage) && !(includeNode && /(?:^|\/)node\.exe$/i.test(member.relativeImage))) throw new Error("PROCESS_COHORT_REPLY_INVALID");
		pids.add(member.pid);
	}
	return value;
}

export async function observePackagedProcesses({ executable, roots, env, timeoutMs = 20000, includeNode = false }) {
	if (typeof includeNode !== "boolean" || !isAbsolute(executable) || !Array.isArray(roots) || roots.length < 1 || roots.length > 2 || roots.some(path => !isAbsolute(path) || normalize(path) !== path) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw new Error("PROCESS_COHORT_REQUEST_INVALID");
	return new Promise((resolve, reject) => {
		const child = execFile(executable, [includeNode ? "--inspect-command-cohort" : "--inspect-process-cohort", ...roots], { env, windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 131072 }, (error, stdout) => {
			if (error) return reject(new Error("PROCESS_COHORT_OBSERVATION_UNAVAILABLE", { cause: error }));
			try { resolve(parseProcessObservation(stdout, { observerPid: child.pid, roots, includeNode })); } catch (error) { reject(error); }
		});
	});
}
