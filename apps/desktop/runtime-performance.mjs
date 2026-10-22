const integer = value => Number.isSafeInteger(value) && value >= 0;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const absent = (state, reason) => ({ state, reason, data: null, receivedAt: null });
function statistics(value) {
	if (!value || !['meanMs', 'p95Ms', 'maxMs'].every(key => number(value[key])) || value.meanMs > value.maxMs || value.p95Ms > value.maxMs) throw new Error('INVALID_RUNTIME_STATISTICS');
	return { meanMs: value.meanMs, p95Ms: value.p95Ms, maxMs: value.maxMs };
}

// Accept only the documented optional process-level contract; never forward arbitrary status fields.
export function runtimePerformanceDatum(value, statusReadStartedAt) {
	if (value == null || value.version !== 1) return absent('unsupported', 'RUNTIME_PERFORMANCE_UNSUPPORTED');
	try {
		if (value.source !== 'unity_update_stopwatch_v1' || value.scope !== 'plugin-process'
			|| !['sampleCount', 'sampleCapacity', 'completedUpdates', 'pendingMainThreadRequests', 'mainThreadQueueCapacity', 'lastProcessedMainThreadRequests', 'maxRequestsPerFrame'].every(key => integer(value[key]))
			|| value.sampleCapacity < 1 || value.sampleCapacity > 600 || value.sampleCount > value.sampleCapacity
			|| value.completedUpdates < (value.sampleCount ? value.sampleCount + 1 : 0)
			|| value.mainThreadQueueCapacity < 1 || value.pendingMainThreadRequests > value.mainThreadQueueCapacity
			|| value.maxRequestsPerFrame < 1 || value.lastProcessedMainThreadRequests > value.maxRequestsPerFrame
			|| !number(value.mainThreadBudgetMs) || value.mainThreadBudgetMs === 0 || !number(value.windowDurationMs)
			|| (value.completedUpdates ? !number(value.sampleAgeMs) : value.sampleAgeMs !== null)
			|| value.state !== (value.sampleCount >= Math.min(30, value.sampleCapacity) ? 'ready' : 'warming_up')) throw new Error('INVALID_RUNTIME_PERFORMANCE');
		const updateInterval = value.sampleCount ? statistics(value.updateInterval) : null;
		const bridgePump = value.sampleCount ? statistics(value.bridgePump) : null;
		if (!value.sampleCount && (value.updateInterval !== null || value.bridgePump !== null || value.windowDurationMs !== 0)) throw new Error('INVALID_EMPTY_RUNTIME_WINDOW');
		const data = Object.fromEntries(['version', 'source', 'scope', 'sampleCount', 'sampleCapacity', 'completedUpdates', 'windowDurationMs', 'sampleAgeMs', 'pendingMainThreadRequests', 'mainThreadQueueCapacity', 'lastProcessedMainThreadRequests', 'maxRequestsPerFrame', 'mainThreadBudgetMs'].map(key => [key, value[key]]));
		return { state: value.state === 'ready' ? 'observed' : 'warming_up', reason: null, receivedAt: statusReadStartedAt - (value.sampleAgeMs ?? 0), data: { ...data, updateInterval, bridgePump } };
	} catch { return absent('unavailable', 'RUNTIME_PERFORMANCE_INVALID'); }
}
