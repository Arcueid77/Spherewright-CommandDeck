export const packagedPopoutVersion = 1;
export function portablePopoutCase(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-popouts"));
	if (!values.length) return null;
	const phase = values[0].slice("--portable-popouts=".length);
	if (!argv.includes("--portable-smoke") || values.length !== 1 || values[0] !== "--portable-popouts=" + phase || !["record", "reopen"].includes(phase) || argv.some(arg => arg.startsWith("--portable-") && arg !== "--portable-smoke" && arg !== values[0])) throw new Error("PACKAGED_POPOUT_CASE_REQUIRED");
	return { phase };
}
export function assertPortablePopoutAction(action, args) {
	if (["snapshot", "status", "targets", "viewport", "focus-ui", "close", "profiles", "model-usage"].includes(action)) return;
	if (["bridge", "game", "gateway", "recording", "video", "journal"].includes(action) && args?.action === "snapshot") return;
	if (action === "profiles-manage" && args?.action === "list") return;
	if (action === "workbench" && ["state", "task", "ui-get", "ui-save"].includes(args?.action)) return;
	throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
}
