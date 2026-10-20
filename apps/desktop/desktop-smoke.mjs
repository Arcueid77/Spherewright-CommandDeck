import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedUi } from "./inspect-ui.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 6000, code = "DESKTOP_PROOF_TIMEOUT") {
	const deadline = performance.now() + ms;
	while (!(await check())) {
		if (performance.now() > deadline) throw new Error(code);
		await delay(50);
	}
}
async function eventWithin(promise, ms = 15000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("SUPERVISION_EVENT_TIMEOUT")),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
export async function runDesktopSmoke(driver) {
	const { native, api, testCommand, events } = driver;
	const evaluate = (source) => testCommand("evaluate", { source });
	const option = (name) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	const probe = process.argv.includes("--smoke-live")
		? {
				mode: "live",
				providerId: option("--provider"),
				modelId: option("--model"),
			}
		: { mode: "offline" };
	const result = await evaluate(
		`(async()=>{await window.deck.startFixture();await window.deck.attach('owned-fixture');return {title:document.title,panels:document.querySelectorAll('.dv-groupview').length,nodeExposed:typeof require!=='undefined',native:await window.deck.status(),probe:await window.deck.probe(${JSON.stringify(probe)})};})()`,
	);
	result.runId = driver.runId;
	assert.equal(result.panels, 4);
	assert.equal(result.nodeExposed, false);
	for (const key of [
		"attached",
		"hostVisible",
		"uiVisible",
		"uiChildStyle",
		"nativeParentMatches",
		"gameParentMatches",
	])
		assert.equal(result.native[key], true, key);
	assert.equal(result.native.gameOwnerPid, result.native.hostOwnerPid);
	assert.equal(result.probe.executed, 1);
	assert.equal(result.probe.requestCount, 2);
	assert.equal(result.probe.finalStopReason, "stop");
	assert.deepEqual(result.probe.active, ["deck_echo"]);
	assert.deepEqual(result.probe.callable, ["deck_echo"]);
	const originalIdentity = await native.request("fixture-identity");
	const runtimePid = driver.getRuntimePid(),
		originalUi = driver.getUi();
	await testCommand("reload");
	result.afterReload = await api("status");
	assert.equal(result.afterReload.hostOwnerPid, result.native.hostOwnerPid);
	await testCommand("renderer-crash");
	result.afterRendererCrash = await api("status");
	assert.equal(result.afterRendererCrash.gameAlive, true);
	assert.equal(
		result.afterRendererCrash.hostOwnerPid,
		result.native.hostOwnerPid,
	);
	assert.equal(driver.getUi().child.pid, originalUi.child.pid);
	// A healthy UI must remain alive for more than a watchdog interval.
	await delay(2200);
	assert.equal(driver.getUi().epoch, originalUi.epoch);
	if (process.argv.includes("--smoke-host-exit")) {
		assert.ok(native.fixture.child.spawnargs.includes("--owned-host-fixture"));
		const exited = once(native.fixture.child, "exit");
		native.fixture.child.kill();
		await eventWithin(exited);
		let nativeUi;
		await until(
			async () => {
				try {
					const record = driver.getUi();
					nativeUi = await inspectOwnedUi(record);
					return (
						record === driver.getUi() &&
						record.loaded &&
						nativeUi.exists &&
						nativeUi.pidMatches &&
						nativeUi.visible &&
						!nativeUi.childStyle &&
						!nativeUi.parentPresent &&
						(await evaluate(
							"document.querySelectorAll('.dv-groupview').length",
						)) === 4
					);
				} catch {
					return false;
				}
			},
			10000,
			"UI_LOST_AFTER_HOST_EXIT",
		);
		assert.equal(driver.getRuntimePid(), runtimePid);
		assert.equal(driver.getProbeSequence(), 1);
		assert.equal((await api("status")).attached, false);
		assert.equal(native.fixture.stopped, true);
		result.hostExit = {
			simulatorOnly: true,
			workbenchSurvived: true,
			nativeUiVisible: nativeUi.visible,
			nativeUiTopLevel: !nativeUi.childStyle && !nativeUi.parentPresent,
			registeredUiPidMatches: nativeUi.pidMatches,
			uiReplacements: driver.getUi().epoch - originalUi.epoch,
			samePiRuntime: true,
			probeNotReplayed: true,
			hostNotRelaunched: true,
			physicalInput: "not_tested",
		};
		for (const name of ["native", "afterReload", "afterRendererCrash"]) {
			const { targetPid, gameOwnerPid, hostOwnerPid, ...portable } =
				result[name];
			result[name] = portable;
		}
		await mkdir(join(driver.root, ".local"), { recursive: true });
		await writeFile(
			join(driver.root, ".local/desktop-smoke-host-exit.json"),
			JSON.stringify(result, null, 2),
		);
		return;
	}
	const recovery = once(events, "recovered"),
		hangStarted = once(events, "ui-hang-start");
	const focusResult = await testCommand("focus");
	await until(
		async () => (await api("status")).uiThreadHasFocus === true,
		6000,
		"ELECTRON_UI_FOCUS_NOT_PROVEN",
	);
	let activeProbeCompletedAt;
	const activeProbe = api("probe", { mode: "offline" }).then((value) => {
		activeProbeCompletedAt = performance.now();
		return value;
	});
	activeProbe.catch(() => {});
	await until(
		() => driver.getState().busy && driver.getState().currentProbeToolFinished,
	);
	const expectedProbeSequence = driver.getProbeSequence();
	driver.beginUiHang();
	const [hang] = await eventWithin(hangStarted);
	const enteredAt = performance.now();
	const inputPromise = native.request("exercise-input");
	inputPromise.catch(() => {});
	const input = await inputPromise;
	const inputCompletedAt = performance.now();
	const [recovered] = await eventWithin(recovery);
	const activeResult = await activeProbe;
	assert.equal(activeResult.executed, 1);
	assert.equal(activeResult.requestCount, 2);
	assert.equal(recovered.reason, "ui-heartbeat-timeout");
	assert.equal(recovered.exitConfirmed, true);
	assert.ok(
		activeProbeCompletedAt > recovered.exitConfirmedAt,
		"Probe completed before the UI exit",
	);
	assert.ok(
		inputCompletedAt - hang.receivedAt < 4500,
		"Input only completed after the natural five-second recovery",
	);
	assert.ok(
		recovered.nativeRecoveredAt - recovered.exitConfirmedAt < 750,
		"Host recovery exceeded the test budget",
	);
	assert.equal(driver.getRuntimePid(), runtimePid);
	assert.equal(driver.getProbeSequence(), expectedProbeSequence);
	assert.equal(driver.getState().lastProbeResult.executed, 1);
	assert.deepEqual(await native.request("fixture-identity"), originalIdentity);
	assert.equal((await api("status")).attached, false);
	const restored = await evaluate("window.deck.snapshot()");
	assert.equal(restored.lastProbeResult.executed, 1);
	await until(
		async () =>
			(
				await evaluate(
					"document.querySelector('.agent pre')?.textContent ?? ''",
				)
			).includes("commanddeck-m0"),
		6000,
		"RESTORED_PROBE_NOT_DISPLAYED",
	);
	await api("attach", "owned-fixture");
	assert.deepEqual(await native.request("fixture-identity"), originalIdentity);
	assert.equal((await api("status")).attached, true);
	result.supervision = {
		healthyUiSurvived: true,
		actualElectronUiLoopHung: true,
		nativeFocusEstablished: true,
		registeredUiExitConfirmed: true,
		inputRequestLatencyMs: Math.round(inputCompletedAt - enteredAt),
		watchdogThresholdMs: driver.watchdogMs,
		heartbeatAgeAtDecisionMs: Math.round(recovered.heartbeatAgeMs),
		inputTrace: input.trace,
		uiReplacements: 1,
		samePiRuntime: true,
		inFlightProbeCompleted: true,
		inFlightProbeCompletedAfterUiExit: true,
		intentionalProbeCount: expectedProbeSequence,
		sameHostAndViewport: true,
		restoredProbeResultWithoutReplay: true,
		reattachedOnce: true,
		physicalInput: "not_tested",
		realDsp: "not_connected",
	};
	result.sameHostAfterReload = true;
	result.sameHostAfterRendererCrash = true;
	result.noProbeReplay = driver.getProbeSequence() === expectedProbeSequence;
	if (process.argv.includes("--smoke-recovery-limit")) {
		const limited = once(events, "recovery-limit");
		driver.beginUiHang();
		await eventWithin(limited);
		const stoppedEpoch = driver.getUi().epoch;
		await delay(2200);
		assert.equal(driver.getUi().epoch, stoppedEpoch);
		assert.ok(
			driver.getUi().child.exitCode !== null ||
				driver.getUi().child.signalCode !== null,
		);
		const standalone = await api("status");
		assert.equal(standalone.gameAlive, true);
		assert.equal(standalone.viewportFull, true);
		assert.equal(driver.getProbeSequence(), expectedProbeSequence);
		result.recoveryLimit = {
			automaticUiReplacements: 1,
			noFurtherAutomaticUi: true,
			hostLeftStandalone: true,
			noProbeReplay: true,
		};
	}
	for (const name of ["native", "afterReload", "afterRendererCrash"]) {
		const { targetPid, gameOwnerPid, hostOwnerPid, ...portable } = result[name];
		result[name] = portable;
	}
	await mkdir(join(driver.root, ".local"), { recursive: true });
	await writeFile(
		join(
			driver.root,
			process.argv.includes("--smoke-recovery-limit")
				? ".local/desktop-smoke-recovery-limit.json"
				: probe.mode === "live"
					? ".local/desktop-smoke-live.json"
					: ".local/desktop-smoke.json",
		),
		JSON.stringify(result, null, 2),
	);
}
