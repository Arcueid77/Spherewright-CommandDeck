import { popoutUrl, rendererUrl } from "./renderer-protocol.mjs";

export function popoutGeometry(features, areas) {
	if (typeof features !== "string" || features.length > 200 || !areas?.length) return null;
	const values = {};
	for (const feature of features.split(",")) {
		const pair = /^(top|left|width|height)=(-?\d+(?:\.\d+)?)$/.exec(feature.trim());
		if (!pair || Object.hasOwn(values, pair[1])) return null;
		values[pair[1]] = Number(pair[2]);
	}
	if (Object.keys(values).length !== 4 || Object.values(values).some(value => !Number.isFinite(value) || Math.abs(value) > 1000000) || values.width <= 0 || values.height <= 0) return null;
	const requested = { x: values.left, y: values.top, width: values.width, height: values.height };
	return visiblePopoutBounds(requested, areas);
}
export function visiblePopoutBounds(bounds, areas) {
	// Keep the entire frame reachable after screen removal, resize or DPI change.
	const area = areas.reduce((best, next) => {
		const distance = a => Math.hypot(bounds.x + bounds.width / 2 - (a.x + a.width / 2), bounds.y + bounds.height / 2 - (a.y + a.height / 2));
		return distance(next) < distance(best) ? next : best;
	});
	const width = Math.min(area.width, Math.max(360, Math.round(bounds.width)));
	const height = Math.min(area.height, Math.max(240, Math.round(bounds.height)));
	return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height };
}

export function managePopoutWindows({ owner, BrowserWindow, screen, closing }) {
	const windows = new Map();
	const areas = () => screen.getAllDisplays().map(display => display.workArea);
	const closeAll = () => { for (const child of [...windows.values()]) if (!child.isDestroyed()) child.destroy(); };
	const recoverScreens = () => {
		const available = areas(); if (!available.length) return;
		for (const child of windows.values()) if (!child.isDestroyed()) {
			const bounds = visiblePopoutBounds(child.getBounds(), available);
			child.setMinimumSize(Math.min(360, bounds.width), Math.min(240, bounds.height));
			child.setBounds(bounds);
		}
	};
	owner.webContents.setWindowOpenHandler(details => {
		const bounds = popoutGeometry(details.features, areas());
		if (closing() || owner.isDestroyed() || owner.webContents.getURL() !== rendererUrl || details.url !== popoutUrl || !/^[A-Za-z0-9_-]{1,80}$/.test(details.frameName) || details.frameName.startsWith("_") || windows.has(details.frameName) || windows.size >= 8 || !bounds) return { action: "deny" };
		return {
			action: "allow", outlivesOpener: false,
			createWindow(options) {
				const child = new BrowserWindow({ ...options, ...bounds, minWidth: Math.min(360, bounds.width), minHeight: Math.min(240, bounds.height), show: false, backgroundColor: "#0b1119", title: "Spherewright CommandDeck", webPreferences: { ...options.webPreferences, preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false } });
				windows.set(details.frameName, child);
				child.removeMenu();
				child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
				let loaded = false;
				// window.open's initial navigation is renderer-initiated too. Admit
				// that exact empty page once, then forbid replacement documents.
				const navigation = (event, url) => { if (loaded || event.isMainFrame === false || (event.url ?? url) !== popoutUrl) event.preventDefault(); };
				child.webContents.on("will-navigate", navigation);
				child.webContents.on("will-frame-navigate", navigation);
				const loadTimer = setTimeout(() => { if (!loaded && !child.isDestroyed()) child.destroy(); }, 10000);
				child.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (loaded && mainFrame && !child.isDestroyed()) child.close(); });
				child.webContents.once("did-finish-load", () => { loaded = true; clearTimeout(loadTimer); if (!child.isDestroyed()) child.show(); });
				child.webContents.on("render-process-gone", () => { if (!child.isDestroyed()) child.destroy(); });
				child.on("closed", () => { clearTimeout(loadTimer); windows.delete(details.frameName); });
				return child.webContents;
			},
		};
	});
	owner.webContents.on("did-start-loading", closeAll);
	owner.webContents.on("render-process-gone", closeAll);
	screen.on("display-removed", recoverScreens);
	screen.on("display-added", recoverScreens);
	screen.on("display-metrics-changed", recoverScreens);
	owner.on("closed", () => { closeAll(); screen.removeListener("display-removed", recoverScreens); screen.removeListener("display-added", recoverScreens); screen.removeListener("display-metrics-changed", recoverScreens); });
	return { windows, closeAll };
}
