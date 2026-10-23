import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Admit this profile's sole owner before importing modules that can open or
// migrate task ledgers. The disposable UI never enters this startup path.
export async function startSupervisor(app, { load = () => import("./supervisor.mjs"), notice = code => console.error(code), smoke = process.argv.includes("--smoke") || process.argv.includes("--portable-smoke") } = {}) {
	const directory = join(app.getPath("userData"), "supervisor");
	mkdirSync(directory, { recursive: true });
	app.setPath("userData", directory);
	if (!app.requestSingleInstanceLock()) {
		if (smoke) notice("SMOKE_INSTANCE_ALREADY_RUNNING");
		app.exit(smoke ? 1 : 0);
		return { primary: false };
	}
	await load();
	return { primary: true };
}
