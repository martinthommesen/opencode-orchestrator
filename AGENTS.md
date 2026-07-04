# opencode-orchestrator

An opencode plugin that ships an Orchestrator agent (claude-fable-5, high effort) which never does work itself, plus the Swarm of Workers it directs (gpt-5.5 and claude-opus-4-8). Everything is injected via the plugin `config` hook — one npm package, no markdown agent files (ADR-0001).

## Working here

- Commands: `bun test` (24 contract tests on the two plugin seams), `bun run typecheck` (`tsc --noEmit`). No build step — `main` points at `src/index.ts`; the CLI (Bun) and the Desktop sidecar (Electron ≥42's Node, native type stripping) both import TS directly. Keep the source erasable-syntax-only: no enums, no namespaces, explicit `.ts` extensions on relative imports.
- Layout: `src/index.ts` (agent definitions + both plugin surfaces, default `{ id, server, setup }` export), `src/prompts.ts` (all orchestration policy as exported string constants), `test/plugin.test.ts` (the entire external contract).
- The spec is PRD issue #1; it matches the implementation. Reading order for context:
  1. `CONTEXT.md` — glossary. Use these exact terms (Orchestrator, Plan Orchestrator, Worker, Brief, Verdict, Spot-check, User-facing surface) in code, tests, and issues.
  2. `gh issue view 1 --comments` — the PRD: the six agents, permission matrices, orchestration policy, test contract.
  3. `docs/adr/0001-plugin-config-hook-agent-injection.md` — why agents ship via the `config` hook, not markdown files. Don't "fix" this.
  4. `docs/research/opencode-orchestrator-plugin.md` — every opencode API fact used here, cited against opencode source (pinned to commit `a226767`, 2026-07-04). Don't re-research these; if opencode behavior seems to contradict the doc, check the pin date first.
- The published `@opencode-ai/plugin`/SDK generated types lag the runtime schema (no agent `variant`; `permission` closed over five keys). `AgentDefinition` in `src/index.ts` is the source-verified shape; the one widening cast lives in the config hook. Don't "fix" the cast by weakening the definitions.
- Plugin loader facts (verified at the pinned commit): the default export must be an object with `server` (and `id`, required for `file://` loading); the npm entry resolves via package.json `main` — `exports` is only consulted for a `./server` key.

## Verified opencode facts (easy to get wrong)

- Model IDs: primaries run on the **Copilot subscription** — `github-copilot/claude-opus-4.8` and `github-copilot/gpt-5.5` (Copilot uses dot-form Claude IDs). Direct-provider fallbacks use the same model on its own provider: `anthropic/claude-opus-4-8` (dash form — `anthropic/claude-opus-4.8` does not exist) and `openai/gpt-5.5`. Never the `opencode/` (Zen) prefix.
- Per-agent reasoning effort is the agent-level `variant` field (only applies because each agent pins its own `model`): orchestrator + orchestrator-plan `max`, reviewer `xhigh`, everyone else `high`. Both the Copilot model and its direct fallback support every effort used (opus-4.8: low/medium/high/xhigh/max; gpt-5.5: none/low/medium/high/xhigh) — verified live against the provider catalog.
- Agent `model` is a single string — opencode has **no per-request model failover** (the engine retries transient errors on the same model; `packages/opencode/src/session/retry.ts`). The plugin's blueprints therefore carry ordered model chains resolved once at injection time against the authenticated providers. Availability comes from `$XDG_DATA_HOME/opencode/auth.json` + `config.provider` only — **API keys are never consulted** (subscriptions only); with no provider available the Copilot primary is kept so the runtime error stays clear. Each chain is `[Copilot model, same model on its direct provider]`.
- Lockdown uses the `permission` field — the `tools` map is deprecated. A blanket `"*": "deny"` plus explicit allows strips denied tools from the model's tool list entirely.
- The blanket deny also wipes *rule-only* permissions that have no tool (verified live on 1.17.13): `external_directory` and the platform's `read` .env gates. Every locked-down agent must restate them (`external_directory: "ask"`, `read: READ_GATES`) or outside-workspace reads hard-deny — and Workers inherit the parent session's external_directory rules, so a broken Orchestrator blocks the whole Swarm. `/compact` is **not** permission-gated (compaction runs under the built-in `compaction` agent; verified live on both servers).
- These models report `temperature: false`; never set `temperature` on them.
- The `permission.ask` plugin hook is typed in `@opencode-ai/plugin` but never triggered — do not build on it.
- The opencode repo moved: `sst/opencode` → `anomalyco/opencode`, default branch `dev`.

## Two servers, two plugin surfaces (Desktop ≠ CLI)

- The CLI runs the v1 server (`packages/opencode`); **opencode Desktop runs the v2 server** (`packages/server` + `packages/core`) in an Electron-Node sidecar. The v2 external-plugin loader (`packages/core/src/config/plugin/external.ts`) only accepts default exports shaped `{ id, effect }` or `{ id, setup }` and **silently ignores** v1 `{ id, server }` modules (`Effect.ignoreCause`).
- Hence the dual default export `{ id, server, setup }`: v1 uses `server` (config hook), v2 uses `setup` (`context.agent.transform`). Each loader ignores the other's key. Don't remove either surface.
- v2 permissions are ordered rule lists `{ action, resource, effect }` with **last-match-wins** (`PermissionV2.evaluate` uses `findLast`); an agent with no matching rule falls back to `"ask"`. There is no inheritance for plugin-created agents — v2's own built-ins each compose a full baseline, which is why the Implementer/Designer rulesets embed a `build`-equivalent allow-all baseline in v2 while staying inherit-only in v1.
- Stale-divergence watch (observed live on Desktop 1.17.13): the sidecar now composes plugin agents with the user-global rule prefix, and its live rulesets match the **v1 permission maps** (the v1 `server` hook is applied there too). The `setup` surface stays for builds where it isn't; the upsert guard (`draft.get(name)`) prevents double-injection when both run.
- Loading on Desktop: npm/github plugin specs currently fail to import under the Node sidecar (`resolveEntryPoint` resolves a directory URL that Node cannot import). Use an **absolute file path** plugin entry (points at `src/index.ts`) — it works on both servers. Node's type stripping refuses TS inside `node_modules`, another reason npm distribution needs care (ship JS before publishing).

## Implementation conventions (decided in PRD #1)

- TypeScript + Bun; types from `@opencode-ai/plugin`; new-style `{ server }` plugin export.
- Prompts are exported TS string constants — no runtime file loading.
- Tests: `bun test`. Single seam: call the exported plugin's `config` hook with a stub input, assert the six injected agent entries and merge safety (never overwrite pre-existing user agents). Never assert on prompt wording.
- The Implementer/Designer "full toolset" is inherited, not granted: the plugin sets only a `task` deny; edit/bash/webfetch flow from opencode defaults plus the user's global permission config, so user-level ask/deny gates keep applying inside Worker sessions. Do not "complete" the matrix with blanket allows — that would override user gates and break the additive posture.
- Posture is additive: never disable built-in agents, no runtime enforcement hooks, no compaction hooks.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues via the `gh` CLI; external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
