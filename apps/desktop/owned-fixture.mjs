import { EventEmitter } from "node:events";
import { NativeClient } from "./native-client.mjs";

// This facade starts only our own simulator executable. It has no DSP route.
export class OwnedFixtureHost extends EventEmitter {
	constructor(window) {
		super();
		this.window = window;
		this.ready = Promise.resolve();
		this.fixture = undefined;
		this.rect = undefined;
		this.transitions = 0;
	}
	bindUi(binding) {
		this.binding = binding;
		this.rect = undefined;
	}
	async request(method, args = {}) {
		if (method === "rect") this.rect = args;
		if (method === "rect" && this.transitions > 0) return { deferred: true };
		const inactive = {
			attached: false,
			nativeParentMatches: false,
			gameCalls: 0,
			mode: "game-owned-host-fixture",
			kind: "fixture",
		};
		if (method === "start-fixture") {
			if (this.fixture && !this.fixture.stopped)
				return this.fixture.request("status");
			this.fixture = new NativeClient(["--owned-host-fixture"]);
			this.fixture.on("stopped", () => this.emit("stopped"));
			await this.fixture.ready;
			return this.fixture.request("status");
		}
		if (!this.fixture || this.fixture.stopped) {
			if (method === "list") return [];
			if (["status", "detach", "rect", "close", "focus-ui"].includes(method))
				return inactive;
			throw new Error("START_OWNED_FIXTURE_FIRST");
		}
		if (method === "list")
			return [
				{
					id: "owned-fixture",
					pid: this.fixture.child.pid,
					kind: "fixture",
					title: "Game-owned native host · 替身，非 DSP",
				},
			];
		if (method === "attach") {
			if (args.targetId !== "owned-fixture")
				throw new Error("FIXTURE_TARGET_ONLY");
			this.transitions++;
			try {
				const binding =
					this.binding ??
					(this.window
						? {
								hwnd: this.window
									.getNativeWindowHandle()
									.readBigUInt64LE()
									.toString(),
								pid: process.pid,
							}
						: undefined);
				if (!binding) throw new Error("UI_NOT_REGISTERED");
				await this.fixture.request("adopt", {
					hwnd: binding.hwnd,
					pid: binding.pid,
				});
			} finally {
				this.transitions--;
			}
			if (this.rect && this.transitions === 0)
				await this.fixture.request("rect", this.rect);
			return this.fixture.request("status");
		}
		if (["detach", "close"].includes(method)) {
			this.transitions++;
			try {
				return await this.fixture.request(method, args);
			} finally {
				this.transitions--;
			}
		}
		return this.fixture.request(method, args);
	}
}
