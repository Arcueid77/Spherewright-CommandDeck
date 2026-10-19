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

The simulator keeps restoration evidence for the UI window's exact PID/start time/HWND, style and position before adoption. It verifies the parent and real child/popup styles after native calls. Normal detachment restores that UI window. If the UI process exits, the simulator retains its own viewport and expands it to the host. If the stdio control channel closes, the simulator restores the UI and remains alive.

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

The Electron smoke also reloads and deliberately crashes its own renderer. The simulated game retains the same owner PID, and the model probe is not submitted again. These are synthetic tests, not save/recovery or game-action evidence.

## Remaining real-game questions

1. A game-side adapter must create the stable host within the DSP process and cooperate with Unity's actual window/message lifecycle. The WinForms simulator is not that adapter, and cannot simply be loaded into Unity.
2. Determine the supported startup, window-style, DPI and graphics-ready sequence from the exact current Unity/runtime. Do not alter game assemblies or use an external memory/injection route.
3. Prove native mouse/keyboard focus, capture, cursor release, Alt-Tab, resizing, docking overlays and monitor changes on DSP. Do not infer these from synthetic messages.
4. Define native-input takeover relative to the game's action writer. Hosting ownership alone does not serialize manual input against prepare/commit.
5. Qualify game, renderer, Deck and host failures separately under Lab rules. A restarted game or older save is not a viewport recovery strategy.
6. Cross-process parent/child windows can couple input queues. Current process-exit tests do not prove survival of a hung UI thread, a hung host thread, or abrupt host-process death; test these separately before accepting the ownership design for DSP.

Real integration will require an independently reviewed, narrow game-side implementation and a supported deployment/validation cohort. Until then, DSP attachment and game-action tools stay closed.
