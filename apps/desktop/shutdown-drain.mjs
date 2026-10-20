// Start all shutdown participants before awaiting any one; a slow observer cannot delay task cancellation.
export async function settleShutdown(operations) {
	const results = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
	const failure = results.find((result) => result.status === "rejected");
	if (failure) throw new Error(/^[A-Z_]+$/.test(failure.reason?.message) ? failure.reason.message : "SHUTDOWN_DRAIN_FAILED");
}
