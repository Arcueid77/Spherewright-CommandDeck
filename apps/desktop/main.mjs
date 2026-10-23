// The HWND-owning UI is disposable; Pi and native-host control live in a separate supervisor.
if (process.argv.includes("--portable-smoke")) {
	const { app } = await import("electron");
	const { preparePortableMode } = await import("./portable-mode.mjs");
	await preparePortableMode(app, process.argv);
}
if (process.argv.includes("--vault-smoke")) await import("./vault-smoke.mjs");
else if (process.argv.includes("--managed-ui")) await import("./ui-main.mjs");
else {
	const { app } = await import("electron");
	const { startSupervisor } = await import("./supervisor-start.mjs");
	await startSupervisor(app);
}
