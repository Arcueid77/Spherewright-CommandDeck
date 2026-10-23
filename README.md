# Spherewright CommandDeck

A desktop workspace for playing Dyson Sphere Program with a structured Agent and for developing and validating Spherewright.

**Status: M1 development and main-window docking/layout restoration have validation evidence. M2 has completed finite real shared-panel/RPC observations, connection-only UI timing and bounded reader shutdown in a dedicated idle world; loaded-factory overhead, multiple worlds and long-run evidence remain open. M3 has completed one real MiniMax → native confirmation → ordinary DSP research enqueue → original-action/queue readback → normal-save workflow. M4 has completed its first finite source → checks/CI → Lab → cold installation/recovery → basic live display → persistent diff/log/evidence navigation workflow. Native input coordination and real failure coverage remain open. The owner has deferred the unresponsive embedded DSP menu; this behavior is not an input lock.**

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

The command helper can also be published as a self-contained Windows x64 cohort from clean committed source:

~~~powershell
npm run publish:commands -- --output artifacts/portable-commands
npm run test:portable-command -- --source artifacts/portable-commands
~~~

The output must be a new direct child of `artifacts`; the publisher never overwrites or deletes an existing output. It records the source revision/SDK and seals a bounded manifest of the complete published file group. Self-contained command helpers require that manifest and their app-local runtime; cache preparation checks every listed file's size/hash and exact membership, rejects links/unsafe names/partial or altered groups, and never overwrites existing cache bytes. Framework-dependent development helpers retain their original four-file cache identity. The manifest establishes byte coherence, not an author signature or execution permission; Windows Job/unknown-outcome and workspace grants remain separate.

The portable smoke runs the **cached** helper with developer tools absent from PATH and invalid .NET-root paths, and checks actual app-local runtime loading, exit codes, cancellation/timeout, descendant termination and a cache path longer than260 characters. Its child fixture uses the existing test runner at an absolute path. This is a targeted helper/runtime check on the current Windows host, not a clean-Windows VM, complete Electron/Pi installer or M5 acceptance. No game or model call is made.

The embedded Pi SDK can also be verified independently of the checkout:

```powershell
npm run test:portable-pi -- --require-clean-source
```

This materializes the actual runtime dependency graph, including nested versions and the fixed fork's seven internal packages, into a new physical temporary tree outside the checkout. It preserves package resolution without shipping workspace links, refuses registry substitutes for internal Pi packages, and records file hashes and missing optional dependencies. The copied desktop runtime completes an offline synthetic tool roundtrip with global Node package lookup disabled and developer tools absent from PATH. The existing absolute Node test runner is still used; this is dependency portability evidence, not the full Electron bundle, installer or clean-Windows acceptance. The normal checkout continues resolving these same paths through its pinned workspace links.

`npm run test:renamed-ui` runs the existing workbench integration check with a separate Electron distribution whose executable is renamed `Spherewright-CommandDeck.exe`. The supervisor admits only its own current Electron executable in the explicit UI role; the registered creation handle remains necessary for termination. The check covers UI reload/replacement and single command execution. It still loads the source checkout and does not validate a complete installed bundle.

Build an unpacked Windows x64 desktop candidate from clean committed source:

```powershell
npm run package:desktop -- --output artifacts/portable-desktop
npm run test:portable-desktop -- --source artifacts/portable-desktop --reopen-history
```

The output directory must be new. The builder freezes native sources into a separate build copy, derives only empty Windows RID lock metadata there, publishes both helpers with locked package dependencies, embeds Electron and the physical Pi runtime tree, and records every shipped file hash and source pin. It excludes Lab, user data and proprietary game DLLs. The test verifies the bundle, copies it outside the checkout, uses a new temporary profile, hides developer tools/shared .NET roots and starts the packaged executable. Its built-in fixture-only mode rejects real models, MCP connections, game tasks and developer commands. Raw runtime traces remain local; only the anonymous summary and bundle manifest are uploaded by CI. This candidate and check do not constitute an installer, clean-Windows VM acceptance, game-input acceptance or release.

`--reopen-history` closes the first application, confirms its processes have exited, then seeds only that isolated profile using the actual bundled store APIs. The records are explicitly synthetic: one closed development task/invocation, an unsent draft and one completed research intent with its original key/action/receipt/events. It relaunches the packaged executable with the same physical profile and run identity, compares the complete retained records before and after UI reload, and rejects changed or replayed history. Synthetic records do not mean a command or game action occurred. Existing user profiles are never copied into the fixture. Each phase retains its own proof; failure preserves the temporary directory.

Renderer builds emit `THIRD-PARTY-LICENSES.md` for the bundled React, React DOM, Scheduler and Dockview packages. Packaging requires each exact locked version and its complete source license text, includes the notices in the file inventory, and records the source license hashes; a license identifier alone is insufficient.

Self-contained .NET publishing also copies the license and third-party notice files provided by the exact resolved runtime packs. It checks runtime configuration, SDK download pins and NuGet package identity before copying; command-host notices are included before sealing, so its cache retains them too.

An explicit verified bundle can also be wrapped in a per-user development installer:

```powershell
npm run installer:toolchain
npm run package:installer -- --source artifacts/portable-desktop --output artifacts/installer
$installerTestId = [guid]::NewGuid().ToString()
npm run package:installer -- --source artifacts/portable-desktop --output artifacts/installer-test --test-id $installerTestId
npm run test:installer -- --source artifacts/installer-test
```

The compiler is the pinned official Inno Setup 7.1.0 distribution, checked by download hash, publisher signature and all 132 extracted file hashes, in an unregistered local portable toolchain. Each output directory is new; the wrapper records the exact bundle and builder revisions separately. Installation uses the current user, keeps each source revision in its own `releases` directory, never auto-starts the app/game and asks for normal closure when installed Deck/helper processes are still running or their identity cannot be verified. It does not edit user profiles. Uninstall removes registered program files and retains unregistered files; there are no wildcard cleanup rules. These installers are unsigned development candidates, not published releases.

The automated check accepts only an explicitly compiled test identity, requires its marked temporary installation directory and creates no Start-menu shortcuts. It verifies installation, running-process refusal, direct installed-app startup, same-candidate repair, profile preservation and normal uninstall. Both startup checks include a same-profile synthetic-history reopen, for four actual installed application runs. It launches the installed executable itself, rather than testing a copy extracted from the installation. Its app mode is fixture-only and cannot reach a real game/model. Upgrade/rollback, profile-schema migration and a clean Windows VM remain separate gates; implementing the test entry does not by itself prove those or M5 passed.

Supervisor startup acquires its existing profile's single-instance lock before importing task/ledger modules. A second launch exits before creating or migrating a game ledger. The packaged app keeps the source application's identity rather than adding a different `productName` that would select another default profile; installer and window display names remain separate. `npm run test:profile-lock` checks the source entry with a real OS lock holder; add `-- --source artifacts/portable-desktop` to check a built bundle. All test profiles are isolated.

If supervisor module loading fails, startup retains the profile lock and opens a static blocked window after Electron is ready. It shows only a fixed error code and recovery guidance, without a preload bridge, page scripts, Node access or raw exception details. It does not delete/reset the failed ledger or open a fallback profile. `npm run test:startup-failure -- --source artifacts/portable-desktop` exercises an unsupported schema, unknown schema, corrupt game ledger and a malformed v1 ledger in separate synthetic profiles with the actual packaged executable; it checks the visible blocked page, unchanged ledger bytes/members and process exit. This covers early bootstrap failures; later runtime failures, disk exhaustion and the complete recovery matrix remain separate gates.

Ledger constructors check known table sets and required columns before changing journal mode or running a migration. Unknown workbench v0 structures and incomplete game v1 structures are rejected without adding tables or promoting their schema. The historical v1 migration fixture was generated by the actual ledger implementation at `f37dae5ad59df6968e7335c12bbc8f56a2dd5aae`; it contains only synthetic records. Tests compare every original pending task/intent/gate field after migration, and require zero preparer/proof calls. They do not claim a real game action was recovered or that every later runtime failure is covered.

Two explicit installer candidates can be checked for a compatible upgrade/rollback:

```powershell
npm run test:installer-upgrade -- --baseline artifacts/installer-test-old --candidate artifacts/installer-test-new
```

Both must have been built with the same isolated test identity and different source revisions. The check refuses an existing registration or unknown registry state. It installs the baseline, seeds closed synthetic history through the existing installed-app check, then upgrades, rolls back and returns to the candidate using the same physical isolated profile and original history digest. Each version selection is checked against registry metadata and complete payload hashes. Installer operations must preserve every profile byte; normal app starts separately verify the original tasks/draft/key/action/receipts. Final normal uninstall must remove both registered releases while preserving the profile and an unregistered file. On failure the context, registration and evidence remain for targeted recovery. This proves only the tested version pair and compatible existing schemas. A manually dispatched `windows-upgrade.yml` workflow builds both exact commits and runs the same check; it uploads anonymous summaries/manifests, never private profile/registry/trace files. Existing single-version installation tests remain separate.

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

Selecting a task opens its retained output. **打开原始差异** compares the task's saved before/after contents, including after the change has been committed or explicitly reverted; it does not substitute the current Git diff. **关联验收记录** attaches a text file from a registered repository at the exact displayed commit and content hash. Later working-tree edits or commits do not move that link. Both views are read-only and preserve the current editor draft; attaching a record does not assert that acceptance passed. Private paths, symlink blobs, untracked files and files over 1 MiB are refused. References persist as bounded, append-only task events; this adds no repository write or command execution capability.

The first finite M4 workflow is recorded in [Lab](https://github.com/Arcueid77/Spherewright-Lab/blob/07bec28be39395bccf16e09babd4ee9a415cdf2c/scenarios/commanddeck-m4-runtime-observation/README.md#current-boundary--当前边界). Navigation candidate `c736f9605c81533b9a56d4e3232112868fe29330` passed [exact CI39843930022](https://github.com/Arcueid77/Spherewright-CommandDeck/actions/runs/39843930022),164 local tests and normal-window physical diff/log/Lab navigation through a full application reopen. Original development commands and the real M3/Pi records were retained without replay. This validates one developer workflow; controlled live performance, input/takeover, remaining fault coverage and release gates are separate.

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

The connection panel also accepts optional version-1 runtime performance from the same status reads: the most recent bounded Unity Update intervals and full Bridge main-thread pump durations (mean/P95/max in milliseconds), actual sample/window coverage and the instantaneous pending-request count with configured limits. Update intervals are not GPU presentation FPS. Empty windows remain unknown; old Plugins show unsupported, malformed metrics stay unavailable, and native sample age plus conservative delivery/UI time determines staleness. No additional game request or model is used. The [Spherewright source contract](https://github.com/Arcueid77/Spherewright/blob/9a4ec982b485db634a3cdbc7129d8b5c41fb86b7/docs/protocol.md#read-only-runtime-performance) passed 3,201 local tests, a full current-native Plugin build and exact CI. Its coherent cold installation and basic real Deck display are separately recorded in [Lab](https://github.com/Arcueid77/Spherewright-Lab/blob/fe55a485999bc0771822ebede994a147eed6b7c1/scenarios/commanddeck-m4-runtime-observation/README.md). Later [bounded real observations](https://github.com/Arcueid77/Spherewright-Lab/blob/0bc48fc2603ed82f7789436595749822c8e88fda/scenarios/commanddeck-m2-measurement/README.md#current-boundary--当前边界) measured shared panels/RPCs, isolated UI timings and actual exit events, with zero game writes/model calls. These new scopes do not rewrite the earlier missing40-second proof or pass loaded-factory, multi-world or long-run gates.

**MCP 客户端测量** records this selected client's admitted RPC requests, responses, RPC errors, transport aborts and local concurrency. Metadata, tools and resource reads are counted separately. A monotonic clock retains the latest128 finished requests; round-trip timings use only their returned RPC results/errors, with the exact returned-sample count shown. Aborted requests remain separately counted and do not become artificial round trips. Connection totals remain cumulative. A returned RPC result is recorded independently of tool/game success. Empty timing windows remain unknown, duplicate responses do not create new requests, and reading UI snapshots issues no MCP request. The production launcher starts lifetime timing before process creation; manually attached test clients explicitly use an attachment origin. Only the actual exit event freezes that duration, while unconfirmed exits remain open. The ended snapshot survives normal disconnect in the current app, and reconnect starts a new client. No names, arguments, result payloads, save identities or credentials enter these measurements. Local170 tests and real Electron/synthetic MCP checks cover these mechanics; controlled real-game load, UI latency, multiple-world and long-run acceptance still remain open, and this does not repair the earlier missing40-second proof.

**界面响应测量** measures the existing renderer snapshot request, receipt-to-React-commit delay, commit-to-next-animation-callback delay and total request-to-callback time. The callbacks occur before paint; they do not measure GPU presentation or physical input latency. Each disposable UI keeps at most128 visible RPC/frame samples, with actual sample windows and mean/P95/max. Hidden/visibility-transition requests, coalesced deliveries, interrupted frames and failures are counted separately; empty windows remain unknown and long visible waits are retained. Closing/reloading the UI cancels pending frame work and starts fresh measurements. No extra MCP request, content, credentials or save identity is recorded. Six focused tests and the real Electron/synthetic MCP check cover these mechanics, including an explicitly shown test window and a declared70ms test-only callback delay. Controlled native-game and long-run acceptance remain separate.

**当前连接的界面响应** keeps a separate, bounded window for one supervisor-assigned MCP connection generation. Setup, discovery transitions, replacement connections and disconnected UI work cannot enter its timings. A candidate visible snapshot receipt or frame callback is counted only after another snapshot, begun after that candidate completed, still confirms the same live client; the unconfirmed tail is counted separately. Disconnect freezes confirmed statistics, while a new connection starts fresh and the original whole-UI measurements continue to retain visible long waits. This uses the existing UI snapshot path, adds no MCP/game request and carries no process/save identifier. Six additional focused cases and the real Electron/synthetic MCP check cover phase boundaries, late callbacks, bounded windows, long waits, a confirmed70ms synthetic callback delay and frozen ended samples. The normal Deckb3 candidate subsequently measured19 confirmed snapshot/frame samples over14.29s in the real dedicated idle world, excluded setup and retained identical statistics after exit. Its24-tool cap ended the MCP at16.108s, independently observed by16.150s within the predeclared35-second bound; no writes or models. This finite slice does not pass full M2 performance.

For a bounded observation run, first close the existing Deck and start `npm start -- --observe-only --observe-max-tools 40 --observe-max-ms 20000`. This opt-in mode disables game execution/approval, model probes, provider changes and development writes/checks at the host boundary. It requires settled game/development state before selecting MCP, creates no research capability, and permits only one MCP launch per app run. Tool admission is capped; the lifetime deadline includes discovery from the launch request and also stops an idle client. Reconnecting or reselecting cannot renew the scope. The ordinary UI remains open with stale data, counts and the observed exit result after the owned read-only MCP ends. Only this client's four supported read tools are involved; this is not a game-input lock or a lease on other clients. The event-loop deadline limits new requests and requests termination; the separately measured exit event must still meet any declared observation bound. Normal startup retains its existing behavior, and the mode never grants Save/Load, deployment or new gameplay authority.

`npm run test:bridge` runs an owned synthetic MCP through the real Electron connection/UI path: pagination, research/production/power/logistics rendering, private-field removal, reload without process restart, and stale data plus confirmed server exit after disconnect. This is zero-model and zero-real-game evidence, not physical mouse or DSP performance verification. A separate metadata-only probe can inspect an explicitly selected source-built MCP with its Bridge descriptor disabled:

~~~powershell
node scripts/probe-mcp-metadata.mjs --executable '<absolute path to Spherewright.Mcp.exe>'
~~~

The local source-built probe observed protocol `2025-06-18`, server `0.4.0.0`, 64 tools and one resource, with zero `tools/call`. A later live source-cohort validation proved basic dedicated-world timing display and stale marking. Loaded-factory performance, panel/request latency, multiple-world and long-run validation remain open.

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

The simulator, pinned Pi, M1 development tools/ledger/protected profiles, M2 read-only panels and M3 assisted research have local software evidence; one real research enqueue and covering normal save have passed. Actual game input and the remaining native-display/docking/failure gates still need separate validation before M0 can pass. M2 loaded-factory/multi-world/long-run performance, M3 input coordination/takeover/failures and M5 installation/recovery remain open. The first finite M4 workflow, including original-diff/evidence navigation, has passed. No tag, installer or release has been published.

## License

CommandDeck is MIT licensed. The Pi submodule retains its upstream MIT license and copyright notices; its source and history remain in the independent fork.
