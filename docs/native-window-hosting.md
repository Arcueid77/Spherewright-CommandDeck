# Native window hosting: game-owned host prototype

## Decision

Keep the directly interactive native viewport as the target. The current prototype uses a simulated game process that owns the stable top-level host and its native viewport. The Electron UI is a disposable foreign child of that host, with a native window-region hole exposing the viewport.

This is a real HWND parent/child composition, not video capture or an independently positioned game window. It has only been implemented with our own simulator. DSP, Unity's message loop, Steam startup and an actual game-side adapter are not qualified by these tests.

## Why the first experiment was rejected

The first fixture experiment put a simulated game window under a Deck-owned parent. Closing the parent ended that fixture process. This is evidence against that ownership arrangement; it does not prove every Unity configuration behaves identically. The prototype therefore refuses DSP attachment through that path and does not start DSP.

The user selected continued research into true embedding, initially using simulator windows, rather than replacing the target with independent-window composition.

## Ownership and failure behavior

~~~text
Simulated game process
  stable top-level host
    native game viewport (same process)
    Electron UI window (foreign, replaceable process)

Deck / control channel may disappear without owning or destroying the viewport.
~~~

The simulator keeps restoration evidence for the UI window's exact PID/start time/HWND, a unique window-lifetime property, style and position before adoption. It verifies the parent and real child/popup styles after native calls. Normal detachment verifies the restored parent, styles and bounds. A missing lifetime marker is not treated as a safe detach. If the UI process exits, the simulator retains its own viewport and expands it to the host. If the stdio control channel closes, the simulator restores the UI and remains alive.

Foreign-window capture, adoption, geometry and restoration run through one serial worker gate, away from the host UI thread. Resize bursts coalesce into the latest desired geometry; status distinguishes requested/applied layout revisions and pending operations. Detachment stops new layout work, drains the original in-flight layout, then restores the UI. A failed operation remains visible and is not automatically replayed.

Earlier hidden launches could announce readiness before the native window was visible. Both fixture windows now explicitly show themselves and read back visibility before readiness. The Electron smoke checks host and UI-child visibility after adoption. These are native visibility checks, not human visual or input acceptance.

Synthetic telemetry uses a bounded output queue written off the native UI thread. Backpressure may drop fixture telemetry, and does not freeze that thread; close acknowledgement is flushed before normal exit. This lossy simulator transport is not a game-action receipt ledger. Host initialization and requests have bounded waits; a timeout does not automatically spawn a replacement or replay an operation.

Normal simulator-host exit detaches the UI first. Test cleanup terminates only PIDs created by the test harness; no DSP process is launched, inspected for gameplay state, loaded, saved or terminated.

## Verified automated scope

`npm run test:native` checks:

- The viewport and stable host belong to the same simulated game PID; the foreign UI is actually parented to that host.
- Viewport region/size updates, invalid rectangles, and normal detachment.
- Synthetic click, drag, wheel and key messages target only the simulator's own control and reach its handlers. This is not proof of physical input routing or DSP behavior.
- Simulated Deck-process exit leaves the simulated game alive.
- Bridge EOF leaves both processes alive, with the UI restored.
- Normal simulated game-host exit leaves the UI alive and detached.
- A bounded telemetry burst while the controller stops reading is processed by the native UI before the controller resumes reading.
- Fixture readiness includes visible windows, and detachment restores original styles and bounds.

The Electron smoke also reloads and deliberately crashes its own renderer. The simulated game retains the same owner PID, and the model probe is not submitted again. These are synthetic tests, not save/recovery or game-action evidence.

## Two-second UI hang: original failure and bounded fix

`npm run probe:native-hang` deliberately sleeps the disposable WinForms UI fixture's thread for two seconds. It separately measures host status and host resizing while that UI is hung. On the local 2026-10-20 run, status returned in about 1 ms, but resize took about 2005 ms. Both simulator processes survived. No actual Electron or DSP process was hung by this probe.

At the `633674d` baseline, the host's resize handler synchronously called `SetWindowPos` on its foreign UI child. The ownership inversion fixed the tested exit cases but did not isolate host resizing from a hung UI. That probe recorded the blocked conclusion even when its CI job completed successfully.

The current implementation keeps those native calls synchronous on the worker, so a completed submission is not mistaken for an applied layout. On the local bounded regression, host status took about 0 ms and host resizing about 5 ms during the two-second UI hang. The probe waits for applied layout revisions to catch up, then separately detaches during another pending layout and verifies original styles/bounds with no late geometry afterward. It now fails if responsiveness or restoration regresses; `.local/native-hang-probe.json` retains the measurements. This fixes the measured resize stall, not every input-queue or indefinite-hang scenario.

The choice is consistent with [SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos): frame changes involve window-message processing, and its asynchronous flag is conditional on different input queues. The prototype instead tests actual completion on a worker and never interprets a timeout as native cancellation.

## Remaining real-game questions

### Focused UI hang and bounded test-supervisor recovery

`npm run probe:native-focus` adds one responsive baseline, then focuses the UI fixture on its own thread before a two-second hang. The input command reaches the simulated game during that declared hang. Per-call monotonic timings locate about 2018 ms between the markers immediately before and after `viewport.Focus()`; capture and the remaining synthetic messages are fast. This is a focused-fixture counterexample, not a physical-input test. The collector may exit normally while its `conclusion` remains `focused_foreign_ui_stalls_native_input`.

This matches the documented [automatic input-queue attachment for cross-thread parent/child windows](https://devblogs.microsoft.com/oldnewthing/20130607-00/?p=4143). Moving explicit layout calls off the UI thread does not change which thread owns its HWND.

`npm run test:native-ui-recovery` injects a five-second focused UI hang and leaves an old layout pending. An independent Node test controller terminates only its registered UI creation handle after one second. It waits for the actual exit event, retains the original input promise, observes the host UI timer resume, then replaces and adopts one UI. The original host/viewport HWNDs remain unchanged; the new UI independently reports native parent/bounds matching the host after layout completion. The local hang-start-to-input-completion sample is about 1023 ms. Signed exit-relative timing, exit result and pending layout revisions are retained in the synthetic JSON artifact.

`owned-ui-process.mjs` accepts registration only for children created by its UI launcher. Ordinary game-fixture children, forged PID objects and attempts to retarget an existing termination capability are rejected. This is a trusted application launch boundary, not operating-system isolation from editable code. No arbitrary adopted PID gains termination authority.

The recovery test supports bounded recovery after ending the known UI; it does not demonstrate uninterrupted input while that UI remains hung. Its independent controller is currently a test harness. Before a real DSP adapter, the actual Electron HWND-owning process must be disposable independently of Pi and host control. A heartbeat must represent its UI loop, and rescue cannot wait for the blocked host UI thread or the layout gate. Only one replacement is in this experiment; persistent task storage is still a later milestone.

### Current local native references

Read-only installation checks match the Lab native lock's `Assembly-CSharp.dll` SHA-256 `EF314425DADE51F529F184F07BE136CD3C2660A6A81515603C7226FBE7AB1D8C`. The executable and `UnityPlayer.dll` file version are `2022.3.62.1451004`; BepInEx's file version is `5.4.17.0`. Metadata inspection finds `Application.get_unityVersion/get_platform/get_isEditor` and `Screen.get_fullScreenMode/get_width/get_height/SetResolution` in the installed CoreModule. These are file/metadata facts, not a running-game check or permission to change display settings.

The candidate integration boundary is a separate CommandDeck game-side BepInEx window adapter, with no game-world API or save access. The current WinForms fixture cannot be loaded into Unity. Steam startup, graphics readiness and restoration still require their own exact-version proof. No adapter was deployed and no DSP process was started for these checks.

### Unqualified scope

1. A game-side adapter must create the stable host within the DSP process and cooperate with Unity's actual window/message lifecycle. The WinForms simulator is not that adapter, and cannot simply be loaded into Unity.
2. Determine the supported startup, window-style, DPI and graphics-ready sequence from the exact current Unity/runtime. Do not alter game assemblies or use an external memory/injection route.
3. Prove native mouse/keyboard focus, capture, cursor release, Alt-Tab, resizing, docking overlays and monitor changes on DSP. Do not infer these from synthetic messages.
4. Define native-input takeover relative to the game's action writer. Hosting ownership alone does not serialize manual input against prepare/commit.
5. Qualify game, renderer, Deck and host failures separately under Lab rules. A restarted game or older save is not a viewport recovery strategy.
6. The focused fixture proves a remaining input wait despite the resize fix. The test controller demonstrates one finite recovery; actual Electron process supervision, a hung host thread, indefinite UI hangs, physical input during a hang and abrupt host-process death remain unqualified. The user explicitly has not performed the manual input check; this is not a passing result.

Real integration will require an independently reviewed, narrow game-side implementation and a supported deployment/validation cohort. Until then, DSP attachment and game-action tools stay closed.
