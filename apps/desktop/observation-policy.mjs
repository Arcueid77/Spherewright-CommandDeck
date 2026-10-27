export function observationLimits(value) {
	if (value === undefined || value === null) return null;
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['maxToolRequests', 'maxDurationMs'].includes(key)) || !Number.isSafeInteger(value.maxToolRequests) || value.maxToolRequests < 1 || value.maxToolRequests > 256 || !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1000 || value.maxDurationMs > 300000) throw new Error('INVALID_OBSERVATION_LIMITS');
	return Object.freeze({ maxToolRequests: value.maxToolRequests, maxDurationMs: value.maxDurationMs });
}
export function observationArguments(args) {
	const names = ['--observe-only', '--observe-max-tools', '--observe-max-ms'], values = new Map();
	for (let index = 0; index < args.length; index++) {
		const key = args[index];
		if (!key.startsWith('--observe-')) continue;
		if (!names.includes(key) || values.has(key)) throw new Error('INVALID_OBSERVATION_ARGUMENT');
		if (key === '--observe-only') values.set(key, true);
		else { const value = args[++index]; if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value)) throw new Error('INVALID_OBSERVATION_ARGUMENT'); values.set(key, Number(value)); }
	}
	if (!values.size) return null;
	if (values.get('--observe-only') !== true) throw new Error('OBSERVATION_MODE_REQUIRED');
	return observationLimits({ maxToolRequests: values.get('--observe-max-tools') ?? 40, maxDurationMs: values.get('--observe-max-ms') ?? 20000 });
}
export function assertObservationAction(policy, action, args) {
	if (!policy) return;
	const denied = action === 'game' && args?.action !== 'snapshot'
		|| action === 'recording' && !['snapshot', 'cancel', 'closed'].includes(args?.action)
		|| ['game-confirmation', 'game-confirmed', 'probe', 'attach', 'start-fixture'].includes(action)
		|| action === 'workbench' && !['state', 'task', 'refresh', 'list', 'read', 'diff', 'change-diff', 'read-reference', 'search', 'checks', 'ui-get', 'ui-save'].includes(args?.action)
		|| action === 'profiles-manage' && !['list', 'describe'].includes(args?.action);
	if (denied) throw new Error('READ_ONLY_OBSERVATION_MODE');
}
