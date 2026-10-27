// This gate never enumerates sources or permits camera/microphone access.
export function recordingPermissionGate({ owner, url, generation, authorize }) {
	let armed;
	const valid = state => Boolean(state && armed === state && generation() === state.generation && !owner.isDestroyed() && owner.mainFrame?.url === url);
	const permission = (contents, name) => contents === owner && name === "display-capture" && valid(armed);
	return {
		arm(permit) { if (typeof permit !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(permit)) throw new Error("VIDEO_CAPTURE_CHANGED"); armed = { permit, generation: generation(), used: false }; },
		revoke() { armed = null; },
		permission,
		async display(request, callback) {
			const state = armed;
			if (!valid(state) || state.used || request.frame !== owner.mainFrame || request.videoRequested !== true || request.audioRequested !== false || request.userGesture !== true || !owner.isFocused()) { callback(null); return; }
			state.used = true;
			try { const source = await authorize(state.permit, state.generation); if (!valid(state) || request.frame !== owner.mainFrame || typeof source?.id !== "string" || !/^window:[1-9][0-9]{0,18}:0$/.test(source.id)) { callback(null); return; } callback({ video: { id: source.id, name: "选定游戏视口" } }); }
			catch { callback(null); }
		},
	};
}
