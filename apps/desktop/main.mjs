// The HWND-owning UI is disposable; Pi and native-host control live in a separate supervisor.
if (process.argv.includes("--vault-smoke")) await import("./vault-smoke.mjs");
else if (process.argv.includes("--managed-ui")) await import("./ui-main.mjs");
else await import("./supervisor.mjs");
