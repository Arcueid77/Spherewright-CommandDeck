# Spherewright CommandDeck

A desktop workspace for playing Dyson Sphere Program with a structured Agent and for developing and validating Spherewright.

**Status: M1 development, main-window docking/layout restoration and M2 read-only panels have implementation and validation evidence. M3 has completed one real MiniMax → native confirmation → ordinary DSP research enqueue → original-action/queue readback → normal-save workflow in a dedicated owned world. Live monitoring/performance, native input coordination and real failure coverage remain open. The owner has deferred the unresponsive embedded DSP menu; this behavior is not an input lock.**

Implementation stages, dependencies and acceptance gates are tracked in [ROADMAP.md](ROADMAP.md) (Chinese). The 0.1.0 plan includes both a directly interactive native game viewport and a development workflow across Spherewright and Lab.

## Repository boundaries

| Repository | Responsibility |
| --- | --- |
| [Spherewright](https://github.com/Arcueid77/Spherewright) | Game Plugin, local Bridge, MCP contracts, native observations and controlled actions. |
| [Spherewright-Lab](https://github.com/Arcueid77/Spherewright-Lab) | Scenarios, acceptance evidence and version locks across the product repositories. |
| [Spherewright-CommandDeck](https://github.com/Arcueid77/Spherewright-CommandDeck) | Desktop UI, native game-window host, development workspaces, task permissions and the game-action ledger. |
| [Spherewright-Pi](https://github.com/Arcueid77/Spherewright-Pi) | Source fork of the Pi Agent runtime, included here as the vendor/pi submodule. |

Lab belongs in a Spherewright **development workspace**, alongside the game-control source and CommandDeck. It is an independent repository and is not a required dependency of the CommandDeck application build or installed runtime. Existing checkouts can stay in their current locations; the workspace UI supports multiple explicitly authorized roots.

Conceptual layout, rather than a requirement to move existing repositories:

~~~text
Development workspace
  Spherewright/                 game-control source
  Spherewright-Lab/             scenarios and acceptance evidence
  Spherewright-CommandDeck/     desktop application source
    vendor/pi/                  Spherewright-Pi Git submodule
~~~

## Pi source dependency

The fork preserves the complete upstream monorepo and its license notices. Upstream is [earendil-works/pi](https://github.com/earendil-works/pi), formerly badlogic/pi-mono.

The initial submodule baseline is upstream v1.3.0, commit 71023aec1546d6d677a65669c5665c0927ce0dd0. The parent repository pins an exact commit; it does not automatically follow the fork's default branch. Future CommandDeck releases must record both the application commit and the Pi submodule commit.

Clone with the pinned dependency:

~~~powershell
git clone --recurse-submodules https://github.com/Arcueid77/Spherewright-CommandDeck.git
~~~

For an existing checkout:

~~~powershell
git submodule update --init --recursive
~~~

Changes to Pi are committed and pushed in Spherewright-Pi first. CommandDeck then records the new submodule commit in a separate integration change. Check out an explicit development branch before editing the submodule; an ordinary submodule checkout is detached.

The prototype imports the built coding-agent entry directly from the submodule. `pi:verify` checks the exact commit, compiled entries and internal workspace links. Pi source is unchanged at this baseline. Its ignored model catalog is restored from the matching versioned npm artifact using the integrity in `pi-model-data-lock.json`; only JSON catalog data is copied, not registry runtime modules. End-user packaging remains a later milestone.

## Run the Windows development prototype

Developer prerequisites: Git, Node.js 22.19 or newer, and the .NET 8 SDK with Windows desktop support. The current native fixture targets Windows x64; this is a source prototype, not an installer.

After cloning recursively, run from the repository root:

~~~powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run pi:install
npm run pi:hydrate
npm run pi:build
npm run pi:verify
npm run build
npm run typecheck
npm test
npm run test:native
npm start -- --demo-fixture
~~~

The demo starts only this repository's simulated game host and embeds the Electron UI as its child. The central native grid has click, drag, wheel and key handlers. Its ownership design and remaining limitations are described in [native-window-hosting.md](docs/native-window-hosting.md). The desktop can also discover an explicitly enabled game adapter; it never launches DSP or adopts an arbitrary selected process.

`npm run probe:native-focus` records a remaining focused-UI hang; its normal exit is not an input-isolation pass. `npm run test:native-ui-recovery` separately proves a bounded rescue with WinForms fixtures. The desktop uses an independent supervisor for the actual Electron UI process, native connection and Pi utility process. A one-second main-thread heartbeat delay triggers an independent, bounded native responsiveness check. A responsive native window is retained; confirmed native timeout permits replacement of the registered UI. Two unknown checks stop automatic replacement and block new runs. The supervisor confirms UI exit before creating at most one automatic replacement. The simulated game remains standalone until explicitly reattached.

Close the demo before running `npm run test:desktop`, `npm run test:desktop-host-exit`, `npm run test:desktop-recovery-limit` or `npm run test:workbench`. The M0 tests cover reload/renderer crash, an actual Electron UI-thread hang, a model round already in flight, abrupt simulator-host exit, and a second UI failure that stops automatic replacement. The workbench test separately checks editing, a command running across reload, UI replacement, restored drafts and no command replay. Each wrapper requires its own new run ID and completed proof. Synthetic results go under ignored `.local/`. M0 probe snapshots remain in memory; M1 development tasks use a versioned SQLite ledger under the application's private `userData/supervisor/workbench` directory. Private Pi histories stay there too, outside renderer storage and Git. The disposable UI has a separate Chromium profile.

## M1 development workspace

Start without a game, then use **添加仓库**, or seed approved roots explicitly:

~~~powershell
npm start -- --workspace '<Spherewright checkout>' --workspace '<Lab checkout>'
~~~

Each root begins read-only. Enable editing and/or checks for that root in the workspace panel. Pinned submodules remain read-only, including Lab's product dependency and the pinned Pi baseline. Select an independent source checkout for development. Git status and single-file diffs are read-only; automatic commits, pushes and arbitrary shell commands are not exposed to the Agent.

Open tracked text files from the file tree, or create a new file in the editor. Saves check the observed content hash and retain before images. **撤回此文件修改** restores only the matching current after image; it refuses later external edits. Initial dirty files are protected from Agent edits. Layout, task drafts and editor drafts persist locally. Tasks survive panel closure and UI replacement; restarting the application marks interrupted work instead of replaying it.

The development Agent uses only explicitly registered workspace tools and applicable repository rules. Each task has one selected root, a five-minute limit, at most six model requests and 24 tool calls. Named checks come from `typecheck`, `test`, `build` and `lint` package scripts or tracked .NET solution/test projects. Output, exit code and ordinary descendant-process termination are recorded. This runs repository code with the current user's permissions; the Windows Job is process lifecycle management, not an OS sandbox. An unknown command outcome blocks further managed execution pending reconciliation. No game tools are connected.

The model menu can reuse existing CC Switch/Pi configuration or a separate profile created in **模型设置**. New profiles are encrypted in full with Windows safeStorage under private application data. Existing keys are never returned to the renderer; a newly entered password is temporary and is not saved as a draft or browser setting. CC Switch configuration is not rewritten or automatically migrated. Cost is unknown. On 2026-10-21, MiniMax completed a bounded read/edit/test task in a new owned fixture repository with one successful check and zero game calls. Automatic-mode computer use subsequently verified file clicks, draft/editor typing, saving with before images, diff viewing, divider resizing, dropdown dismissal and normal restart restoration in an owned fixture. On 2026-10-23, actual mouse gestures also moved a tab across groups, retained it through a normal restart, split and merged groups, and restored the original panel order. Editor/draft/selection hashes and the completed real-game task stayed unchanged. These workbench observations do not qualify DSP input.

Main-window docking uses pointer events. The renderer build applies a one-line compatibility correction to the exact pinned Dockview 8.6.0 source so a drag's first movement establishes its drop target before an immediate release. Changed dependency bytes or a missing transform explicitly fail the build. Three regression tests cover immediate release, cancellation and the dependency guard; 151 Node tests, type/build checks and the existing desktop workbench smoke passed locally. Cross-window HTML5 dragging is unavailable with this strategy and remains a separate M6 requirement; docking over an active native game viewport and other display configurations still require their own validation.

Protected profiles support explicit Chat Completions or Messages protocol configuration, an endpoint and one model; remote endpoints require HTTPS. Changing or deleting a profile is rejected while a task is active, including its final repository check. Keys use Pi's literal, in-memory credential overlay, never command evaluation or an auth file. For these profiles, a provider turn is consumed and sanitized before being exposed to Pi; UI text appears after that turn completes. Literal credential echoes in text are redacted, and echoes in tool identifiers or property names reject the response. This is not protection against a hostile provider deliberately encoding secrets or other programs running as the same user. The model service necessarily receives its selected credential.

`npm run test:vault` uses a synthetic credential to verify Windows encryption and reopening in a separate Electron process. Node tests additionally exercise split provider echoes, rejected control fields, safe initialization errors and actual Pi session/SQLite persistence. The desktop workbench smoke covers the renderer-to-supervisor configuration whitelist and the private task-bound runtime channel against a loopback fake provider. These are zero-external-network credential tests; only the existing MiniMax Chat Completions configuration has a live-model result. A corrupt/newer vault or unavailable OS protection is never silently reset or stored as plaintext.

## Read-only bridge panels (M2)

Open **只读舰桥**, choose the intended `Spherewright.Mcp.exe`, and inspect its connection details. This starts one local MCP process; it does not start DSP or load a world. The selection is kept by the supervisor across UI reloads, but must be selected again after the whole application restarts. Reconnecting requires the selected executable/DLL/config cohort to retain its recorded fingerprint; changing it requires an explicit new selection. The fingerprint is a file observation at connection time, not a frozen payload, loaded-DLL proof or installed Plugin hash.

Research, production, power and logistics use one background observer, with a five-second refresh cadence and one collection in flight. UI snapshots and extra panels share that observer. Tool discovery and annotations/schema checks enable only four explicitly named read tools; counts are discovered rather than assumed. There is no renderer API for arbitrary MCP calls or game writes. No model request is needed. Closing panels or reloading the UI does not start another MCP process; disconnect and application shutdown confirm the original process exit before replacement.

Pages are bound to session, snapshot, game tick, item selection and coverage, with a 32-page cap per source and a thirty-second request-start budget for the complete collection, including the final context checks. A single read already in flight may take its remaining twelve-second timeout. World changes and tick regression discard candidate data. Old data is visibly stale after disconnect, read failure or fifteen seconds of monotonic receive age. The UI independently ages cached snapshots, conservatively includes RPC delivery time, and invalidates them on supervisor transport loss. Changing the connection or watched scope rejects older in-flight replies. Source expiry is retained and compared across pages, but its wall clock validity is not asserted. The whitelist removes save names and resume/checkpoint credentials before UI delivery; nothing is exported automatically.

Actual production is shown only for the current source's complete inclusive 600-game-tick window. Warming/discontinuous/invalid windows show unknown actual rates. Theoretical capacity is labeled an estimate and never substituted for actual output. Power uses observed J/game-tick converted at 60 game ticks/second; current service is not proof of sustained fuel or headroom. Missing fields show `—`, not zero. The first UI exposes up to sixteen explicitly selected item IDs and at most 300 visible production rows, with coverage/truncation stated.

The connection panel also accepts optional version-1 runtime performance from the same status reads: the most recent bounded Unity Update intervals and full Bridge main-thread pump durations (mean/P95/max in milliseconds), actual sample/window coverage and the instantaneous pending-request count with configured limits. Update intervals are not GPU presentation FPS. Empty windows remain unknown; old Plugins show unsupported, malformed metrics stay unavailable, and native sample age plus conservative delivery/UI time determines staleness. No additional game request or model is used. The [Spherewright source contract](https://github.com/Arcueid77/Spherewright/blob/9a4ec982b485db634a3cdbc7129d8b5c41fb86b7/docs/protocol.md#read-only-runtime-performance) has passed 3,201 local tests, a full current-native Plugin build and exact CI; cold adoption and real performance remain separate pending checks.

`npm run test:bridge` runs an owned synthetic MCP through the real Electron connection/UI path: pagination, research/production/power/logistics rendering, private-field removal, reload without process restart, and stale data plus confirmed server exit after disconnect. This is zero-model and zero-real-game evidence, not physical mouse or DSP performance verification. A separate metadata-only probe can inspect an explicitly selected source-built MCP with its Bridge descriptor disabled:

~~~powershell
node scripts/probe-mcp-metadata.mjs --executable '<absolute path to Spherewright.Mcp.exe>'
~~~

The local source-built probe observed protocol `2025-06-18`, server `0.4.0.0`, 64 tools and one resource, with zero `tools/call`. Real owned-world monitoring, game frame time, panel latency under load and installed-cohort validation remain open.

## CC Switch / Pi provider configuration

The model selector reads provider/model metadata from Pi's `models.json`, normally under `~/.pi/agent`. Existing CC Switch Pi providers can be reused. `COMMANDDECK_PI_CONFIG_DIR`, then `PI_CODING_AGENT_DIR`, can select another configuration directory. The prototype does not rewrite shared Pi configuration or copy keys into the repository or renderer. Credential command values are rejected, including model header overrides; remote endpoints require HTTPS.

Startup makes no model request. Choose a configured model and click the live probe explicitly, or use:

~~~powershell
npm run smoke:live -- --provider '<configured-provider-id>' --model '<configured-model-id>'
~~~

The fixed probe permits at most two model requests and one `deck_echo` execution, caps requested output at 512 tokens per response, disables retries, and has a wall-clock timeout. It has no game, shell or file-editing tools, project resources, extensions, skills or MCP discovery. Active and callable tool sets are both checked. `npm run smoke:offline` uses a loopback fake service without external model access.

Locally verified on 2026-10-20: source builds and type checks; ten Node tests including split tool arguments, cancellation, denied tools, session reopening without execution, and failed second responses; native ownership/detach/failure tests; and one live MiniMax-M3.1-Flash roundtrip through the desktop utility process. Only that configured Chat Completions compatible endpoint has live evidence. Foreign-window mutations run serially off the host UI thread; focused child windows still share input queues. In the actual Electron hang test, the supervisor ends only its registered UI after roughly one second, the original native input request resumes, the same Pi process finishes the in-flight offline probe after UI exit, and a replacement displays its result without resubmission. Abrupt simulator-host exit recreates one visible top-level UI while keeping Pi and never restarting the host. A second UI failure stops automatic replacement. These are finite simulator tests; the separate DSP menu evidence below does not qualify physical input, DPI changes or real-game failure recovery. M0 as a whole has not passed.

## Game-side window adapter candidate

The new `native/CommandDeck.UnityAdapter` is a separate, window-only BepInEx plugin, not a Spherewright game-control change. It is inactive without the per-launch `--commanddeck-host` argument. It exposes only native hosting, layout, focus and restoration over a protected local pipe; it has no game-world, save, input-injection or process-termination operation. The first display profile accepts a windowed game and UI on the same 100% scale monitor; changing that profile requests detachment. Other display profiles remain unsupported.

The desktop window selector is the normal entry. For a controlled runtime check, `--attach-adapter <exact-listed-id> --window-probe` performs the same explicit selection once and writes only window/Unity-loop observations to ignored `.local/m0-window-runtime.private.json`. It does not reattach after UI recovery, start a model request or infer menu/world state from those observations.

For a local compile, copy only the private BepInEx/Unity references from an explicitly supplied installation, then build:

~~~powershell
pwsh -File scripts/sync-unity-refs.ps1 -DspDir '<DSP installation>'
npm run build:unity-adapter
~~~

Game DLLs stay under ignored `.local/game-refs` and are never shipped. Candidate output is under ignored `artifacts/unity-adapter`. The first exact cohort was installed separately and loaded at normal DSP startup, but Mono's unimplemented `WindowsIdentity.User` prevented endpoint creation. It did not create a game-window host. The fix uses native current-user SID/ACL and session queries. The subsequent `e00f56c` cohort, after its exact-SHA CI passed, published its endpoint in Unity `2022.3.62f3c1` and completed embedding, normal restoration and explicit re-embedding at the empty DSP menu. Native parent/visibility/layout checks and advancing Unity updates passed at 96 DPI; these do not prove correct pixels or physical input. Published session reads reported no loaded world; no save/load or game-action call was made. The original Spherewright DLL hashes stayed unchanged. Detailed scope and private evidence hashes are recorded in [native-window-hosting.md](docs/native-window-hosting.md).

CI builds both shared cores for .NET Framework 4.7.2 and runs simulators; it cannot compile the Unity plugin without those private references. A local compile, simulator pass and exact real-runtime check remain separate results.

`test:adapter-layout` checks both completion/request orderings; `test:adapter-native` checks the shared Win32 source, including an unexpected host-thread quit; `test:adapter-bridge` checks authentication, OS peer identity before sending the credential, malformed clients, EOF, restoration quarantine and descriptor ownership. `test:adapter-route` verifies that helper exit cannot clear an unreconciled host. `test:desktop-adapter` runs the real Electron UI through the same pipe protocol against a fake game, including UI replacement with an in-flight Pi probe. None starts or calls DSP.

## M3 bounded research tasks

Open **游戏 Agent** beside the native viewport. Connect a compatible Spherewright MCP through **只读舰桥**, then use **读取科研列表** to select a technology by its observed name. Select an existing model and either observation/advice or assisted execution. The world must already be an authorized Spherewright-owned world; this prototype does not select, load, import, restore or create saves. The catalog handle expires after 60 seconds and binds the original world and service cohort. A changed world or service requires a fresh selection.

The pinned Pi receives only `observe_research` and, in assisted mode, `propose_research`: at most four model requests and eight tool calls, with a five-minute model-run limit. It has no development tools, native plan tokens or direct commit capability. After the adviser finishes, the host fresh-prepares the user's exact ordinary enqueue. **核对并确认入队** opens a native dialog whose default is Cancel; only its actual return can consume the host's short-lived nonce, bound to the current UI process and exact preview. Expired plans can be explicitly prepared again. Model text and renderer JSON cannot approve an action.

The SQLite ledger records intent before the sole commit submission, admits at most one accepted write per task, and blocks every further write while an intent is unresolved. Game tasks reserve the managed development runtime and the same MCP connection. Source edits, builds, model-configuration changes and competing managed connections are refused until the task settles. Restart never restores old plan tokens or approvals; known original actions can only be read in their original scope. Native unknown/recovery/failure and mismatched action/key results enter durable independent-audit isolation, even if the next observation fails. There is no automatic unblock API. If research finishes before the fresh queue read, this narrow proof remains incomplete. Queue insertion is distinct from technology completion.

`npm run test:game` uses an owned synthetic MCP and provider through the real supervisor, Pi utility, encrypted profile and renderer, including mocked native-dialog Cancel/Confirm returns. `npm run test:game -- --smoke-game-physical` instead waits for an operator to use the actual native dialog, clearly marked **NO DSP**. Computer-use verified Escape cancellation, fresh preparation, a physical confirmation click, one synthetic enqueue, retained queue receipts and normal exit. A separate bounded SDK probe reused the existing MiniMax-M3.1-Flash configuration for three real model requests and two tools against a synthetic game; its approval came from a test host, separately from the UI evidence. Both paths made zero real DSP calls.

On 2026-10-23, the coherent 0.4.0 Plugin/MCP research-readback repair and Deck's bounded output-budget repair completed one real dedicated-world task with the existing MiniMax-M3.1-Flash profile: three model requests and two observe/propose tools, one durable intent/commit, matching original terminal and fresh queue proof, followed by one normal save covering the accepted action and durable Journal. Native inventory and research-progress preservation flags were checked against the original action. The actual native dialog was operated by Codex under the owner's explicit automatic-mode authorization; this is not a physical-human-click claim or Pi self-approval. The queue changed from empty to the selected technology; technology completion was not tested. Detailed save points, counts and protected evidence remain in the isolated Lab scenario.

After that save and normal MCP disconnect, a normal full-app quit/reopen retained the exact original task, key, action and receipt, with the model-session file set and hashes unchanged. The completed receipt remained visible; no model rerun, second research intent or automatic MCP reconnect occurred. The same DSP process survived. This does not qualify an interruption during commit or an unexpected process failure.

Native input coordination, player takeover and real failure coverage remain acceptance work. Bounded autonomous mode stays disabled. Requesting takeover freezes future scheduling; it does not claim to cancel an already accepted native action or exclude player input. M3 as a whole has not passed.

- Development mode may expose source-editing and build tools for explicitly authorized workspace roots, while respecting each repository's instructions.
- Game mode exposes controlled Spherewright tools. It does not inherit development shell or file permissions.
- Switching modes does not authorize a pending game action. Approvals, budgets, commit intents, original action identities and receipts belong to CommandDeck's task ledger, independently of Pi conversation history.
- Game writes continue through Spherewright prepare/commit and original-action reconciliation. Unknown outcomes stop further writes; a resumed conversation never authorizes replay.
- Native game-window embedding has one real DSP menu lifecycle check. Physical input, focus, DPI changes, docking and real failures still need acceptance. Agent game control remains on the structured MCP path.

## Initial implementation priorities

1. Prove native game-window hosting and safe window detachment in an isolated prototype.
2. Integrate the pinned Pi source with explicit tools and resource loading.
3. Add development-workspace access and a read-only game dashboard, then a bounded approved game task with durable action evidence and a Spherewright-to-Lab development/validation workflow.

The simulator, pinned Pi, M1 development tools/ledger/protected profiles, M2 read-only panels and M3 assisted research have local software evidence; one real research enqueue and covering normal save have now passed. Actual game input and the remaining display, docking and failure gates still need separate validation before M0 can pass. M2 real owned-world monitoring/performance and M3 input coordination/takeover/failure coverage remain open. No tag, installer or release has been published.

## License

CommandDeck is MIT licensed. The Pi submodule retains its upstream MIT license and copyright notices; its source and history remain in the independent fork.
