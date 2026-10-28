import React, { useState } from "react";
import type { DockviewApi, IDockviewHeaderActionsProps, SerializedDockview } from "dockview-react";

export const popoutPage = "deck-ui://app/popout.html";
const mainOnly = new Set(["game", "videos"]);

export function checkPopoutLayout(layout: SerializedDockview) {
	const groups = layout.popoutGroups ?? [];
	if (!Array.isArray(groups) || groups.length > 8) throw new Error("INVALID_POPOUT_LAYOUT");
	const check = (value: unknown, depth = 0): void => {
		if (depth > 32) throw new Error("INVALID_POPOUT_LAYOUT");
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) { for (const item of value) check(item, depth + 1); return; }
		for (const [key, item] of Object.entries(value)) {
			if (key === "views" && Array.isArray(item) && item.some(id => mainOnly.has(id))) throw new Error("MAIN_WINDOW_PANEL");
			check(item, depth + 1);
		}
	};
	for (const group of groups) {
		if (group.url && group.url !== popoutPage) throw new Error("INVALID_POPOUT_URL");
		check(group);
	}
	return layout;
}

export function configurePopouts(api: DockviewApi) {
	let unloading = false;
	// Registered before Dockview's popup close listeners: returning panels during
	// opener unload must not overwrite the saved multi-window arrangement.
	window.addEventListener("beforeunload", () => { unloading = true; });
	const keepNativePanelsInMain = (event: Parameters<Parameters<typeof api.onWillDrop>[0]>[0]) => {
		if (event.group?.api.location.type !== "popout") return;
		const data = event.getData();
		if (data && (data.panelId ? mainOnly.has(data.panelId) : api.getGroup(data.groupId)?.panels.some(panel => mainOnly.has(panel.id)))) event.preventDefault();
	};
	api.onWillDrop(keepNativePanelsInMain);
	api.onDidAddPopoutGroup(({ window: child, group }) => {
		const notice = child.document.createElement("div");
		notice.className = "popout-modal-notice";
		notice.setAttribute("role", "status");
		notice.textContent = "请先完成主窗口中的对话框。";
		child.document.body.append(notice);
		const synchronize = () => {
			if (child.closed) return;
			const content = child.document.querySelector<HTMLElement>(".dv-popout-window"), blocked = Boolean(document.body.dataset.deckOverlay);
			if (content) content.inert = blocked;
			notice.hidden = !blocked;
			child.document.title = `${group.activePanel?.title ?? "工作台"} · Spherewright CommandDeck`;
		};
		window.addEventListener("deck-overlay", synchronize);
		const active = group.api.onDidActivePanelChange(synchronize);
		synchronize();
		child.addEventListener("unload", () => { active.dispose(); window.removeEventListener("deck-overlay", synchronize); }, { once: true });
	});
	return { canSave: () => !unloading };
}

export function PopoutActions({ activePanel, containerApi }: IDockviewHeaderActionsProps) {
	const [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
	if (!activePanel || mainOnly.has(activePanel.id)) return null;
	const outside = activePanel.api.location.type === "popout";
	async function move() {
		if (!activePanel || pending || document.body.dataset.deckOverlay) return;
		setPending(true); setFailed(false);
		try {
			if (outside) {
				const target = containerApi.groups.find(group => group.api.location.type === "grid");
				activePanel.api.moveTo(target ? { group: target } : { position: "right" });
			} else if (!await containerApi.addPopoutGroup(activePanel, { popoutUrl: popoutPage })) setFailed(true);
		} catch { setFailed(true); }
		finally { setPending(false); }
	}
	return <div className="popout-actions">
		<button data-popout-panel={activePanel.id} disabled={pending} onClick={() => void move()} title={outside ? "将此面板放回主窗口" : "在独立窗口中继续使用此面板"}>{outside ? "收回主窗口" : "独立窗口"}</button>
		{failed && <span role="status">窗口未打开，面板已保留</span>}
	</div>;
}
