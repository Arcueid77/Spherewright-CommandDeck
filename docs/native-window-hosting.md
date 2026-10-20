# Native window hosting: game-owned host prototype

## Decision

Keep the directly interactive native viewport as the target. The current prototype uses a simulated game process that owns the stable top-level host and its native viewport. The Electron UI is a disposable foreign child of that host, with a native window-region hole exposing the viewport.

This is a real HWND parent/child composition, not video capture or an independently positioned game window. Automated fault evidence uses our own simulators. A separate game-side adapter has also completed one real DSP empty-menu embedding/restoration/re-embedding cycle, detailed below. Those native checks do not qualify rendered pixels, physical input or real-game fault recovery.

## Why the first experiment was rejected

The first fixture experiment put a simulated game window under a Deck-owned parent. Closing the parent ended that fixture process. This is evidence against that ownership arrangement; it does not prove every Unity configuration behaves identically. The prototype therefore refuses DSP attachment through that path and does not start DSP.

The user selected continued research into true embedding, initially using simulator windows, rather than replacing the target with independent-window composition.

## Ownership and failure behavior

~~~text
Game process (simulator, or explicitly enabled DSP adapter)
  stable top-level host
    native game viewport (same process)
    Electron UI window (foreign, replaceable process)

Deck / control channel may disappear without owning or destroying the viewport.
~~~

The simulator keeps restoration evidence for the UI window's exact PID/start time/HWND, a unique window-lifetime property, style and position before adoption. It verifies the parent and real child/popup styles after native calls. Normal detachment verifies the restored parent, styles and bounds. A missing lifetime marker is not treated as a safe detach. If the UI process exits, the simulator retains its own viewport and expands it to the host. If the stdio control channel closes, the simulator restores the UI and remains alive.

Foreign-window capture, adoption, geometry and restoration run through one serial worker gate, away from the host UI thread. Resize bursts coalesce into the latest desired geometry; status distinguishes requested/applied layout revisions and pending operations. Detachment stops new layout work, drains the original in-flight layout, then restores the UI. A failed operation remains visible and is not automatically replayed.

Earlier hidden launches could announce readiness before the native window was visible. Both fixture windows now explicitly show themselves and read back visibility before readiness. The Electron smoke checks host and UI-child visibility after adoption. These are native visibility checks, not human visual or input acceptance.

An `e7d0303` CI run timed out waiting for fixture startup at ten seconds, before the lifecycle tests began; its cause was not established by that log. Fixture startup now reports bounded phase labels and permits up to thirty seconds for a cold launch. Readiness still requires the visible-window reply. The test awaits both fixture starts together and cleans up both owned children if pair construction fails; it does not retry native operations or convert a startup timeout into a pass.

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

The recovery test supports bounded recovery after ending the known UI; it does not demonstrate uninterrupted input while that UI remains hung. Its independent controller is a test harness. The desktop implementation below applies the same bounded design to the actual Electron HWND-owning process. Persistent task storage remains a later milestone.

### Actual Electron UI supervision

The desktop bootstrap starts a windowless Electron supervisor. It owns the native connection, Pi utility process and in-memory probe snapshot; a separately spawned Electron main process owns the BrowserWindow and renderer. The UI registers through its creation IPC channel and sends a heartbeat from its main message thread every 100 ms. The supervisor has its own user-data directory, separate from the disposable UI's Chromium profile.

After a one-second heartbeat deadline, the supervisor terminates only that registered creation handle, waits for confirmed process exit, then waits for the existing native operations to settle. It clears the old binding and creates at most one automatic replacement. It does not replay a probe, restart the host or automatically reattach. A second failure ends the registered UI and stops automatic replacement; an explicit reopen is required. This is a finite application recovery policy, not operating-system isolation or a durable task service.

`npm run test:desktop` first checks a healthy UI across multiple watchdog intervals, reloads the renderer and deliberately crashes that renderer. It then proves native focus belongs to the actual UI process, starts a second offline Pi probe, waits for its one echo tool completion, and freezes the UI main thread for five seconds. The local test terminates that UI around the one-second deadline; the original native input request completes in about 1026 ms, preserving the original host/viewport and Pi process. The same in-flight probe completes after UI exit, with exactly two requests and one echo, and its result appears in the replacement UI. The test explicitly reattaches once. A synthetic offline response delay establishes the in-flight interval; live provider behavior is unchanged.

`npm run test:desktop-host-exit` abruptly ends only the owned simulator process. If inspection cannot prove that the original UI is a visible top-level window, the supervisor replaces that owned UI; this run observed one replacement. A separate read-only native helper checks the exact registered HWND/PID: visible, top-level and no child style. Renderer response, unchanged Pi process and no model replay are checked as well. The helper cannot enumerate or mutate windows. The host is never relaunched. Native visibility plus renderer response is not physical-input acceptance.

`npm run test:desktop-recovery-limit` injects a second UI hang and verifies there is no third UI, no probe replay and the original simulator remains standalone. All three runners require their fresh run ID and completed JSON proof; process exit alone or a previous artifact cannot pass the test. CI uploads only portable synthetic summaries, not Pi sessions, HWNDs or PIDs.

### Current local native references

Read-only installation checks match the Lab native lock's `Assembly-CSharp.dll` SHA-256 `EF314425DADE51F529F184F07BE136CD3C2660A6A81515603C7226FBE7AB1D8C`. The executable and `UnityPlayer.dll` file version are `2022.3.62.1451004`; BepInEx's file version is `5.4.17.0`. Metadata inspection finds `Application.get_unityVersion/get_platform/get_isEditor` and `Screen.get_fullScreenMode/get_width/get_height/SetResolution` in the installed CoreModule. These are file/metadata facts, not a running-game check or permission to change display settings.

The integration candidate is a separate CommandDeck BepInEx window adapter, with no game-world API or save access. The WinForms fixture itself cannot be loaded into Unity. A shared raw Win32 core builds for net472 and net8; the Unity wrapper compiles locally against the private installed BepInEx/Unity references, with no Assembly-CSharp or Spherewright reference. The initial metadata checks did not deploy or start DSP. The later exact-version menu cohort below separately records deployment, Steam startup, Unity updates and restoration; it still does not qualify rendered pixels or input.

### Compiled game-side adapter and protocol

The Unity plugin remains inert without `--commanddeck-host` in that launch. On Unity's main thread it reads the existing window and fullscreen mode, then starts only a window endpoint. It does not change `Screen` settings. The desktop must explicitly select that endpoint before the adapter creates a raw Win32 parent in the game process and reparents the original Unity HWND. The host has its own message thread, inheriting the Unity window's DPI context. Native capture/adoption/layout/restoration stays on a serial worker. The UI stays in the independently supervised Electron process.

Window facts also include the Unity component's update sequence and read-only render width/height, sampled on Unity's main thread. Advancing updates and matching sizes can qualify loop/geometry checks; they cannot prove correct rendered pixels or physical input. No game tick, world or save data is read by this adapter.

The first profile accepts a windowed game and UI on the same 100% scale monitor. Host and game use the same DPI context. Cross-process UI adoption can reset the child process's DPI awareness as described by [SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent); strict context equality also rejected the local Electron/WinForms pair. This candidate therefore limits geometry to the 96-DPI profile, where physical bounds are tested, rather than claiming mixed-DPI support. It requests restoration if the host moves to another monitor or leaves 100% scale. [GetScaleFactorForMonitor](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getscalefactorformonitor) and window-position/timer checks detect that boundary. Real monitor changes and Unity input remain untested.

The adapter publishes one private descriptor per process/start time in the current user's application-data folder, protected by a user-only directory ACL. Its random credential is reusable for that adapter lifetime, not a short-lived single-use token. The pipe is also user restricted. Before sending that credential, the desktop's console-only native transport checks the OS [pipe server PID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid), process start time, session and expected process name. The server separately checks its real client PID/session and the credential. This binds the local endpoint; it does not isolate editable code from the same Windows user.

Frames are bounded to 8192 bytes and JSON depth eight. Only status, activate, adopt, layout, focus, detach and deactivate exist; neither endpoint can save/load, inject input, execute a command or terminate DSP. Unknown methods are denied by the server as well as the desktop transport. Provider credentials never enter this protocol, and descriptor paths/credentials never enter renderer IPC or portable proof artifacts.

Closing the connection restores UI first, then Unity, and destroys the host only after both are proven detached. Failed restoration retains the original host, snapshot, descriptor and restricted status/deactivate endpoint; new activation stays blocked. It does not delete its record or automatically recreate an actor. Malformed UTF-8, invalid hello fields, a hello timeout and a client exit discard only that connection. Descriptor cleanup requires that this instance actually created the file.

The desktop treats helper/pipe exit as unreconciled, not as successful restoration. It keeps the exact endpoint and reports pending/fault, blocking new attachment and fixture selection. A bounded read-only reconnect rechecks the same OS peer and original pipe instance name, and requests no window mutation; replacing the descriptor cannot silently select another adapter lifetime in the same process. It releases that hold only after fresh server proof that the host was fully restored, or an independent OS check proves the original process generation has ended. Explicit detach/close must obtain the restoration proof before clearing the binding. `test:adapter-route` ends only its own helper while the fake game's marker is broken: diagnostics remain reachable, detach fails and the original endpoint stays retained. The fixture is then repaired and explicitly reconciled. A separate clean-EOF and exact process-exit check cover the two successful resolutions.

Layout scheduling makes the completion decision and release of the running flag atomic. A new request either keeps the current pump alive or starts the next one; both orderings have a fixed test. An unexpected `WM_QUIT` or message-loop error cannot simply return from the host thread: it keeps pumping while a worker attempts restoration. Only a destroyed host with both snapshots cleared completes the lifetime. This matters because [thread termination frees its windows](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-thread) and parent destruction affects children.

Local verification includes `test:adapter-layout`, `test:adapter-native`, `test:adapter-bridge` and `test:desktop-adapter`. The pipe fixture uses the shared host/bridge sources without Unity. It tests restoration quarantine by breaking a marker only on its own fake game window, then verifies a fresh client can still read diagnostics while activation is blocked. Repair and deactivation are explicit fixture operations. The desktop test uses the real Electron UI, actual OS peer verification, one UI hang/replacement and a Pi round that completes after UI exit; the original host/viewport remain and normal detachment restores both windows. These results are not Unity runtime or physical-input proof.

The candidate build is `npm run build:unity-adapter`, after `scripts/sync-unity-refs.ps1 -DspDir '<installation>'`. Private references are never distributed. Runtime candidate DLLs are `CommandDeck.UnityAdapter`, `CommandDeck.AdapterBridge`, `CommandDeck.Windowing` and its locked Newtonsoft.Json dependency. The first 10ae8c9 cohort was installed in a separate folder after exact-SHA CI; the original four Spherewright DLLs were hash-checked unchanged. Steam received only per-launch opt-in/window arguments, with no persistent launch-option edit or save command.

That first real attempt loaded and opted in, then failed before publishing its endpoint with `NotImplementedException`. Read-only metadata inspection of the installed Mono libraries proves `WindowsIdentity.get_User` is a six-byte unconditional exception stub; its managed `Process.SessionId` is also a constant-return stub, so it cannot enforce the session boundary. The compatibility change uses the established Spherewright Windows SID/DACL/pipe implementation as independent MIT source, with no product/game dependency. It obtains the process token and protected user ACL through Win32, creates a remote-client-rejecting pipe with that ACL, and queries sessions with `ProcessIdToSessionId`. No permissive ACL fallback is allowed. These code changes and simulator results do not qualify the fix in Mono until a separate cold run.

The published Plugin session read for the first process reports `gameLoaded=false` and no game tick. No window adoption, save or load was requested. A second fresh no-world read preceded its normal window close; the process exited without forced termination. Subsequent cold testing must preserve exact cohort hashes and recheck the actual runtime; it must not load a save to test geometry.

### Real DSP empty-menu cohort: 2026-10-20

The second cohort used implementation commit `e00f56ce5441e3a707a4445a88fd07641a0b8c08`, after [CI 39427237164](https://github.com/Arcueid77/spherewright-commanddeck/actions/runs/39427237164) completed successfully. The locally compiled plugin records that full source revision. Only the four candidate DLLs in the separate CommandDeck addon folder were replaced; the original four Spherewright plugin DLLs still matched their recorded hashes. Neither the product source checkout nor its mixed worktree was changed.

Steam started DSP normally with the per-launch opt-in/window arguments. The loaded Unity runtime reported `2022.3.62f3c1`; the private descriptor, native pipe peer and exact process/start generation matched. The endpoint became readable in this same process without descriptor modification or a game restart. No window host existed before explicit desktop selection. Published `get_session_state` reads immediately before both attachments and the intervening desktop shutdown reported `gameLoaded=false` with no game tick.

The bounded sequence was:

1. Explicit desktop attachment created the game-owned parent and adopted the real Unity window plus disposable Electron UI. Native game/UI parent checks, host/UI visibility, 96 DPI and requested/applied layout revision `7/7` passed with no pending operation or fault. Unity updates advanced across the one-second observation; its render size was `1398×954`.
2. Normal Deck shutdown restored the original windows before exiting. A fresh authenticated connection reported `restorationProven=true`, no active host, no attached UI, no quarantine and no fault. The same DSP process generation remained alive and Unity updates advanced; render size returned to `2556×1440`. The adapter requires original parent/styles/bounds readback and a successful placement-restoration call before destroying its host; placement is not separately read back. This was not an independent pixel or human-input check.
3. One new, explicit attachment of that same endpoint again passed both parent checks, native visibility, settled layout `2/2`, 96 DPI and advancing Unity updates, with render size `1398×954` and no fault. Deck and DSP were left open for human inspection. No automatic reattachment or operation retry was used.

Apart from the published read-only session checks, the validation entries issued no game action, save/load or model call. No game input, process hang, crash or forced game termination was injected. This qualifies the compatibility fix and one normal native menu lifecycle on this machine, not physical focus, pixels, world controls, monitor changes, arbitrary docking or real DSP failures.

Raw logs and process/window identities remain private and ignored. The following SHA-256 values identify the sealed local observations without publishing their contents:

| Observation | Private file | SHA-256 |
| --- | --- | --- |
| First attachment | `.local/m0-window-first-attach.private.json` | `C7347F86FDE86805B5E9F551F80733F09ECCD8C8ACDBABEA00B2834FC1CE4965` |
| Normal restoration | `.local/m0-normal-window-restore.private.json` | `322FD3178A547F8F25C5D9FE58393A296BE3757D550478DDEB3FFF3F7DC6F070` |
| Explicit reattachment | `.local/m0-window-reattach.private.json` | `DD4CEDE903BC8E30F6E1238A8FA818D4295D0D94D79D9A563C103ED126D9F8B3` |
| Second cold-start BepInEx log | `.local/m0-second-menu-bep.private.log` | `39155346B785B58A7C79EA1C9D9E74B8FAF791F10E74FC79BA543D29ACAEF8A6` |

### Human menu-input failure: 2026-10-20

After the user closed the initial windows, the same installed candidate was reopened at a fresh empty menu and explicitly embedded for inspection. The user reports that the pointer has DSP's cursor style, but menu buttons do not respond to hover and Settings cannot be clicked. This is a failed physical-input result and blocks M0. The native parent, visibility, layout and Unity-update checks remain evidence for their narrower scope only. The user's general impression that other aspects look normal does not pass individual focus, resize or docking checks. The cause is not established; hit testing, native focus and coordinate mapping need focused diagnosis before another input acceptance claim.

The user subsequently authorized computer-use testing and autonomous implementation decisions. A computer-use click reproduced the Settings failure while embedded; after normal detachment of the same process, Settings opened and Cancel returned to the menu. No display preference or world was changed. The test observed Deck's accessibility focus after the failed embedded click; that alone is not proof of Unity's internal focus state.

The next candidate corrects the native Unicode message chain and routes a real mouse-down parent notification to the bound viewport's focus. It uses the signed event point, converted from host-client to screen coordinates, rather than the cursor's later position. Only the game window temporarily clears `WS_EX_NOPARENTNOTIFY`; original extended styles remain in its restoration snapshot. A focus transfer remains pending until synchronous `SetFocus` returns, preserving the independent UI-watchdog recovery contract.

Computer-use clicks on the shared-core fixture proved the mouse coordinate convention at an offset: host-client conversion matched the physical cursor, while interpreting the raw event as screen coordinates did not. Two game clicks produced two hits/focus requests and real native game focus; an intervening UI-region click did not increment game hits. The UI fixture received a keyboard key after the existing explicit FocusUI call. That last result does not prove an automatic UI-click focus handoff. Private fixture evidence is `.local/adapter-pointer-physical.private.json`; the synthetic host regression also verifies the full Unicode title and original exstyle restoration with the notification-suppression bit initially set.

Window diagnostics distinguish native game-window focus from Unity's main-thread `Application.isFocused`. Explicit `--window-probe` also captures at most 120 serial read-only window samples, stopping on shutdown or adapter-client replacement. It performs no focus action, input simulation or reattachment; incomplete diagnostics are not a pass. The new candidate still needs its own real DSP adoption and click test.

The implementation decision keeps input delivery native and fixes the missing child-window focus handling. It retains the game-owned parent, independent supervisor, exact endpoint binding and bounded recovery policy. Development decisions follow the design's functional and long-term goals; individual commits, explicit opt-in and exact candidate hashes provide rollback without choosing an inferior architecture merely because it is easier to undo.

The user then selected manual development mode: source work, builds and automated checks continue, while real GUI clicks, dragging, keyboard and focus checks are performed by the user. The user can explicitly select automatic mode to resume computer-use testing. The active collaboration rule is recorded in the Roadmap; earlier computer-use observations retain their historical scope.

### Unqualified scope

1. The real empty-menu cohort proves one normal native hosting cycle. Physical input, correct pixels, long-running operation and failure behavior still require separate evidence; a successful local compile or simulator cannot supply it.
2. Qualify further startup, window-style, DPI and graphics profiles against the exact runtime. The proven native cycle is limited to a windowed game and same-monitor 100% scale. Do not alter game assemblies or use an external memory/injection route.
3. Prove native mouse/keyboard focus, capture, cursor release, Alt-Tab, resizing, docking overlays and monitor changes on DSP. Do not infer these from synthetic messages.
4. Define native-input takeover relative to the game's action writer. Hosting ownership alone does not serialize manual input against prepare/commit.
5. Qualify game, renderer, Deck and host failures separately under Lab rules. A restarted game or older save is not a viewport recovery strategy.
6. Focused children still share input queues despite the resize fix. The test controller and actual Electron supervisor demonstrate finite recovery by ending a known owned UI; a hung real game thread, indefinite failures, physical input during a hang and real DSP host death remain unqualified. The first real manual menu check fails hover/click response as recorded above.

Real adoption requires independent review and an exact deployment/validation cohort. The first installed cohort failed before endpoint creation; the second passed the normal native menu lifecycle above. The subsequent physical-input failure blocks M0, and the display/docking and failure gates remain open. Game-action tools stay closed.
