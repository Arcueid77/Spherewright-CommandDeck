// Native Windows modal loops may pump window messages while suppressing Node timers.
// A responsive HWND prevents a false replacement, never proves task health or input isolation.
export function createUiWatchdog({ current, unavailable, inspect, recover, notice = () => {}, generation = () => 0, now = () => performance.now(), thresholdMs = 1000, nativeNoticeMs = 15000 }) {
	let pending = false;
	return async function check() {
		const record = current();
		if (!record?.loaded || unavailable()) return;
		if (now() - record.lastHeartbeat <= thresholdMs) { record.nativeResponsiveSince = undefined; record.nativeDelayReported = false; record.nativeProbePending = false; record.nativeProbeUnknowns = 0; record.nextNativeProbe = 0; return; }
		if (pending || record.nativeProbeUnknowns >= 2 || now() < (record.nextNativeProbe ?? 0)) return;
		pending = true;
		record.nativeProbePending = true;
		const sequence = record.lastBeatSequence;
		const inspectionGeneration = generation();
		try {
			let state;
			try { state = await inspect(record); } catch {}
			if (inspectionGeneration !== generation() || record !== current() || unavailable() || record.lastBeatSequence !== sequence || record.child?.exitCode != null || record.child?.signalCode != null || now() - record.lastHeartbeat <= thresholdMs) return;
			record.nextNativeProbe = now() + 500;
			record.lastNativeProbe = { probeStatus: state?.probeStatus ?? "inspector_unavailable", probeElapsedMs: state?.probeElapsedMs, totalProbeMs: state?.totalProbeMs };
			if (state?.exists !== true || state.pidMatches !== true || !["responsive", "timeout"].includes(state.probeStatus)) {
				record.nativeProbeUnknowns = (record.nativeProbeUnknowns ?? 0) + 1;
				notice({ nativeResponsive: null, probeStatus: state?.probeStatus ?? "inspector_unavailable", heartbeatAgeMs: Math.round(now() - record.lastHeartbeat), blocked: record.nativeProbeUnknowns >= 2 });
				return;
			}
			record.nativeProbeUnknowns = 0;
			if (state.responding === true && state.probeStatus === "responsive") {
				if (record.nativeResponsiveSince === undefined) {
					record.nativeResponsiveSince = now();
					notice({ nativeResponsive: true, ...record.lastNativeProbe, heartbeatAgeMs: Math.round(now() - record.lastHeartbeat) });
				}
				if (now() - record.nativeResponsiveSince >= nativeNoticeMs && !record.nativeDelayReported) {
					record.nativeDelayReported = true;
					notice({ nativeResponsive: true, prolonged: true, ...record.lastNativeProbe, heartbeatAgeMs: Math.round(now() - record.lastHeartbeat) });
				}
				return;
			} else if (state.responding === false && state.probeStatus === "timeout") await recover("ui-heartbeat-timeout", record);
		} finally { pending = false; if (inspectionGeneration !== generation()) record.nativeProbePending = false; }
	};
}
