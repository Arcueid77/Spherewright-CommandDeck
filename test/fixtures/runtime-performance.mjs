export const runtimePerformanceFixture = () => ({
	version: 1, source: 'unity_update_stopwatch_v1', scope: 'plugin-process', state: 'ready',
	sampleCount: 60, sampleCapacity: 600, completedUpdates: 61, windowDurationMs: 1000, sampleAgeMs: 3,
	updateInterval: { meanMs: 1000 / 60, p95Ms: 18, maxMs: 40, privateToken: 'PRIVATE_SYNTHETIC_TOKEN' },
	bridgePump: { meanMs: 0.25, p95Ms: 0.5, maxMs: 1.5 },
	pendingMainThreadRequests: 2, mainThreadQueueCapacity: 32, lastProcessedMainThreadRequests: 1,
	maxRequestsPerFrame: 4, mainThreadBudgetMs: 2, saveName: 'PRIVATE_SYNTHETIC_SAVE',
});
