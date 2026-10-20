type Datum = { state: string; reason: string | null; ageMs: number | null; data: unknown };
type Observation = { connected: boolean; refreshing: boolean; bridge: Datum; session: Datum; summary: Datum; production: Datum };
export function ageObservation<T extends Observation>(observation: T | null, elapsedMs: number, disconnected = false): T | null {
	if (!observation) return null;
	function qualify(value: Datum) {
		const ageMs = typeof value.ageMs === "number" && Number.isFinite(value.ageMs) ? Math.max(0, value.ageMs + Math.max(0, elapsedMs)) : null;
		const expired = disconnected || ageMs === null || ageMs > 15000;
		return { ...value, ageMs, ...(value.data && expired ? { state: "stale", reason: disconnected ? "UI_CONNECTION_UNAVAILABLE" : value.reason } : {}) };
	}
	return { ...observation, connected: !disconnected && observation.connected, refreshing: !disconnected && observation.refreshing, bridge: qualify(observation.bridge), session: qualify(observation.session), summary: qualify(observation.summary), production: qualify(observation.production) };
}
