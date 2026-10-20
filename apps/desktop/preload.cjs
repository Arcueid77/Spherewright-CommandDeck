const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
	"deck",
	Object.freeze({
		status: () => ipcRenderer.invoke("deck:status"),
		focusUi: () => ipcRenderer.invoke("deck:focus-ui"),
		snapshot: () => ipcRenderer.invoke("deck:snapshot"),
		profiles: () => ipcRenderer.invoke("deck:profiles"),
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
