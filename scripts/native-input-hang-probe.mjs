import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	NativeClient,
	nativeExecutable,
} from "../apps/desktop/native-client.mjs";
import { registerOwnedUi } from "../apps/desktop/owned-ui-process.mjs";

const executable = process.argv.includes("--isolated-build")
	? fileURLToPath(
			new URL(
				"../.local/native-hang/CommandDeck.NativeHost.exe",
				import.meta.url,
			),
		)
	: nativeExecutable;
const ui = new NativeClient(["--fixture"], executable);
const game = new NativeClient(["--owned-host-fixture"], executable);
const recoverOwnUi = process.argv.includes("--recover-own-ui");
const ownUi = registerOwnedUi(ui.child);
let replacement;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("FOCUS_PROBE_TIMEOUT")),
					6000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
try {
	const metadata = await ui.ready;
	await game.ready;
	await game.request("adopt", metadata);
	const originalIdentity = await game.request("fixture-identity");
	assert.throws(() => ownUi.terminate(game.child), /UI_PROCESS_NOT_REGISTERED/);
	assert.throws(
		() => registerOwnedUi(game.child),
		/UI_CREATION_HANDLE_REQUIRED/,
	);
	assert.throws(
		() => ownUi.terminate({ pid: ui.child.pid }),
		/UI_PROCESS_NOT_REGISTERED/,
	);
	assert.equal(game.child.exitCode, null);
	const baselineAt = performance.now();
	const baseline = await game.request("exercise-input");
	const baselineInputLatencyMs = Math.round(performance.now() - baselineAt);
	const started = once(ui, "diagnostic");
	ui.child.stdin.write(
		recoverOwnUi ? "focus-and-hang-ui-long\n" : "focus-and-hang-ui\n",
	);
	const diagnostic = (await bounded(started))[0];
	assert.equal(diagnostic.phase, "ui-hang-start");
	assert.equal(diagnostic.focused, true);
	assert.equal(diagnostic.durationMs, recoverOwnUi ? 5000 : 2000);
	const recovered = once(ui, "diagnostic");
	const heartbeatBefore = (await game.request("status")).uiHeartbeatCount;
	let oldPendingLayout;
	if (recoverOwnUi) {
		await game.request("exercise-host-resize");
		const pending = await game.request("status");
		assert.equal(pending.layoutPending, true);
		assert.ok(pending.layoutRequested > pending.layoutApplied);
		oldPendingLayout = {
			requested: pending.layoutRequested,
			applied: pending.layoutApplied,
		};
	}
	const start = performance.now();
	let inputSettled = false;
	let inputCompletedAt, uiExitedAt, terminationSubmitted, terminationExit;
	const inputReply = game
		.request("exercise-input")
		.then((value) => {
			inputCompletedAt = performance.now();
			return value;
		})
		.finally(() => {
			inputSettled = true;
		});
	inputReply.catch(() => {}); // Preserve the original promise while the independent watchdog waits.
	let terminatedOwnUi = false;
	if (recoverOwnUi) {
		await delay(1000);
		if (!inputSettled) {
			const exited = once(ui.child, "exit");
			// This is the exact ChildProcess handle created by this probe, never a game PID.
			terminationSubmitted = ownUi.terminate();
			assert.equal(terminationSubmitted, true);
			const [code, signal] = await bounded(exited);
			terminationExit = { code, signal };
			uiExitedAt = performance.now();
			terminatedOwnUi = true;
		}
	}
	const input = await inputReply;
	if (recoverOwnUi)
		assert.equal(
			terminatedOwnUi,
			true,
			"Watchdog did not interrupt the five-second hang",
		);
	const inputLatencyMs = Math.round(performance.now() - start);
	const hangStartToInputCompletionMs =
		(Number(BigInt(input.finishedTicks) - BigInt(diagnostic.ticks)) * 1000) /
		input.clockFrequency;
	const endDiagnostic = !terminatedOwnUi
		? (await bounded(recovered))[0]
		: undefined;
	assert.equal(input.clockFrequency, diagnostic.clockFrequency);
	assert.ok(BigInt(input.startedTicks) >= BigInt(diagnostic.ticks));
	if (endDiagnostic)
		assert.ok(BigInt(input.startedTicks) < BigInt(endDiagnostic.ticks));
	assert.ok(input.clicks > 0 && input.keys > 0 && input.wheel > 0);
	let state = await game.request("status");
	if (terminatedOwnUi) {
		const deadline = Date.now() + 4000;
		while (
			!state.viewportFull ||
			state.uiOperationPending ||
			state.uiHeartbeatCount <= heartbeatBefore
		) {
			if (Date.now() > deadline) throw new Error("OWNED_UI_RECOVERY_TIMEOUT");
			await delay(50);
			state = await game.request("status");
		}
		assert.equal(state.attached, false);
		assert.equal(state.gameAlive, true);
		assert.equal(state.targetPid, game.child.pid);
		assert.ok(inputLatencyMs < 1750);
		assert.ok(
			hangStartToInputCompletionMs < diagnostic.durationMs - 500,
			"Input completed near natural recovery",
		);
		assert.ok(
			performance.now() - uiExitedAt < 750,
			"Host did not recover within 750 ms after UI exit",
		);
		replacement = new NativeClient(["--fixture"], executable);
		const newUi = await replacement.ready;
		assert.throws(
			() => ownUi.terminate(replacement.child),
			/UI_PROCESS_NOT_REGISTERED/,
		);
		await game.request("adopt", newUi);
		await game.request("rect", {
			x: 260,
			y: 80,
			width: 760,
			height: 480,
			visible: true,
		});
		assert.deepEqual(await game.request("fixture-identity"), originalIdentity);
		const adoptedState = await game.request("status");
		assert.equal(adoptedState.attached, true);
		assert.equal(adoptedState.layoutError, null);
		assert.equal(adoptedState.layoutApplied, adoptedState.layoutRequested);
		const boundsDeadline = Date.now() + 4000;
		while (
			replacement.latest?.parent !== originalIdentity.hostHwnd ||
			replacement.latest?.windowWidth !== adoptedState.clientWidth ||
			replacement.latest?.windowHeight !== adoptedState.clientHeight
		) {
			if (Date.now() > boundsDeadline)
				throw new Error("REPLACEMENT_BOUNDS_NOT_PROVEN");
			await delay(50);
		}
		const firstFrame = replacement.latest.frameSequence;
		const repeatAfter = Date.now() + 350;
		const repeatDeadline = Date.now() + 4000;
		while (
			Date.now() < repeatAfter ||
			replacement.latest.frameSequence <= firstFrame
		) {
			if (Date.now() > repeatDeadline)
				throw new Error("NO_FRESH_REPLACEMENT_SAMPLE");
			await delay(25);
		}
		assert.equal(replacement.latest.parent, originalIdentity.hostHwnd);
		assert.equal(replacement.latest.windowWidth, adoptedState.clientWidth);
		assert.equal(replacement.latest.windowHeight, adoptedState.clientHeight);
	}
	const proof = {
		fixtureOnly: true,
		gameCalls: 0,
		injectedUiHangMs: diagnostic.durationMs,
		foreignUiFocused: true,
		baselineInputLatencyMs,
		baselineTrace: baseline.trace,
		inputLatencyMs,
		inputTrace: input.trace,
		nativeHandlersResponsiveDuringHang:
			!terminatedOwnUi && inputLatencyMs < 750,
		wrongTerminationIdentity: "rejected_before_termination",
		bothSurvived: state.gameAlive && !ui.stopped,
		terminatedOwnUi,
		gameSurvived: state.gameAlive,
		originalInputReplyRecovered: true,
		...(terminatedOwnUi
			? {
					watchdogThresholdMs: 1000,
					recoveryWithinBudget: true,
					inputCompletionRelativeToExitMs: Math.round(
						inputCompletedAt - uiExitedAt,
					),
					hangStartToInputCompletionMs,
					terminationSubmitted,
					terminationExit,
					oldPendingLayout,
					terminatedBeforeNaturalRecovery:
						hangStartToInputCompletionMs < diagnostic.durationMs - 500,
					replacementUiCount: 1,
					originalHostAndViewportUnchanged: true,
					replacementNativeBoundsAndParentVerified: true,
				}
			: {}),
		conclusion: terminatedOwnUi
			? "test_supervisor_restored_game_without_input_replay"
			: inputLatencyMs < 750
				? "bounded_focused_fixture_probe_only"
				: "focused_foreign_ui_stalls_native_input",
		physicalInput: "not_tested",
		realDsp: "not_connected",
	};
	await mkdir(".local", { recursive: true });
	await writeFile(
		recoverOwnUi
			? ".local/native-input-recovery-probe.json"
			: ".local/native-input-hang-probe.json",
		JSON.stringify(proof, null, 2),
	);
	console.log(JSON.stringify(proof));
} finally {
	try {
		if (!game.stopped) await game.request("close");
	} catch {}
	if (replacement && !replacement.stopped) {
		const exited = once(replacement.child, "exit");
		replacement.child.stdin.write("close\n");
		try {
			await bounded(exited);
		} catch {
			registerOwnedUi(replacement.child).terminate();
		}
	}
	if (!ui.stopped) {
		const exited = once(ui.child, "exit");
		ui.child.stdin.write("close\n");
		try {
			await bounded(exited);
		} catch {
			ui.child.kill();
		}
	}
	if (!game.stopped) {
		await delay(100);
		if (!game.stopped) game.child.kill();
	}
}
