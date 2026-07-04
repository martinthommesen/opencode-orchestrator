# opencode-orchestrator

An opencode plugin that ships an Orchestrator agent (claude-fable-5, high effort) which never does work itself, plus the Swarm of Workers it directs (gpt-5.5 and claude-opus-4-8). Everything is injected via the plugin `config` hook — one npm package, no markdown agent files (ADR-0001).

## Working here

- Commands: `bun test` (13 contract tests on the config hook), `bun run typecheck` (`tsc --noEmit`). No build step — `main` points at `src/index.ts`; opencode runs TS natively under Bun.
- Layout: `src/index.ts` (agent definitions + config hook, default `{ id, server }` export), `src/prompts.ts` (all orchestration policy as exported string constants), `test/plugin.test.ts` (the entire external contract).
- The spec is PRD issue #1; it matches the implementation. Reading order for context:
  1. `CONTEXT.md` — glossary. Use these exact terms (Orchestrator, Plan Orchestrator, Worker, Brief, Verdict, Spot-check, User-facing surface) in code, tests, and issues.
  2. `gh issue view 1 --comments` — the PRD: the six agents, permission matrices, orchestration policy, test contract.
  3. `docs/adr/0001-plugin-config-hook-agent-injection.md` — why agents ship via the `config` hook, not markdown files. Don't "fix" this.
  4. `docs/research/opencode-orchestrator-plugin.md` — every opencode API fact used here, cited against opencode source (pinned to commit `a226767`, 2026-07-04). Don't re-research these; if opencode behavior seems to contradict the doc, check the pin date first.
- The published `@opencode-ai/plugin`/SDK generated types lag the runtime schema (no agent `variant`; `permission` closed over five keys). `AgentDefinition` in `src/index.ts` is the source-verified shape; the one widening cast lives in the config hook. Don't "fix" the cast by weakening the definitions.
- Plugin loader facts (verified at the pinned commit): the default export must be an object with `server` (and `id`, required for `file://` loading); the npm entry resolves via package.json `main` — `exports` is only consulted for a `./server` key.

## Verified opencode facts (easy to get wrong)

- Model IDs: `anthropic/claude-fable-5`, `anthropic/claude-opus-4-8` (dash form — `claude-opus-4.8` does not exist), `openai/gpt-5.5`. Direct providers only; never the `opencode/` (Zen) prefix.
- Reasoning effort is the agent-level `variant: "high"` field; it only applies because each agent pins its own `model`.
- Lockdown uses the `permission` field — the `tools` map is deprecated. A blanket `"*": "deny"` plus explicit allows strips denied tools from the model's tool list entirely.
- These models report `temperature: false`; never set `temperature` on them.
- The `permission.ask` plugin hook is typed in `@opencode-ai/plugin` but never triggered — do not build on it.
- The opencode repo moved: `sst/opencode` → `anomalyco/opencode`, default branch `dev`.

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
