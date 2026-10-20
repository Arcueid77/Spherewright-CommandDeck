# Spherewright CommandDeck

A desktop workspace for playing Dyson Sphere Program with a structured Agent and for developing and validating Spherewright.

**Status: M0 prototype in progress. The desktop shell, pinned Pi source integration and game-owned host simulators run locally. A separate BepInEx window adapter now compiles against the installed Unity references; it has not been deployed or validated in DSP. The development workspace is not implemented.**

Implementation stages, dependencies and acceptance gates are tracked in [ROADMAP.md](ROADMAP.md) (Chinese). The 0.1.0 plan includes both a directly interactive native game viewport and a development workflow across Spherewright and Lab.

## Repository boundaries

| Repository | Responsibility |
| --- | --- |
| [Spherewright](https://github.com/Arcueid77/Spherewright) | Game Plugin, local Bridge, MCP contracts, native observations and controlled actions. |
| [Spherewright-Lab](https://github.com/Arcueid77/Spherewright-Lab) | Scenarios, acceptance evidence and version locks across the product repositories. |
| [spherewright-commanddeck](https://github.com/Arcueid77/spherewright-commanddeck) | Desktop UI, native game-window host, development workspaces, task permissions and the game-action ledger. |
| [spherewright-pi](https://github.com/Arcueid77/spherewright-pi) | Source fork of the Pi Agent runtime, included here as the vendor/pi submodule. |

Lab belongs in a Spherewright **development workspace**, alongside the game-control source and CommandDeck. It is an independent repository and is not a required dependency of the CommandDeck application build or installed runtime. Existing checkouts can stay in their current locations; the planned workspace UI should support multiple explicitly authorized roots.

Conceptual layout, rather than a requirement to move existing repositories:

~~~text
Development workspace
  Spherewright/                 game-control source
  Spherewright-Lab/             scenarios and acceptance evidence
  spherewright-commanddeck/     desktop application source
    vendor/pi/                  spherewright-pi Git submodule
~~~

## Pi source dependency

The fork preserves the complete upstream monorepo and its license notices. Upstream is [earendil-works/pi](https://github.com/earendil-works/pi), formerly badlogic/pi-mono.

The initial submodule baseline is upstream v1.3.0, commit 71023aec1546d6d677a65669c5665c0927ce0dd0. The parent repository pins an exact commit; it does not automatically follow the fork's default branch. Future CommandDeck releases must record both the application commit and the Pi submodule commit.

Clone with the pinned dependency:

~~~powershell
git clone --recurse-submodules https://github.com/Arcueid77/spherewright-commanddeck.git
~~~

For an existing checkout:

~~~powershell
git submodule update --init --recursive
~~~

Changes to Pi are committed and pushed in spherewright-pi first. CommandDeck then records the new submodule commit in a separate integration change. Check out an explicit development branch before editing the submodule; an ordinary submodule checkout is detached.

The prototype imports the built coding-agent entry directly from the submodule. `pi:verify` checks the exact commit, compiled entries and internal workspace links. Pi source is unchanged at this baseline. Its ignored model catalog is restored from the matching versioned npm artifact using the integrity in `pi-model-data-lock.json`; only JSON catalog data is copied, not registry runtime modules. End-user packaging remains a later milestone.

## Run the Windows M0 prototype

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

`npm run probe:native-focus` records a remaining focused-UI hang; its normal exit is not an input-isolation pass. `npm run test:native-ui-recovery` separately proves a bounded rescue with WinForms fixtures. The desktop now uses an independent supervisor for the actual Electron UI process, native connection and Pi utility process. Its main-thread heartbeat expires after one second; it confirms the registered UI has exited before creating at most one automatic replacement. The simulated game remains standalone until explicitly reattached.

Close the demo before running `npm run test:desktop`, `npm run test:desktop-host-exit` or `npm run test:desktop-recovery-limit`. These tests cover reload/renderer crash, an actual Electron UI-thread hang, a model round already in flight, abrupt simulator-host exit, and a second UI failure that stops automatic replacement. The wrapper requires the new process's run ID and completed proof, so an old artifact cannot pass a new run. Synthetic results go under ignored `.local/`; private Pi sessions live under the application's `userData/supervisor/m0-probes` directory. The disposable UI has a separate Chromium profile. Neither is committed. Probe snapshots survive UI replacement only while the supervisor stays alive; a durable task ledger is not implemented.

## CC Switch / Pi provider configuration

The model selector reads provider/model metadata from Pi's `models.json`, normally under `~/.pi/agent`. Existing CC Switch Pi providers can be reused. `COMMANDDECK_PI_CONFIG_DIR`, then `PI_CODING_AGENT_DIR`, can select another configuration directory. The prototype does not rewrite shared Pi configuration or copy keys into the repository or renderer. Credential command values are rejected, including model header overrides; remote endpoints require HTTPS.

Startup makes no model request. Choose a configured model and click the live probe explicitly, or use:

~~~powershell
npm run smoke:live -- --provider '<configured-provider-id>' --model '<configured-model-id>'
~~~

The fixed probe permits at most two model requests and one `deck_echo` execution, caps requested output at 512 tokens per response, disables retries, and has a wall-clock timeout. It has no game, shell or file-editing tools, project resources, extensions, skills or MCP discovery. Active and callable tool sets are both checked. `npm run smoke:offline` uses a loopback fake service without external model access.

Locally verified on 2026-10-20: source builds and type checks; ten Node tests including split tool arguments, cancellation, denied tools, session reopening without execution, and failed second responses; native ownership/detach/failure tests; and one live MiniMax-M3.1-Flash roundtrip through the desktop utility process. Only that configured Chat Completions compatible endpoint has live evidence. Foreign-window mutations run serially off the host UI thread; focused child windows still share input queues. In the actual Electron hang test, the supervisor ends only its registered UI after roughly one second, the original native input request resumes, the same Pi process finishes the in-flight offline probe after UI exit, and a replacement displays its result without resubmission. Abrupt simulator-host exit recreates one visible top-level UI while keeping Pi and never restarting the host. A second UI failure stops automatic replacement. These are finite simulator tests; physical input, DPI changes and real DSP/Steam behavior remain unqualified. M0 as a whole has not passed.

## Game-side window adapter candidate

The new `native/CommandDeck.UnityAdapter` is a separate, window-only BepInEx plugin, not a Spherewright game-control change. It is inactive without the per-launch `--commanddeck-host` argument. It exposes only native hosting, layout, focus and restoration over a protected local pipe; it has no game-world, save, input-injection or process-termination operation. The first display profile accepts a windowed game and UI on the same 100% scale monitor; changing that profile requests detachment. Other display profiles remain unsupported.

For a local compile, copy only the private BepInEx/Unity references from an explicitly supplied installation, then build:

~~~powershell
pwsh -File scripts/sync-unity-refs.ps1 -DspDir '<DSP installation>'
npm run build:unity-adapter
~~~

Game DLLs stay under ignored `.local/game-refs` and are never shipped. The candidate output is under ignored `artifacts/unity-adapter`; it has not been installed. CI builds both shared cores for .NET Framework 4.7.2 and runs simulators; it cannot compile the Unity plugin without those private references. The plugin's actual local compile is a separate result.

`test:adapter-layout` checks both completion/request orderings; `test:adapter-native` checks the shared Win32 source, including an unexpected host-thread quit; `test:adapter-bridge` checks authentication, OS peer identity before sending the credential, malformed clients, EOF, restoration quarantine and descriptor ownership. `test:adapter-route` verifies that helper exit cannot clear an unreconciled host. `test:desktop-adapter` runs the real Electron UI through the same pipe protocol against a fake game, including UI replacement with an in-flight Pi probe. None starts or calls DSP.

## Planned execution boundaries

- Development mode may expose source-editing and build tools for explicitly authorized workspace roots, while respecting each repository's instructions.
- Game mode exposes controlled Spherewright tools. It does not inherit development shell or file permissions.
- Switching modes does not authorize a pending game action. Approvals, budgets, commit intents, original action identities and receipts belong to CommandDeck's task ledger, independently of Pi conversation history.
- Game writes continue through Spherewright prepare/commit and original-action reconciliation. Unknown outcomes stop further writes; a resumed conversation never authorizes replay.
- Native game-window embedding is the preferred technical experiment for direct human input. Compatibility with DSP, Steam startup, focus, DPI, docking and host shutdown remains unverified. Agent game control remains on the structured MCP path.

## Initial implementation priorities

1. Prove native game-window hosting and safe window detachment in an isolated prototype.
2. Integrate the pinned Pi source with explicit tools and resource loading.
3. Add development-workspace access and a read-only game dashboard, then a bounded approved game task with durable action evidence and a Spherewright-to-Lab development/validation workflow.

The simulator and Pi portions of the first two slices now have local evidence. The game-side window adapter is a compiled candidate; deployment, Unity runtime compatibility, actual game input and the remaining M0 gates still need separate validation. Development tools, the task ledger and all game execution remain future work.

## License

CommandDeck is MIT licensed. The Pi submodule retains its upstream MIT license and copyright notices; its source and history remain in the independent fork.
