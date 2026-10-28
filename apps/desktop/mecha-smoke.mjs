import assert from "node:assert/strict";

export async function runMechaPanelSmoke(driver, { evaluate, until }) {
	const state = () => driver.api("bridge", { action: "snapshot" }), runtime = driver.getRuntimePid(), client = driver.getBridgePid();
	const initial = await state(); assert.equal(initial.observation.mechaEnabled, false); assert.equal(initial.observation.mecha.data, null);
	assert.ok(initial.metadata.readTools.includes("spherewright_get_player_state"));
	const open = async () => {
		await until(() => evaluate("(()=>{const button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='只读舰桥'&&!button.disabled);if(!button)return false;button.click();return true})()"), "MECHA_HEADER");
		await until(() => evaluate("(()=>{const tab=[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()==='机甲');if(!tab)return false;tab.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}));return true})()"), "MECHA_TAB");
		await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"机甲状态\"]'))"), "MECHA_PANEL");
	};
	const click = async label => {
		await until(() => evaluate(`(()=>{const button=[...document.querySelectorAll('[aria-label="机甲状态"] button')].find(button=>button.textContent===${JSON.stringify(label)}&&!button.disabled);if(!button)return false;button.click();return true})()`), "MECHA_CONTROL");
	};
	await open(); await click("开始机甲观测");
	await until(async () => (await state()).observation.mecha?.state === "observed", "MECHA_DATA");
	const observed = (await state()).observation.mecha;
	assert.equal(observed.data.coreEnergyFraction, 0.75); assert.equal(observed.data.position.y, -20); assert.equal(observed.data.speedMetresPerSecond, 12.5);
	assert.equal(observed.data.fuelStorage[0].count, 18); assert.equal(observed.data.constructionDrones.working, 1); assert.equal(observed.data.constructionDrones.pendingBuildTargets, 0);
	assert.ok(!JSON.stringify(observed).includes("PRIVATE_SYNTHETIC"));
	await until(() => evaluate("(()=>{const text=document.querySelector('[aria-label=\"机甲状态\"]')?.textContent;return Boolean(text?.includes('75%')&&text.includes('12.5')&&text.includes('Synthetic fuel')&&text.includes('Synthetic craft'))})()"), "MECHA_RENDERED");
	const bounds = await evaluate("(()=>{const rect=document.querySelector('[aria-label=\"机甲状态\"]').getBoundingClientRect();return {width:rect.width,height:rect.height}})()"); assert.ok(bounds.width > 0 && bounds.height > 0);
	await driver.testCommand("reload"); await open();
	assert.equal((await state()).observation.mechaEnabled, true); assert.deepEqual((await state()).observation.mecha.data, observed.data);
	assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getBridgePid(), client);
	await click("暂停机甲观测"); await until(async () => !(await state()).observation.mechaEnabled, "MECHA_PAUSED");
	assert.equal((await state()).observation.mecha.state, "stale"); assert.deepEqual((await state()).observation.mecha.data, observed.data);
	await click("开始机甲观测"); await until(async () => (await state()).observation.mecha?.state === "observed", "MECHA_RESUMED");
	assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getBridgePid(), client); assert.equal(driver.getProbeSequence(), 0);
	return { mechaReadOnlyPanelVerified: true, mechaExplicitOptInVerified: true, mechaPauseAndResumeVerified: true, mechaPrivateFieldsOmitted: true, mechaUiReloadRetainsSameObserver: true, mechaEnabledBeforeDisconnect: true };
}
