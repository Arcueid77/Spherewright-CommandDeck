import { OwnedFixtureHost } from "./owned-fixture.mjs";
import { GameAdapterClient, inspectAdapterProcess, listGameAdapters } from "./game-adapter.mjs";

function publicState(value) {
	const source = value.window ?? {};
	const fields = ["active", "attached", "gameAlive", "gameParentMatches", "nativeParentMatches", "hostVisible", "uiVisible", "uiThreadHasFocus", "gameThreadHasFocus", "gamePointerFocusRequests", "pointerDownNotifications", "gamePointerHits", "gameParentNotifyEnabled", "pointerClientPointMatchesCursor", "pointerScreenPointMatchesCursor", "uiOperationPending", "targetPid", "dpi", "clientWidth", "clientHeight", "layoutRequested", "layoutApplied", "displayProfile"];
	return {
		...Object.fromEntries(fields.map((key) => [key, source[key]])), ready: value.ready === true, windowed: value.windowed === true,
		unityVersion: value.unityVersion, unityUpdateSequence: value.unityUpdateSequence,
		renderWidth: value.renderWidth, renderHeight: value.renderHeight,
		applicationFocused: typeof value.applicationFocused === "boolean" ? value.applicationFocused : null,
		fault: /^[A-Z_]+$/.test(value.fault ?? source.fault ?? "") ? value.fault ?? source.fault : null,
		kind: value.kind === "dsp" ? "dsp" : "adapter-fixture", mode: value.mode, gameCalls: 0,
	};
}
function restored(value) {
	return value.restorationProven === true && !value.quarantined && !value.fault &&
		value.window?.active === false && !value.window.attached && !value.window.uiOperationPending && !value.window.fault;
}

// No DSP launch/kill route. Disconnection retains the exact endpoint and blocks new attachment.
export class WindowHost extends OwnedFixtureHost {
	watch(client) {
		client.on("stopped", () => {
			if (this.adapter !== client) return;
			this.adapterUnknown = true;
			this.emit("connection-lost");
		});
	}
	unknownState() {
		return {
			...publicState(this.adapter?.latest ?? { kind: this.adapter?.descriptor.kind }),
			ready: false, nativeParentMatches: false, uiOperationPending: true,
			fault: "ADAPTER_DISCONNECTED_UNRECONCILED", mode: "adapter-unreconciled", gameCalls: 0,
		};
	}
	clearAdapter() {
		const old = this.adapter;
		this.adapter = undefined; this.adapterId = undefined;
		this.adapterUnknown = false; this.reconnectAttempted = false;
		old?.disconnect();
	}
	async reconnectSameEndpoint(force = false) {
		if (this.reconnecting) return this.reconnecting;
		if (!this.adapter?.stopped) return;
		if (this.reconnectAttempted && !force) return;
		this.reconnectAttempted = true;
		const original = this.adapter;
		this.adapterUnknown = true;
		this.reconnecting = (async () => {
			try {
				// No window request was sent before authentication; there is no binding from this client.
				if (!original.mayHaveMutated) { this.clearAdapter(); return; }
				const process = await inspectAdapterProcess(original.descriptor);
				if (this.adapter !== original) return;
				if (process.exited === true) { this.clearAdapter(); this.emit("stopped"); return; }
				if (!process.sameInstance) return;
				const fresh = new GameAdapterClient(original.descriptor);
				try {
					const status = await fresh.ready; // Hello/status only; the native helper rechecks the OS peer.
					if (this.adapter !== original) { fresh.disconnect(); return; }
					fresh.mayHaveMutated = original.mayHaveMutated;
					this.adapter = fresh; this.watch(fresh);
					this.adapterUnknown = !restored(status);
				} catch { fresh.disconnect(); }
			} catch { /* Retain the original endpoint and unknown state. No automatic window replay. */ }
		})();
		try { await this.reconnecting; } finally { this.reconnecting = undefined; }
	}
	async request(method, args = {}) {
		if (method === "list") {
			const fixtures = await super.request("list");
			const adapters = await listGameAdapters();
			return [...fixtures, ...adapters.map(({ id, descriptor }) => ({
				id, pid: descriptor.gamePid, kind: descriptor.kind === "dsp" ? "dsp" : "fixture",
				title: descriptor.kind === "dsp" ? "CommandDeck 显式启用的 DSP 窗口" : "Unity 窗口适配器替身 · NO DSP",
			}))];
		}
		if (method === "attach" && args.targetId !== "owned-fixture") {
			if (this.transitions > 0 || this.adapterUnknown || this.adapter?.stopped) throw new Error("RECONCILE_CURRENT_WINDOW_FIRST");
			this.transitions++;
			try {
				if ((await super.request("status")).attached || (this.adapter && this.adapterId !== args.targetId)) throw new Error("DETACH_CURRENT_WINDOW_FIRST");
				if (!this.binding) throw new Error("UI_NOT_REGISTERED");
				if (!this.adapter) {
					const selected = (await listGameAdapters()).find((item) => item.id === args.targetId);
					if (!selected) throw new Error("OPT_IN_ADAPTER_REQUIRED");
					this.adapter = new GameAdapterClient(selected.descriptor);
					this.adapterId = selected.id; this.watch(this.adapter);
					await this.adapter.ready;
				}
				const status = await this.adapter.request("status");
				if (status.window.attached || status.window.fault || status.quarantined) throw new Error("DETACH_CURRENT_WINDOW_FIRST");
				if (!status.window.active) await this.adapter.request("deactivate");
				await this.adapter.request("activate");
				await this.adapter.request("adopt", this.binding);
			} finally { this.transitions--; }
			if (this.rect) await this.request("rect", this.rect);
			return this.request("status");
		}
		if (method === "start-fixture" || (method === "attach" && args.targetId === "owned-fixture")) {
			if (this.adapter) throw new Error("DETACH_CURRENT_WINDOW_FIRST");
			return super.request(method, args);
		}
		if (method === "rect") this.rect = args;
		if (this.adapter?.stopped && ["status", "detach", "close"].includes(method))
			await this.reconnectSameEndpoint(method !== "status");
		if (!this.adapter) return super.request(method, args);
		if (method === "detach" || method === "close") {
			this.transitions++;
			try {
				if (this.adapter.stopped) throw new Error("ADAPTER_RESTORATION_UNRECONCILED");
				const proof = await this.adapter.request("deactivate");
				if (!restored(proof)) throw new Error("ADAPTER_RESTORATION_UNRECONCILED");
				this.clearAdapter();
				return super.request("status");
			} finally { this.transitions--; }
		}
		if (this.adapter.stopped || this.adapterUnknown) {
			if (method === "status") return this.unknownState();
			if (method === "rect" || method === "focus-ui") return { deferred: true };
			throw new Error("ADAPTER_RESTORATION_UNRECONCILED");
		}
		if (method === "rect") {
			if (this.transitions > 0 || !this.adapter.latest?.window.active) return { deferred: true };
			const scale = this.adapter.latest.window.dpi / 96;
			if (!(scale > 0 && scale <= 4)) throw new Error("UNSUPPORTED_DPI");
			const geometry = Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.round(args[key] * scale)]));
			return publicState(await this.adapter.request("rect", { ...geometry, visible: args.visible }));
		}
		if (method === "focus-ui" && !this.adapter.latest?.window.active) return { deferred: true };
		return publicState(await this.adapter.request(method, args));
	}
}
