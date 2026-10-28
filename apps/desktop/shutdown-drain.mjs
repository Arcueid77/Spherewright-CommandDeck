// Start all shutdown participants before awaiting any one; a slow observer cannot delay task cancellation.
export async function settleShutdown(operations) {
	const results = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
	const failure = results.find((result) => result.status === "rejected");
	if (failure) throw new Error(/^[A-Z_]+$/.test(failure.reason?.message) ? failure.reason.message : "SHUTDOWN_DRAIN_FAILED");
}

// Both windows below are observation intervals. Only the original process's
// actual exit can release shutdown; an elapsed interval or kill result cannot.
export async function closeUiAndWait({ exited, requestClose, terminate, report = () => {}, gracefulMs = 3000, terminationMs = 3000 }) {
	const pending = Symbol("exit-pending");
	async function observe(milliseconds) {
		let timer;
		try { return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(pending), milliseconds); })]); }
		finally { clearTimeout(timer); }
	}
	report({ phase: "close-requested" });
	try { requestClose(); } catch { report({ phase: "close-send-failed" }); }
	let result = await observe(gracefulMs);
	if (result === pending) {
		let submitted = false;
		try { submitted = terminate() === true; } catch { report({ phase: "termination-send-failed" }); }
		report({ phase: "termination-requested", submitted });
		result = await observe(terminationMs);
		if (result === pending) {
			report({ phase: "exit-pending" });
			result = await exited;
		}
	}
	report({ phase: "exit-observed" });
	return result;
}
