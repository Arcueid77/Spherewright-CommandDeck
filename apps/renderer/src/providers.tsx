import React, { useEffect, useRef, useState } from "react";

export type Profile = { providerId: string; modelId: string; api: string; label?: string; source?: "external" | "protected" };
type Store = { available: boolean; revision: string | null; profiles: Profile[]; external: Profile[] };
type Form = { id: string; label: string; api: string; baseUrl: string; modelId: string; contextWindow: number; maxTokens: number; revision: string | null; credentialPresent?: boolean };
const manage = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.manageProfiles<T>(action, args);
export const profileToken = (profile: Profile) => JSON.stringify([profile.providerId, profile.modelId]);

export function ProviderSettings({ close }: { close: () => void }) {
	const [store, setStore] = useState<Store | null>(null), [form, setForm] = useState<Form | null>(null), [key, setKey] = useState("");
	const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [removeArmed, setRemoveArmed] = useState(false);
	const sequence = useRef(0);
	const dialog = useRef<HTMLElement>(null);
	useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.querySelector("button")?.focus(); return () => { previous?.focus(); }; }, []);
	const report = () => setNotice("配置操作未完成。请检查输入、任务状态，或重新打开此页刷新；原有配置不会被重置。");
	useEffect(() => { let current = true; void manage<Store>("list").then((value) => { if (current) setStore(value); }).catch(report); return () => { current = false; sequence.current++; }; }, []);
	function clear() { sequence.current++; setKey(""); setForm(null); setRemoveArmed(false); }
	function create() { clear(); setNotice(""); setForm({ id: "deckvault-" + crypto.randomUUID(), label: "", api: "openai-completions", baseUrl: "", modelId: "", contextWindow: 32768, maxTokens: 2048, revision: store!.revision }); }
	async function select(id: string) { clear(); const selected = sequence.current; try { const value = await manage<Form>("describe", { id }); if (selected === sequence.current) setForm(value); } catch { report(); } }
	async function save(event: React.FormEvent) {
		event.preventDefault(); if (!form) return; setBusy(true); setNotice("");
		try { await manage("save", { ...form, apiKey: key, expectedRevision: form.revision }); clear(); setStore(await manage<Store>("list")); setNotice("模型配置已保存在本机。可以返回开发 Agent 选择它。"); }
		catch { report(); } finally { setKey(""); setBusy(false); }
	}
	async function remove() {
		if (!form) return; setBusy(true);
		try { await manage("remove", { id: form.id, expectedRevision: form.revision }); clear(); setStore(await manage<Store>("list")); setNotice("配置已删除，历史任务保留。"); }
		catch { report(); } finally { setKey(""); setBusy(false); }
	}
	const update = (field: keyof Form, value: string | number) => setForm((current) => current ? { ...current, [field]: value } : null);
	return <div className="settings-backdrop"><section ref={dialog} className="provider-settings" role="dialog" aria-modal="true" aria-label="模型设置" onKeyDown={(event) => {
		if (event.key === "Escape") { event.preventDefault(); if (!busy) close(); }
		if (event.key === "Tab") { const elements = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)")], first = elements[0], last = elements.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
	}}>
		<div className="settings-heading"><h2>模型设置</h2><button disabled={busy} onClick={close}>完成</button></div>
		<p>现有 CC Switch / Pi 配置可直接使用。也可以在这里单独添加服务。</p>
		{store && <><div className="provider-list"><b>此工作台的配置</b>{store.profiles.map((profile) => <button disabled={busy} key={profile.providerId} onClick={() => void select(profile.providerId)}>{profile.label} · {profile.modelId}</button>)}<button disabled={busy || !store.available} onClick={create}>添加模型服务</button></div>
		{!store.available && <p className="notice">当前系统无法使用受保护存储，请继续使用已有 Pi 配置。</p>}
		{form && <form onSubmit={(event) => void save(event)} autoComplete="off"><fieldset disabled={busy}>
			<label>名称<input aria-label="配置名称" maxLength={80} required value={form.label} onChange={(event) => update("label", event.target.value)} /></label>
			<label>接口<select aria-label="模型接口" value={form.api} onChange={(event) => update("api", event.target.value)}><option value="openai-completions">OpenAI 兼容 Chat Completions</option><option value="anthropic-messages">Anthropic 兼容 Messages</option></select></label>
			<label>服务地址<input aria-label="服务地址" placeholder="https://example.com/v1" maxLength={2048} required value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
			<label>模型 ID<input aria-label="模型 ID" maxLength={200} required value={form.modelId} onChange={(event) => update("modelId", event.target.value)} /></label>
			<div className="provider-limits"><label>上下文上限<input aria-label="上下文上限" type="number" min={4096} max={2097152} required value={form.contextWindow} onChange={(event) => update("contextWindow", Number(event.target.value))} /></label><label>输出上限<input aria-label="输出上限" type="number" min={128} max={131072} required value={form.maxTokens} onChange={(event) => update("maxTokens", Number(event.target.value))} /></label></div>
			<label>API 密钥<input aria-label="API 密钥" type="password" autoComplete="new-password" spellCheck={false} maxLength={16384} required={!form.credentialPresent} placeholder={form.credentialPresent ? "留空沿用已保存密钥" : "仅保存在此电脑"} value={key} onChange={(event) => setKey(event.target.value)} /></label>
			<p className="muted">密钥由 Windows 保护保存。此类服务在一轮回复完成后显示内容，费用仍为未知。</p>
			<div className="actions"><button type="submit" className="accent">保存配置</button><button type="button" onClick={clear}>取消</button>{form.credentialPresent && <button type="button" onClick={() => removeArmed ? void remove() : setRemoveArmed(true)}>{removeArmed ? "确认删除此配置" : "删除配置"}</button>}</div>
		</fieldset></form>}
		<div className="external-providers"><b>来自 CC Switch / Pi</b>{store.external.length ? store.external.map((profile) => <p key={profileToken(profile)}>{profile.modelId} · {profile.api}</p>) : <p>未发现可用配置。</p>}<p className="muted">在原管理工具中修改，不会自动迁移密钥。</p></div></>}
		{notice && <p role="status" className="notice">{notice}</p>}
	</section></div>;
}
