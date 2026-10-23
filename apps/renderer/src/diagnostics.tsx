import React, { useEffect, useRef, useState } from "react";

export type DiagnosticOptions = { includeTasks: boolean; includePerformance: boolean };
export type DiagnosticPreview = { id: string; text: string; sha256: string; bytes: number; expiresInMs: number; fileName: string };
export type DiagnosticSave = { saved?: boolean; cancelled?: boolean; fileName?: string; sha256?: string; bytes?: number };

function failure(error: unknown) {
	const message = error instanceof Error ? error.message : "";
	if (message.includes("DIAGNOSTIC_DESTINATION_EXISTS")) return "该文件已存在。请重新生成预览，并选择一个新文件名。";
	if (message.includes("DIAGNOSTIC_PROTECTED_DESTINATION")) return "请将报告保存到应用安装目录和私人资料目录之外。";
	if (message.includes("DIAGNOSTIC_PREVIEW_EXPIRED") || message.includes("DIAGNOSTIC_PREVIEW_REQUIRED") || message.includes("DIAGNOSTIC_UI_CHANGED")) return "这份预览已失效，请重新生成。";
	if (message.includes("DIAGNOSTIC_WRITE_UNCONFIRMED")) return "保存结果无法确认，目标位置可能留下不完整文件。请检查后重新生成预览，选择新文件名保存。";
	return "操作未完成。请重新生成预览；如果已经选择保存位置，请先检查是否留下文件，再选择新文件名。";
}

export function DiagnosticDialog({ close }: { close: () => void }) {
	const [options, setOptions] = useState<DiagnosticOptions>({ includeTasks: true, includePerformance: true });
	const [preview, setPreview] = useState<DiagnosticPreview | null>(null), [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("选择报告内容，然后生成预览。"), [status, setStatus] = useState("empty");
	const dialog = useRef<HTMLElement>(null), active = useRef(false), sequence = useRef(0), current = useRef<DiagnosticPreview | null>(null);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null; dialog.current?.focus();
		return () => { sequence.current++; if (current.current) void window.deck.discardDiagnosticPreview(current.current.id).catch(() => {}); previous?.focus(); };
	}, []);
	function clearPreview() {
		const old = current.current; current.current = null; setPreview(null);
		if (old) void window.deck.discardDiagnosticPreview(old.id).catch(() => {});
	}
	function choose(key: keyof DiagnosticOptions, value: boolean) {
		if (active.current) return; sequence.current++; clearPreview(); setOptions(previous => ({ ...previous, [key]: value })); setStatus("empty"); setNotice("内容选项已变更，请生成新的预览。");
	}
	async function generate() {
		if (active.current) return; active.current = true; setBusy(true); clearPreview();
		const selected = ++sequence.current; setStatus("generating"); setNotice("正在读取现有记录…");
		try {
			const value = await window.deck.diagnosticPreview(options);
			if (selected !== sequence.current) { void window.deck.discardDiagnosticPreview(value.id).catch(() => {}); return; }
			current.current = value; setPreview(value); setStatus("preview"); setNotice("请检查下方完整内容。保存会使用这份预览，预览在五分钟后失效。");
		} catch (error) { if (selected === sequence.current) { setStatus("error"); setNotice(failure(error)); } }
		finally { active.current = false; if (selected === sequence.current) setBusy(false); }
	}
	async function save() {
		if (active.current || !current.current) return; active.current = true; setBusy(true);
		const selected = ++sequence.current, value = current.current; setStatus("saving"); setNotice("请选择保存位置。已有文件不会被覆盖。");
		try {
			const result = await window.deck.saveDiagnosticPreview(value.id);
			if (selected !== sequence.current) return;
			if (result.cancelled) { setStatus("preview"); setNotice("已取消保存，仍可保存这份预览。"); }
			else { if (!result.saved || result.sha256 !== value.sha256 || result.bytes !== value.bytes) throw new Error("DIAGNOSTIC_WRITE_UNCONFIRMED"); clearPreview(); setStatus("saved"); setNotice("已保存：" + result.fileName + "。内容与刚才的预览一致。"); }
		} catch (error) { if (selected === sequence.current) { clearPreview(); setStatus("error"); setNotice(failure(error)); } }
		finally { active.current = false; if (selected === sequence.current) setBusy(false); }
	}
	return <div className="settings-backdrop"><section className="diagnostic-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="诊断报告" aria-busy={busy} data-diagnostic-state={status} onKeyDown={event => {
		if (event.key === "Escape") { event.preventDefault(); if (!active.current) close(); }
		if (event.key === "Tab") { const elements = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex='0']")], first = elements[0], last = elements.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); } }
	}}>
		<div className="settings-heading"><h2>诊断报告</h2><button disabled={busy} onClick={close}>关闭</button></div>
		<p>报告包含版本、运行状态和所选的结构化记录。密钥、私人路径、世界身份、聊天内容及命令输出均省略。</p>
		<div className="diagnostic-options"><label><input type="checkbox" checked={options.includeTasks} disabled={busy} onChange={event => choose("includeTasks", event.target.checked)} />任务阶段与错误</label><label><input type="checkbox" checked={options.includePerformance} disabled={busy} onChange={event => choose("includePerformance", event.target.checked)} />已有性能指标</label></div>
		<p className="muted">最多包含最近 8 项开发任务、8 项游戏任务及各自的有限事件。缺失数据和截断会在报告中标明；生成报告不发送模型或游戏请求。</p>
		<div className="actions"><button disabled={busy} onClick={() => void generate()}>生成预览</button><button className="accent" disabled={busy || !preview} onClick={() => void save()}>保存这份预览</button></div>
		<p role="status" className="notice">{notice}</p>
		{preview && <><p className="muted">{preview.bytes.toLocaleString()} 字节 · SHA-256：<span className="diagnostic-hash">{preview.sha256}</span></p><pre aria-label="诊断报告完整预览" tabIndex={0}>{preview.text}</pre></>}
	</section></div>;
}
