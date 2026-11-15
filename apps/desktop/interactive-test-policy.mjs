// Window/focus tests must never take over a developer's desktop by accident.
// `CI=true` is not sufficient: local and self-hosted CI may use the same desktop.
export function interactiveTestEnvironment(env = process.env) {
	if (env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted") return "hosted-runner";
	if (env.COMMANDDECK_ALLOW_VISIBLE_TEST_WINDOWS === "1") return "explicit-interactive";
	return null;
}

export function requireInteractiveTestEnvironment(env = process.env) {
	const mode = interactiveTestEnvironment(env);
	if (!mode) throw new Error("INTERACTIVE_TEST_REQUIRES_ISOLATED_DESKTOP: use a GitHub-hosted runner, or explicitly set COMMANDDECK_ALLOW_VISIBLE_TEST_WINDOWS=1 on a desktop dedicated to these tests.");
	return mode;
}
