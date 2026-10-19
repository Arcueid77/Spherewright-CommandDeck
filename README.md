# Spherewright CommandDeck

A desktop workspace for playing Dyson Sphere Program with a structured Agent and for developing and validating Spherewright.

**Status: repository initialization. The desktop application, native game-window hosting, Agent integration and workspace UI are not implemented yet.**

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

Application dependency wiring is pending. Pi is a workspace monorepo: when wiring the build, its internal packages must resolve to this fork, rather than silently mixing modified source with registry copies. A source checkout alone does not prove that build or runtime integration works. End-user packages should contain the required runtime artifacts without requiring Git, Node.js or source checkouts.

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

These are planned slices, not completed features or gameplay authorization. There is no application build, model/API test, native embedding test or game acceptance claim in this initialization.

## License

CommandDeck is MIT licensed. The Pi submodule retains its upstream MIT license and copyright notices; its source and history remain in the independent fork.
