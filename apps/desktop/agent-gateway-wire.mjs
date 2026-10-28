import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { gatewayLimits, gatewayQuery } from "./agent-gateway-contract.mjs";

export const gatewayPipePrefix = "\\\\.\\pipe\\Spherewright-CommandDeck-ReadOnly-";
export function gatewayConnection(value) {
	if (!value || typeof value.pipe !== "string" || !value.pipe.startsWith(gatewayPipePrefix) || !/^[a-f0-9-]{36}$/.test(value.pipe.slice(gatewayPipePrefix.length)) || !/^[a-f0-9]{64}$/.test(value.key ?? "")) throw new Error("GATEWAY_CONNECTION_INVALID");
	return { pipe: value.pipe, key: value.key };
}
export const gatewayNonce = () => randomBytes(16).toString("hex");
export const gatewayMac = (key, domain, nonce, value) => createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify(["CommandDeck-read-only-v1", domain, nonce, value])).digest("hex");
export function validGatewayMac(key, domain, frame, value) { return /^[a-f0-9]{32}$/.test(frame?.nonce ?? "") && /^[a-f0-9]{64}$/.test(frame?.mac ?? "") && timingSafeEqual(Buffer.from(frame.mac, "hex"), Buffer.from(gatewayMac(key, domain, frame.nonce, value), "hex")); }
export function decodeGatewayFrame(bytes) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }

export async function readGateway(connection, input, signal) {
	const { pipe, key } = gatewayConnection(connection), query = gatewayQuery(input), nonce = gatewayNonce();
	if (signal?.aborted) throw new Error("GATEWAY_REQUEST_CANCELLED");
	return new Promise((resolve, reject) => {
		const socket = createConnection(pipe); let pending = Buffer.alloc(0), finished = false;
		const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); socket.destroy(); error ? reject(new Error(error)) : resolve(result); };
		const cancel = () => finish("GATEWAY_REQUEST_CANCELLED"), timer = setTimeout(() => finish("GATEWAY_UNAVAILABLE"), gatewayLimits.timeoutMs);
		signal?.addEventListener("abort", cancel, { once: true });
		socket.on("error", () => finish("GATEWAY_UNAVAILABLE")); socket.on("close", () => finish("GATEWAY_UNAVAILABLE"));
		socket.on("connect", () => { if (!finished) socket.write(JSON.stringify({ version: 1, nonce, query, mac: gatewayMac(key, "request", nonce, query) }) + "\n"); });
		socket.on("data", bytes => {
			if (finished) return; if (pending.length + bytes.length > gatewayLimits.responseBytes) { finish("GATEWAY_RESPONSE_INVALID"); return; }
			pending = Buffer.concat([pending, bytes]); const end = pending.indexOf(10); if (end === -1) return;
			try {
				if (end !== pending.length - 1) throw new Error(); const frame = decodeGatewayFrame(pending.subarray(0, end));
				if (frame.version !== 1 || frame.nonce !== nonce || Object.keys(frame).sort().join() !== "body,mac,nonce,version" || !validGatewayMac(key, "response", frame, frame.body)) throw new Error();
				if (frame.body?.ok !== true) { finish(["GATEWAY_INVALID_QUERY", "GATEWAY_SNAPSHOT_CHANGED", "GATEWAY_CACHE_UNAVAILABLE", "GATEWAY_RESPONSE_TOO_LARGE", "GATEWAY_RATE_LIMIT"].includes(frame.body?.error) ? frame.body.error : "GATEWAY_UNAVAILABLE"); return; }
				finish(null, frame.body.result);
			} catch { finish("GATEWAY_RESPONSE_INVALID"); }
		});
	});
}
