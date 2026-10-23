import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startupFailureCode } from "./startup-failure.mjs";

// Admit this profile's sole owner before importing modules that can open or
// migrate task ledgers. The disposable UI never enters this startup path.
export async function startSupervisor(app, { load = () => import("./supervisor.mjs"), notice = code => console.error(code), blocked = async code => (await import("./startup-blocked.mjs")).showStartupBlocked(app, code), smoke = process.argv.includes("--smoke") || process.argv.includes("--portable-smoke") } = {}) {
	const directory = join(app.getPath("userData"), "supervisor");
	mkdirSync(directory, { recursive: true });
	app.setPath("userData", directory);
	if (!app.requestSingleInstanceLock()) {
		if (smoke) notice("SMOKE_INSTANCE_ALREADY_RUNNING");
		app.exit(smoke ? 1 : 0);
		return { primary: false };
	}
	try { await load(); }
	catch (error) {
		const code = startupFailureCode(error); notice(code);
		// Do not await ready during main-module evaluation: Electron completes
		// that evaluation before emitting ready. Keep this profile's lock held.
		void app.whenReady().then(() => blocked(code)).catch(() => { notice("STARTUP_BLOCKED_WINDOW_FAILED"); app.exit(1); });
		return { primary: true, blocked: true, code };
	}
	return { primary: true };
}
