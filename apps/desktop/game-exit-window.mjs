import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execute = promisify(execFile);
const equalIdentity = (a, b) => a && b && ["sourceId", "windowBinding", "gamePid", "gameStartedTicks", "kind", "targetId"].every(key => a[key] === b[key]);

export async function captureStableGameWindow(native, timeoutMs = 3000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		try { return await native.captureSource(); }
		catch (error) {
			if (!["WINDOW_CAPTURE_NOT_READY", "WINDOW_CAPTURE_HOST_UNAVAILABLE", "WINDOW_CAPTURE_TRANSITION_PENDING"].includes(error?.message) || performance.now() >= deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
}

// This runs only after the trusted original save/menu receipt. It sends one
// normal close to the exact restored DSP HWND; it never terminates a process.
export async function closeRestoredGameWindow(native, original, run = execute, env = process.env) {
	if (!original || original.kind !== "dsp" || !Number.isSafeInteger(original.gamePid) || original.gamePid <= 0
		|| !/^[0-9]{15,20}$/.test(original.gameStartedTicks ?? "") || !/^window:[1-9][0-9]{0,18}:0$/.test(original.sourceId ?? "")) throw new Error("GAME_EXIT_WINDOW_IDENTITY_UNAVAILABLE");
	const fresh = await captureStableGameWindow(native);
	if (!equalIdentity(original, fresh)) throw new Error("GAME_EXIT_WINDOW_CHANGED");
	const restored = await native.request("detach");
	if (restored?.attached !== false || restored?.fault) throw new Error("GAME_EXIT_WINDOW_RESTORATION_UNPROVED");
	if (typeof env.SystemRoot !== "string" || !env.SystemRoot) throw new Error("GAME_EXIT_PROCESS_INSPECTOR_UNAVAILABLE");
	const handle = original.sourceId.split(":")[1];
	const script = "$ErrorActionPreference='Stop';$p=Get-Process -Id ([int]$env:COMMANDDECK_EXIT_PID) -ErrorAction Stop;" +
		"if($p.ProcessName -ne 'DSPGAME' -or [IO.Path]::GetFileName($p.Path) -ine 'DSPGAME.exe' -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $env:COMMANDDECK_EXIT_STARTED -or $p.MainWindowHandle.ToInt64().ToString() -ne $env:COMMANDDECK_EXIT_HWND){throw 'GAME_EXIT_IDENTITY_CHANGED'};" +
		"if(-not $p.CloseMainWindow()){throw 'GAME_EXIT_CLOSE_REFUSED'};if(-not $p.WaitForExit(25000)){throw 'GAME_EXIT_OUTCOME_UNKNOWN'};'GAME_EXIT_CONFIRMED'";
	const executable = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	let reply;
	try { reply = await run(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000, maxBuffer: 4096, env: { ...env, COMMANDDECK_EXIT_PID: String(original.gamePid), COMMANDDECK_EXIT_STARTED: original.gameStartedTicks, COMMANDDECK_EXIT_HWND: handle } }); }
	catch { throw new Error("GAME_EXIT_OUTCOME_UNKNOWN"); }
	if (reply.stdout?.trim() !== "GAME_EXIT_CONFIRMED") throw new Error("GAME_EXIT_OUTCOME_UNKNOWN");
	return { gameExited: true, normalClose: true };
}
