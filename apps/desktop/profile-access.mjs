import { protectedProvider } from "./credential-vault.mjs";

// The renderer never calls this function. Both lookups use the utility-owned task ledger.
export async function resolveTaskProfile(vault, lookupTask, request) {
	function requireTask(task) {
		if (!task || task.id !== request.taskId || task.kind !== "agent" || task.state !== "running" || !protectedProvider(request.providerId) || task.provider !== request.providerId || task.model !== request.modelId) throw new Error("PROTECTED_PROFILE_REQUEST_REJECTED");
	}
	requireTask(await lookupTask(request.taskId));
	const profile = await vault.resolve(request.providerId, request.modelId);
	requireTask(await lookupTask(request.taskId));
	return profile;
}
