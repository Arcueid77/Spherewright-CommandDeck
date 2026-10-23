const known = new Set(["GAME_LEDGER_SCHEMA_UNSUPPORTED", "GAME_LEDGER_SCHEMA_UNKNOWN", "WORKBENCH_SCHEMA_TOO_NEW", "WORKBENCH_SCHEMA_UNKNOWN", "STARTUP_STORAGE_UNAVAILABLE", "STARTUP_FAILED"]);

export function startupFailureCode(error) {
	if (known.has(error?.message)) return error.message;
	if (/^ERR_SQLITE(?:_|$)/.test(error?.code ?? "")) return "STARTUP_STORAGE_UNAVAILABLE";
	if (["ENOSPC", "EACCES", "EPERM", "EROFS", "EIO"].includes(error?.code)) return "STARTUP_STORAGE_UNAVAILABLE";
	return "STARTUP_FAILED";
}

export function startupFailurePage(code) {
	const safeCode = known.has(code) || code === "STARTUP_STORAGE_UNAVAILABLE" ? code : "STARTUP_FAILED";
	const newer = ["GAME_LEDGER_SCHEMA_UNSUPPORTED", "WORKBENCH_SCHEMA_TOO_NEW"].includes(safeCode);
	const message = newer ? "当前版本无法读取已有任务资料。请使用创建这些资料的版本或兼容的新版本。" : "启动时无法读取必要的任务资料。请保留原资料，检查磁盘状态或联系维护者。";
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>CommandDeck · 启动受阻</title><style>body{margin:0;padding:36px;background:#111923;color:#e7edf5;font:16px/1.7 system-ui,sans-serif}h1{font-size:23px;margin:0 0 18px}p{margin:12px 0}code{color:#9bb5d2;font-size:12px}small{color:#b4c0ce}</style></head><body><h1>CommandDeck 启动受阻</h1><p>${message}</p><p>未自动执行任务，也未删除或重建原任务记录。</p><p><small>关闭此窗口即可退出。修复问题后可重新启动。</small></p><code>${safeCode}</code></body></html>`;
}
