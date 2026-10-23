// Keep the exact utility-process object created by this supervisor. A kill
// request is not evidence of exit; the blocked startup page waits for its event.
export function trackOwnedRuntimeExit(runtime) {
	let exited = false;
	const completion = new Promise(resolve => runtime.once("exit", () => { exited = true; resolve(); }));
	return Object.freeze({
		get exited() { return exited; },
		async stop(timeoutMs = 3000) {
			if (!exited) runtime.kill();
			let timer;
			try { await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RUNTIME_EXIT_NOT_CONFIRMED")), timeoutMs); })]); }
			finally { clearTimeout(timer); }
		},
	});
}
