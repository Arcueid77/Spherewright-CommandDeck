// Capture source identifiers stay in the trusted host. This validates identity
// evidence; it does not prove Chromium can capture a child HWND or grant access.
export function boundCaptureSource(value, descriptor) {
	const window = value?.window, source = value?.captureSource;
	if (value?.windowCaptureSource !== 1) throw new Error("WINDOW_CAPTURE_UNSUPPORTED");
	if (!descriptor || value.gamePid !== descriptor.gamePid || value.gameStartedTicks !== descriptor.gameStartedTicks || value.kind !== descriptor.kind || value.adapterVersion !== descriptor.adapterVersion) throw new Error("WINDOW_CAPTURE_IDENTITY_CHANGED");
	if (value.ready !== true || value.quarantined !== false || value.fault != null || window?.active !== true || window.attached !== true || window.gameAlive !== true || window.gameParentMatches !== true || window.nativeParentMatches !== true || window.hostVisible !== true || window.uiVisible !== true || window.uiOperationPending !== false || window.fault != null || !Number.isSafeInteger(window.layoutApplied) || window.layoutApplied < 0 || window.layoutApplied !== window.layoutRequested) throw new Error("WINDOW_CAPTURE_NOT_READY");
	if (source?.version !== 1 || typeof source.hwnd !== "string" || !/^[1-9][0-9]{0,18}$/.test(source.hwnd) || BigInt(source.hwnd) > 9223372036854775807n || source.sourceId !== `window:${source.hwnd}:0` || typeof source.windowBinding !== "string" || !/^[a-f0-9]{32}$/.test(source.windowBinding) || source.layoutRevision !== window.layoutApplied || ![source.width, source.height].every(value => Number.isInteger(value) && value > 0 && value <= 32768)) throw new Error("WINDOW_CAPTURE_SOURCE_UNCONFIRMED");
	return Object.freeze({ version: 1, sourceId: source.sourceId, windowBinding: source.windowBinding, width: source.width, height: source.height, layoutRevision: window.layoutApplied, gamePid: descriptor.gamePid, gameStartedTicks: descriptor.gameStartedTicks, kind: descriptor.kind });
}
