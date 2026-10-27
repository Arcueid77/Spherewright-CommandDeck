// The supervisor owns the tray. Replacing a disposable UI never creates another.
export function createDesktopTray({ Tray, Menu, nativeImage, open, exit, notice }) {
	const size = 32, pixels = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const radius = Math.hypot(x - 15.5, y - 15.5), ring = radius >= 10 && radius <= 14;
		const cross = radius < 7 && (Math.abs(x - 15.5) < 2 || Math.abs(y - 15.5) < 2);
		if (!ring && !cross) continue;
		const offset = (y * size + x) * 4;
		pixels.set(ring ? [230, 210, 60, 255] : [255, 255, 255, 255], offset);
	}
	const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
	if (image.isEmpty()) throw new Error("TRAY_IMAGE_UNAVAILABLE");
	const tray = new Tray(image);
	let destroyed = false, pending = null, menu;
	const update = () => {
		if (destroyed) return;
		menu = Menu.buildFromTemplate([
			{ id: "open", label: "打开 CommandDeck", enabled: !pending, click: () => { void activate("open"); } },
			{ label: "关闭主窗口会退出应用", enabled: false },
			{ type: "separator" },
			{ id: "exit", label: pending === "exit" ? "正在退出…" : "退出 CommandDeck", enabled: !pending, click: () => { void activate("exit"); } },
		]);
		tray.setContextMenu(menu);
	};
	async function activate(action) {
		if (!["open", "exit"].includes(action)) throw new Error("UNKNOWN_TRAY_ACTION");
		if (destroyed || pending) return false;
		pending = action; update();
		try { await (action === "open" ? open() : exit()); return true; }
		catch { notice(action === "open" ? "TRAY_OPEN_FAILED" : "TRAY_EXIT_BLOCKED"); return false; }
		finally { pending = null; update(); }
	}
	const clicked = () => { void activate("open"); };
	try {
		tray.setToolTip("Spherewright CommandDeck");
		tray.on("double-click", clicked); update();
	} catch (error) { tray.destroy(); throw error; }
	return {
		activate,
		get menu() { return menu; },
		get nativeTray() { return tray; },
		destroy() { if (destroyed) return; destroyed = true; tray.removeListener("double-click", clicked); tray.destroy(); },
	};
}
