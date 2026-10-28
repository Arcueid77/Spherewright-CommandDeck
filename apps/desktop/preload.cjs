const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
	"deck",
	Object.freeze({
		status: () => ipcRenderer.invoke("deck:status"),
		focusUi: () => ipcRenderer.invoke("deck:focus-ui"),
		snapshot: () => ipcRenderer.invoke("deck:snapshot"),
		resumeSystem: () => ipcRenderer.invoke("deck:resume-system"),
		journal: (action, args = {}) => ipcRenderer.invoke("deck:journal", { action, args }),
		modelUsage: () => ipcRenderer.invoke("deck:model-usage"),
		video: (action, args = {}) => ipcRenderer.invoke("deck:video", { action, args }),
		recording: (action, args = {}) => ipcRenderer.invoke("deck:recording", { action, args }),
		profiles: () => ipcRenderer.invoke("deck:profiles"),
		manageProfiles: (action, args = {}) => ipcRenderer.invoke("deck:profiles-manage", { action, args }),
		bridge: (action, args = {}) => ipcRenderer.invoke("deck:bridge", { action, args }),
		chooseBridge: () => ipcRenderer.invoke("deck:choose-bridge"),
		game: (action, args = {}) => ipcRenderer.invoke("deck:game", { action, args }),
		confirmResearch: (taskId) => ipcRenderer.invoke("deck:confirm-research", { taskId }),
		diagnosticPreview: (options) => ipcRenderer.invoke("deck:diagnostic-preview", options),
		saveDiagnosticPreview: (id) => ipcRenderer.invoke("deck:diagnostic-save", id),
		discardDiagnosticPreview: (id) => ipcRenderer.invoke("deck:diagnostic-discard", id),
		targets: () => ipcRenderer.invoke("deck:targets"),
		attach: (targetId) => ipcRenderer.invoke("deck:attach", targetId),
		detach: () => ipcRenderer.invoke("deck:detach"),
		startFixture: () => ipcRenderer.invoke("deck:start-fixture"),
		viewport: (rect) => ipcRenderer.invoke("deck:viewport", rect),
		probe: (config) => ipcRenderer.invoke("deck:probe", config),
		abort: () => ipcRenderer.invoke("deck:abort"),
		workbench: (action, args = {}) => ipcRenderer.invoke("deck:workbench", { action, args }),
		addWorkspace: () => ipcRenderer.invoke("deck:add-workspace"),
		onEvent: (callback) => {
			const handler = (_event, data) => callback(data);
			ipcRenderer.on("deck:event", handler);
			return () => ipcRenderer.removeListener("deck:event", handler);
		},
	}),
);
