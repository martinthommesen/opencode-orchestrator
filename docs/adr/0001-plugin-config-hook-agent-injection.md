# Agents ship via plugin config-hook injection, not markdown files

The Orchestrator and its four Workers are injected by the plugin's `config` hook, which receives opencode's live merged config object and adds `agent` entries before any agent is materialized. This makes the entire system installable as a single npm package in the `plugin` array — no markdown files copied into user config directories, no installer.

This relies on non-obvious but deliberate, regression-tested opencode behavior: plugins are initialized before everything else *because* they may mutate config (`packages/opencode/src/project/bootstrap.ts:37`), the `config` hook mutates the config in place (`packages/opencode/src/plugin/index.ts:240-249`), and `packages/opencode/test/agent/plugin-agent-regression.test.ts` pins plugin-injected agents appearing in `Agent.list`. See `docs/research/opencode-orchestrator-plugin.md` (Q1, Q6).

## Considered Options

- **Markdown agent files** (`.opencode/agents/*.md`) — the documented mainstream path, but not npm-installable as a unit: users would have to copy five files into their config directories and keep them updated by hand.
