# Research: Building an OpenCode Orchestrator Plugin

> **Location note:** This repo (`opencode-orchestrator`) had no existing notes convention; `docs/research/` is hereby the chosen convention for research documents.
>
> **Sources & freshness:** All findings verified against primary sources on **2026-07-04**:
>
> - Official docs at <https://opencode.ai/docs> (pages last updated Jul 3, 2026).
> - Source code of the OpenCode repo. **The repo moved from `sst/opencode` to `anomalyco/opencode`** (the GitHub API redirects `sst/opencode` → `anomalyco/opencode`; docs "Edit page" links point at `github.com/anomalyco/opencode`). Default branch is `dev`. All source citations below are from commit `a22676720d6108dc09b1dcfca1dcf02d505906dd` (2026-07-04) and use paths of the form `packages/...`; the full URL form is `https://github.com/anomalyco/opencode/blob/dev/<path>`.
> - The live models.dev registry (`https://models.dev/api.json`), which OpenCode uses for its provider/model catalog (<https://opencode.ai/docs/models/>).

---

## Summary: how to build this

**Ship one npm package that is an OpenCode plugin. The plugin's `config` hook can inject agents — this is supported, deliberate, regression-tested behavior.** The whole "orchestrator + two subagents" system is therefore installable as a single entry in the user's `opencode.json` `plugin` array. No markdown files need to be installed into the user's config directories.

The mechanism, verified in source:

1. Plugins are loaded and their `config` hook is invoked with the **live, mutable, merged config object** (`packages/opencode/src/plugin/index.ts:240-249` — "Notify plugins of current config", `hook.config?.(cfg)`).
2. Bootstrap explicitly initializes plugins before everything else **because** they may mutate config: *"Plugin can mutate config so it has to be initialized before anything else."* (`packages/opencode/src/project/bootstrap.ts:37-38`).
3. The Agent service builds its agent table from `cfg.agent` **after** plugin init, so plugin-injected entries become real agents (`packages/opencode/src/agent/agent.ts:267-294`).
4. There is a dedicated regression test proving it: `packages/opencode/test/agent/plugin-agent-regression.test.ts` ("plugin-registered agents appear in Agent.list") with fixture `packages/opencode/test/fixture/agent-plugin.ts`, which does exactly `cfg.agent["plugin_added"] = { description, mode: "subagent" }` inside the `config` hook.

**Recommended design** (all field references verified below):

```ts
// index.ts of the npm package, e.g. "opencode-orchestrator"
import type { Plugin } from "@opencode-ai/plugin"

export const OrchestratorPlugin: Plugin = async ({ client }) => ({
  config: async (config) => {
    config.agent = config.agent ?? {}
    config.agent["orchestrator"] = {
      description: "Coordinates a swarm of worker subagents; never edits files or runs commands itself.",
      mode: "primary",
      model: "anthropic/claude-fable-5",
      variant: "high",                       // or "xhigh"/"max"; adaptive thinking effort
      prompt: ORCHESTRATOR_SYSTEM_PROMPT,    // embed as a string in the package
      color: "accent",
      permission: {
        "*": "deny",                         // start closed…
        read: "allow", grep: "allow", glob: "allow", list: "allow",
        todowrite: "allow", question: "allow",
        task: {                              // …only its own workers are spawnable
          "*": "deny",
          "swarm-coder": "allow",
          "swarm-reviewer": "allow",
        },
      },
    }
    config.agent["swarm-coder"] = {
      description: "Implementation worker. Use proactively for any code-writing, refactoring, or mechanical task.",
      mode: "subagent",
      model: "openai/gpt-5.5",
      variant: "high",                       // reasoningEffort: "high" ("xhigh" also valid for gpt-5.5)
      prompt: CODER_SYSTEM_PROMPT,
    }
    config.agent["swarm-reviewer"] = {
      description: "Review/design worker on Claude Opus 4.8. Use proactively for review, architecture and taste-sensitive work.",
      mode: "subagent",
      model: "anthropic/claude-opus-4-8",    // NOTE: dash form, not "opus-4.8"
      variant: "high",
      prompt: REVIEWER_SYSTEM_PROMPT,
    }
  },
})
```

Users install it with:

```json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-orchestrator"] }
```

Key correctness points:

- **Lock-down is done with the agent `permission` field**, not the deprecated `tools` map. A blanket `"*": "deny"` with explicit allows removes denied tools from the LLM's tool list entirely (the model never sees `edit`/`bash`/`write`) — see Q5.
- **Reasoning effort is set per-agent with the `variant` field** (built-in variants: Anthropic fable-5/opus-4.8 → `low|medium|high|xhigh|max` adaptive thinking; OpenAI gpt-5.5 → `none|low|medium|high|xhigh` reasoningEffort), or with provider-specific option keys passed through the agent config — see Q3. The agent's `variant` only applies because each agent pins its own `model`.
- `claude-fable-5` and `claude-opus-4-8` report `temperature: false` on models.dev; OpenCode automatically omits temperature for them (`packages/opencode/src/session/llm/request.ts:124-126`), so don't bother setting `temperature`.
- The orchestrator's `permission.task` map controls which subagents it can spawn; denied ones are removed from the Task tool description so the model won't even see them — see Q4/Q8.
- Optional belt-and-braces runtime enforcement via the `tool.execute.before` hook (throwing blocks the call) — see Q5. Do **not** rely on the `permission.ask` hook; it is typed but never triggered in current source.

---

## Q1 — Delivery mechanism

**Can a plugin define/register agents?** Yes — via the `config` hook, which receives the mutable merged config before any agent is materialized:

- Hook type: `config?: (input: Config) => Promise<void>` — `packages/plugin/src/index.ts:225`.
- Invocation with the live config object: `packages/opencode/src/plugin/index.ts:240-249` (`hook.config?.(cfg)` where `cfg = yield* config.get()`; `Config.get` returns the instance-state config object by reference, `packages/opencode/src/config/config.ts:605-607`).
- Ordering guarantee: `packages/opencode/src/project/bootstrap.ts:36-38` — config is eagerly loaded, then `plugin.init()` runs *"before anything else"* precisely because *"Plugin can mutate config"*.
- Consumption: the Agent service reads `cfg.agent` when its state is first materialized (lazily, after bootstrap) and merges each entry over defaults — `packages/opencode/src/agent/agent.ts:267-294`.
- **Regression test:** `packages/opencode/test/agent/plugin-agent-regression.test.ts` + `packages/opencode/test/fixture/agent-plugin.ts` (plugin adds `cfg.agent["plugin_added"]`; test asserts it appears in `Agent.list` with the right `description` and `mode`).

**Alternative: markdown agent files.** Agents can also be defined as markdown in the config directories — `{agent,agents}/**/*.md` globbed from each config dir (`packages/opencode/src/config/agent.ts:11-32`), where the config directories are: the global config dir, every `.opencode` dir walking up from cwd to the worktree root, `~/.opencode`, and `$OPENCODE_CONFIG_DIR` (`packages/opencode/src/config/paths.ts:23-41`). The docs describe this as `~/.config/opencode/agents/` and `.opencode/agents/` (<https://opencode.ai/docs/agents/#markdown>). File name becomes agent name; frontmatter is the agent config; body becomes `prompt` (`packages/opencode/src/config/agent.ts:24-29`). This works, but is not npm-installable as a unit — you'd have to copy files into the user's directories. The plugin route is strictly better for an installable product.

**Plugin distribution.** Two mechanisms (<https://opencode.ai/docs/plugins/#use-a-plugin>):

- **npm:** listed in the `plugin` array of `opencode.json` (regular or scoped packages); installed automatically with Bun at startup and cached in `~/.cache/opencode/node_modules/`.
- **Local files:** `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global) — source globs `{plugin,plugins}/*.{ts,js}` in each config dir (`packages/opencode/src/config/plugin.ts:18-30`).
- A `plugin` entry can also carry options: the config schema is `string | [string, Record<string, unknown>]` (`packages/core/src/v1/config/plugin.ts:8`), and the options land as the plugin function's second argument (`Plugin = (input, options?) => Promise<Hooks>`, `packages/plugin/src/index.ts:74`).
- Load order: global config → project config → global plugin dir → project plugin dir (<https://opencode.ai/docs/plugins/#load-order>); external plugins are applied sequentially for deterministic hook order (`packages/opencode/src/plugin/index.ts:215-238`).

**Conclusion:** ship a single npm package exporting a `Plugin` whose `config` hook injects the three `agent` entries (prompts embedded as strings — the `prompt` field takes a literal string; `{file:...}` templating is only needed for JSON-config-file usage, <https://opencode.ai/docs/agents/#prompt>).

---

## Q2 — Agent definition schema

Authoritative schema: `ConfigAgentV1.Info` in `packages/core/src/v1/config/agent.ts:12-89`. Same schema is used for JSON config (`opencode.json` `agent.<name>`, `packages/core/src/v1/config/config.ts:93-106`) and for markdown frontmatter (`packages/opencode/src/config/agent.ts:24-29`). Fields:

| Field | Type | Notes | Source line |
|---|---|---|---|
| `description` | `string` | "Description of when to use the agent". Docs call it **required** for custom agents (<https://opencode.ai/docs/agents/#description>); schema marks it optional (subagents without one get "This subagent should only be called manually by the user." in the task description, `packages/opencode/src/tool/registry.ts:269`). | agent.ts:25 |
| `mode` | `"subagent" \| "primary" \| "all"` | Defaults to `"all"` when omitted (`packages/opencode/src/agent/agent.ts:276`; docs <https://opencode.ai/docs/agents/#mode>). | agent.ts:26 |
| `model` | `string` | `provider_id/model_id` format; parsed by splitting on the first `/` (`packages/opencode/src/provider/provider.ts:1967-1973`). | agent.ts:14 |
| `variant` | `string` | "Default model variant for this agent (applies only when using the agent's configured model)." | agent.ts:15-17 |
| `temperature` | `number` | Omitted entirely for models with `temperature: false` capability (`packages/opencode/src/session/llm/request.ts:124-126`). | agent.ts:18 |
| `top_p` | `number` | Maps to runtime `topP`. | agent.ts:19 |
| `prompt` | `string` | System prompt (replaces the built-in provider prompt, `packages/opencode/src/session/llm/request.ts:58-66`). | agent.ts:20 |
| `tools` | `Record<string, boolean>` | **Deprecated** — normalized into `permission` (`true`→`allow`, `false`→`deny`; `write`/`edit`/`patch` all fold into `edit`), agent.ts:69-77. Docs: <https://opencode.ai/docs/agents/#tools-deprecated>. | agent.ts:21-23 |
| `disable` | `boolean` | `true` deletes the agent (`packages/opencode/src/agent/agent.ts:268-271`). | agent.ts:24 |
| `hidden` | `boolean` | Hides subagent from `@` autocomplete only; still Task-invocable (<https://opencode.ai/docs/agents/#hidden>). | agent.ts:27-29 |
| `options` | `Record<string, any>` | Provider/model options passthrough. **Any unknown top-level key is also folded into `options`** (normalize step, agent.ts:62-66 with `KNOWN_KEYS` at 43-60) — this is how docs examples put `reasoningEffort: "high"` directly on the agent (<https://opencode.ai/docs/agents/#additional>). | agent.ts:30 |
| `color` | hex `#RRGGBB` or theme color (`primary`,`secondary`,`accent`,`success`,`warning`,`error`,`info`) | UI only. | agent.ts:7-10, 31-33 |
| `steps` | positive int | "Maximum number of agentic iterations before forcing text-only response". `maxSteps` is the deprecated alias (normalized at agent.ts:79). | agent.ts:34-37 |
| `permission` | permission config (see Q5) | Merged over global + defaults (`packages/opencode/src/agent/agent.ts:293`). | agent.ts:38 |
| `name` | `string` | Accepted (in `KNOWN_KEYS`); markdown loader sets it from the file path. | agent.ts:44 |

Runtime representation after merging: `Agent.Info` (`packages/opencode/src/agent/agent.ts:35-56`) — note `top_p`→`topP` and `model` becomes `{providerID, modelID}`.

Built-in agents (source of truth, `packages/opencode/src/agent/agent.ts:140-265`): primaries `build`, `plan`, plus hidden system primaries `compaction`, `title`, `summary`; subagents `general` and `explore`. **Docs/source discrepancy:** the docs also list a built-in `scout` subagent (<https://opencode.ai/docs/agents/#use-scout>), but no `scout` agent exists anywhere in `packages/opencode/src` at commit `a226767` — the docs are ahead of (or divergent from) the source here.

---

## Q3 — Reasoning effort / thinking budget per agent

There are three layers, all funneling into the same merged provider-options object. The merge order (later wins) is: **transform defaults → per-model `options` (from `provider.<id>.models.<id>.options` config) → agent `options` → selected variant's options** — `packages/opencode/src/session/llm/request.ts:80-91`:

```ts
const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
```

**Layer 1 — agent options passthrough.** Any non-schema key on an agent config (or anything under `options`) becomes `agent.options` (Q2) and is merged into provider options. Docs example uses exactly the target shape (<https://opencode.ai/docs/agents/#additional>):

```json
{ "agent": { "deep-thinker": { "model": "openai/gpt-5", "reasoningEffort": "high", "textVerbosity": "low" } } }
```

**Layer 2 — global model options** in `provider.<providerID>.models.<modelID>.options`, e.g. OpenAI `reasoningEffort`/`reasoningSummary`/`include`, Anthropic `thinking: { type: "enabled", budgetTokens }` (<https://opencode.ai/docs/models/#configure-models>).

**Layer 3 — variants (recommended here).** Each reasoning-capable model gets built-in named variants computed by `ProviderTransform.variants()` (`packages/opencode/src/provider/transform.ts:673-1059`), user-extensible via `provider.<id>.models.<id>.variants` (merged with built-ins at `packages/opencode/src/provider/provider.ts:1482`). The agent `variant` field selects one, **but only when the session is running the agent's own configured `model`** (`packages/opencode/src/session/prompt.ts:646-654`: `same = ag.model && model matches`; variant applied only if `ag.variant && full?.variants?.[ag.variant]`). Since our three agents each pin a `model`, `variant` works.

Verified per-model variant behavior for the target models:

- **Anthropic `claude-fable-5` / `claude-opus-4-8`** (via `@ai-sdk/anthropic`): these are "adaptive thinking" models. `anthropicAdaptiveEfforts()` matches opus ≥ 4.7, sonnet ≥ 5, and **explicitly `apiId.includes("fable-5")`** → variants `low | medium | high | xhigh | max`, each producing `{ thinking: { type: "adaptive", display: "summarized" }, effort: "<level>" }` (`packages/opencode/src/provider/transform.ts:600-632` and `902-927`). The older `thinking: { type: "enabled", budgetTokens }` shape is only the fallback for pre-adaptive Claude models (transform.ts:933-946).
- **OpenAI `gpt-5.5`** (via `@ai-sdk/openai`): `openaiReasoningEfforts()` for gpt-5 version ≥ 2 → `none | low | medium | high | xhigh` (`OPENAI_GPT5_2_PLUS_EFFORTS`, transform.ts:520-555, 573-590), each variant producing `{ reasoningEffort: "<level>", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }` (transform.ts:887-900). Confirmed by test expectation `{ id: "openai/gpt-5-5", efforts: ["none", "low", "medium", "high", "xhigh"] }` (`packages/opencode/test/provider/transform.test.ts:3531`). Default without a variant: gpt-5-family gets `reasoningEffort: "medium"` (transform.ts:1182-1196).

Docs summary of built-in variants (Anthropic: `high` (default)/`max`; OpenAI: `none|minimal|low|medium|high|xhigh`): <https://opencode.ai/docs/models/#built-in-variants>. Note the docs' Anthropic list (`high`/`max`) reflects pre-adaptive models; the source shows five adaptive levels for fable-5/opus-4.8. The docs' claim that `high` is the Anthropic default variant has no corresponding automatic-default in the prompt path I could find (variant is applied only from user selection, agent `variant`, or the API caller); treat "default" there as the TUI's initial selection — **UNVERIFIED beyond the doc statement**.

Final assembly: the flat merged options are namespaced per SDK by `ProviderTransform.providerOptions()` — e.g. `{ anthropic: {...} }`, `{ openai: {...} }` (`packages/opencode/src/provider/transform.ts:1265-1323`) — and passed to the AI SDK `streamText` (`packages/opencode/src/session/llm.ts:316`).

**"High effort" recipe used in the summary:** set `variant: "high"` (or `"xhigh"`/`"max"` for even more) on each agent. Equivalent explicit alternative: `options: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" }` for the Anthropic agents and `options: { reasoningEffort: "high", reasoningSummary: "auto" }` for gpt-5.5.

---

## Q4 — Subagent orchestration mechanics

**Tool identity & schema.** The tool is named `task` (`packages/opencode/src/tool/task.ts:24`). Parameters (task.ts:43-62):

- `description: string` — "A short (3-5 words) description of the task"
- `prompt: string` — "The task for the agent to perform"
- `subagent_type: string` — "The type of specialized agent to use for this task"
- `task_id?: string` — resume: "pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one"
- `command?: string`
- `background?: boolean` — only exposed when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (task.ts:56-62, 97-102, 336-341)

**Execution flow** (task.ts:92-334):

1. Permission check: `ctx.ask({ permission: "task", patterns: [subagent_type] })` unless the call came from an explicit user `@` mention (`bypassAgentCheck`, task.ts:104-114; set in `packages/opencode/src/session/prompt.ts:1223`).
2. `agent.get(subagent_type)`; unknown type → error (task.ts:116-119).
3. Child session created with `parentID: ctx.sessionID`, title `"<description> (@<agent> subagent)"`, `agent: <name>` (task.ts:142-158). With `task_id`, the existing child session is reused (task.ts:121-123).
4. Child session permission = parent session's `deny` + `external_directory` rules, **plus** `todowrite` and `task` denied unless the subagent's own config grants them, plus any `experimental.primary_tools` denials (`packages/opencode/src/agent/subagent-permissions.ts:14-27`, task.ts:125-141). The subagent's *own* `permission` ruleset otherwise determines its capabilities (subagent-permissions.ts doc comment: "Parent agent restrictions only govern that agent").
5. Model: the subagent's configured `model`, else the parent's current model; the parent's variant is forwarded **only** when the subagent has no model of its own (task.ts:167-170, 195).
6. Result: the last `text` part of the child session's response, wrapped as `<task id="…" state="completed"><task_result>…</task_result></task>` (task.ts:64-79, 199, 316-320). The `id` is the child session ID, reusable as `task_id`.

**Parallelism.** The tool description explicitly instructs: *"Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses"* (`packages/opencode/src/tool/task.txt:13`). Tool dispatch is owned by the AI SDK `streamText` call (`packages/opencode/src/session/llm.ts:276-324`), which executes parallel tool calls from a single assistant turn concurrently. **No hard concurrency cap on tasks exists in the task tool or registry source.** Background mode (`background: true`) additionally runs a task fully async with completion injected back into the parent session as a synthetic message (task.ts:202-293) — experimental, gated by `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.

**How subagents surface to the Task tool.** `ToolRegistry.describeTask` lists every agent with `mode !== "primary"`, filters out those whose name evaluates to `deny` under the calling agent's `task` permission, sorts alphabetically, and appends `- <name>: <description>` lines to the task tool description (`packages/opencode/src/tool/registry.ts:260-273`, injected at 318-326). So `mode: "subagent"` (or `"all"`) + a good `description` + task-permission `allow` is what makes a worker visible and auto-invocable.

**`@agentname` mentions.** When a prompt part `@name` doesn't resolve to a file, it becomes an `agent` part (`packages/opencode/src/session/prompt.ts:172-179`), which expands to a synthetic instruction: *"Use the above message and context to generate a prompt and call the task tool with subagent: <name>"* — plus a bypass of the task permission check, so users can invoke any subagent even if the current agent's task permission denies it (`prompt.ts:974-990`, `1223`; docs: <https://opencode.ai/docs/agents/#task-permissions> tip).

---

## Q5 — Locking down the orchestrator

**Primary mechanism: the agent `permission` field.** Schema: `packages/core/src/v1/config/permission.ts` — each key maps to `"allow" | "ask" | "deny"` or (for `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, `skill`, and arbitrary/wildcard tool-name keys) an object of `pattern → action`. A bare string (`permission: "deny"`) normalizes to `{"*": …}` (permission.ts:38-48). Known keys: `read`, `edit` (gates `write`, `edit`, `apply_patch`), `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite` (gates `todowrite`+`todoread`), `question`, `webfetch`, `websearch`, `lsp`, `doom_loop`, `skill` (permission.ts:17-36; docs table: <https://opencode.ai/docs/agents/#permissions>). Rules are evaluated with **last matching rule wins** (<https://opencode.ai/docs/permissions/#granular-rules-object-syntax>), and permission keys are wildcard-matched against tool names, so MCP/custom tools are coverable with e.g. `"mymcp_*": "deny"` (same docs section).

Exact syntax for the orchestrator (JSON config-hook injection or markdown frontmatter, identical fields):

```jsonc
"permission": {
  "*": "deny",
  "read": "allow", "grep": "allow", "glob": "allow", "list": "allow",
  "todowrite": "allow", "question": "allow",
  "task": { "*": "deny", "swarm-coder": "allow", "swarm-reviewer": "allow" }
}
```

**What deny actually does — two distinct effects:**

1. **Tool removal from the LLM's tool list**: a tool is stripped before the request when the *last matching rule* for it is a blanket `pattern: "*", action: "deny"` (`packages/opencode/src/permission/index.ts:204-214` `Permission.disabled`, applied in `packages/opencode/src/session/llm/request.ts:208-214` `resolveTools`). The orchestrator model never sees `edit`/`write`/`bash`. Denied subagents are similarly removed from the task description (Q4).
2. **Execution-time blocking**: non-blanket denies (e.g. `bash: { "git push*": "deny" }`) keep the tool visible but fail the call with a `DeniedError` when a matching pattern is used (`packages/opencode/src/permission/index.ts:67-84`).

**`tools` vs `permission`:** `tools: { edit: false, bash: false }` still works but is deprecated and is mechanically converted into permission rules (`true`→`allow`, `false`→`deny`; `write`/`edit`/`patch` fold into `edit`) during agent-config normalization (`packages/core/src/v1/config/agent.ts:68-77`; global equivalent in `packages/opencode/src/config/config.ts:552-563`; docs: <https://opencode.ai/docs/agents/#tools-deprecated>, <https://opencode.ai/docs/permissions/> "As of v1.1.1 the legacy tools boolean config is deprecated"). Use `permission` only.

**Can it still read?** Yes. `read` defaults to `allow` (with `.env` guarded) in the built-in defaults (`packages/opencode/src/agent/agent.ts:119-136`; docs <https://opencode.ai/docs/permissions/#defaults>). With the `"*": "deny"`-first ruleset above, you re-allow `read`/`grep`/`glob`/`list` explicitly.

**Runtime enforcement from the plugin (optional):**

- `tool.execute.before` **is** triggered for every tool execution (multiple call sites in `packages/opencode/src/session/tools.ts:107-421`) and throwing from it blocks the call — the docs' `.env` protection example does exactly this (<https://opencode.ai/docs/plugins/#env-protection>). Its input is `{ tool, sessionID, callID }` (no agent name), so per-agent enforcement requires resolving the session's agent via the SDK `client` first.
- `permission.ask` (`(input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>`, `packages/plugin/src/index.ts:261`) — **declared in the plugin types but has no trigger site anywhere in `packages/` at commit `a226767`** (repo-wide search; the permission service `packages/opencode/src/permission/index.ts` never calls `plugin.trigger`). Treat it as vestigial; do not build on it.

Given the schema-level lockdown removes the tools from the model's view entirely, the plugin-hook layer is optional hardening, not required.

---

## Q6 — Plugin API (full shape)

From `packages/plugin/src/index.ts` (npm: `@opencode-ai/plugin`; docs: <https://opencode.ai/docs/plugins/>):

```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>   // line 74
export type PluginModule = { id?: string; server: Plugin; tui?: never }                // lines 76-80 (new-style export)
```

`PluginInput` (lines 56-66): `client` (OpenCode SDK client), `project`, `directory`, `worktree`, `experimental_workspace.register(type, adapter)`, `serverUrl: URL`, `$` (Bun shell). Both a bare exported plugin function (legacy) and a `{ server }` module export are accepted (`packages/opencode/src/plugin/index.ts:84-121`).

**All hooks** (`Hooks` interface, `packages/plugin/src/index.ts:222-335`), with trigger sites where they exist:

| Hook | Signature (input, output) | Triggered at |
|---|---|---|
| `dispose` | `() => Promise<void>` | instance teardown, plugin/index.ts:261-274 |
| `event` | `({ event }) => Promise<void>` | every bus event, plugin/index.ts:251-258 |
| `config` | `(config) => Promise<void>` — **mutable config; can add `agent` entries** | once at plugin init, plugin/index.ts:240-249 |
| `tool` | `{ [name]: ToolDefinition }` — registers custom tools | tool registry pickup; same-name plugin tools override built-ins (<https://opencode.ai/docs/plugins/#custom-tools>) |
| `auth` | provider auth methods object | provider auth flows |
| `provider` | `{ id, models? }` | provider model listing |
| `chat.message` | `({sessionID, agent?, model?, messageID?, variant?}, {message, parts})` | `packages/opencode/src/session/prompt.ts:1000` |
| `chat.params` | `({sessionID, agent, model, provider, message}, {temperature, topP, topK, maxOutputTokens, options})` — mutate LLM params/options | `packages/opencode/src/session/llm/request.ts:114-132` |
| `chat.headers` | `(…, {headers})` | request.ts:134-146 |
| `permission.ask` | `(Permission, {status})` | **no trigger site in current source — dead** (see Q5) |
| `command.execute.before` | `({command, sessionID, arguments}, {parts})` | prompt.ts:1461 |
| `tool.execute.before` | `({tool, sessionID, callID}, {args})` — throw to block | session/tools.ts (several sites) |
| `tool.execute.after` | `({tool, sessionID, callID, args}, {title, output, metadata})` | session/tools.ts |
| `tool.definition` | `({toolID}, {description, parameters})` — mutate tool schema sent to LLM | `packages/opencode/src/tool/registry.ts:313` |
| `shell.env` | `({cwd, sessionID?, callID?}, {env})` | shell execution + PTY |
| `experimental.chat.messages.transform` | `({}, {messages})` | prompt.ts:1255, compaction.ts:350 |
| `experimental.chat.system.transform` | `({sessionID?, model}, {system})` | request.ts:69, agent.ts:381 |
| `experimental.provider.small_model` | `({provider}, {model?})` | small-model selection |
| `experimental.session.compacting` | `({sessionID}, {context, prompt?})` | compaction.ts:344 |
| `experimental.compaction.autocontinue` | `(…, {enabled})` | compaction.ts:455 |
| `experimental.text.complete` | `({sessionID, messageID, partID}, {text})` | processor.ts:517 |

**Custom tools:** the `tool` export uses the `tool({ description, args, execute })` helper with Zod schemas (`tool.schema = z`), returning `ToolResult` (string or `{title?, output, metadata?, attachments?}`); execute context provides `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata()`, `ask()` (`packages/plugin/src/tool.ts:1-54`; docs <https://opencode.ai/docs/plugins/#custom-tools>). Not needed for this project, but available if the orchestrator ever needs a bespoke coordination tool.

**Can the `config` hook add agents? — YES.** Verified three ways: the mutable-config invocation (plugin/index.ts:240-249), the bootstrap ordering comment (bootstrap.ts:37), and the dedicated regression test (`packages/opencode/test/agent/plugin-agent-regression.test.ts`). Caveat: the hook runs once per instance at plugin init with the already-merged config; it mutates in place (the `Config` TS type in the plugin package is the SDK config shape, `packages/plugin/src/index.ts:70-72`).

---

## Q7 — Model IDs

**Format:** `provider_id/model_id`, split on the first `/` (`packages/opencode/src/provider/provider.ts:1967-1973`; docs <https://opencode.ai/docs/models/#set-a-default>). Providers/models come from the models.dev registry (<https://opencode.ai/docs/models/>).

**Verified against the live models.dev registry (`https://models.dev/api.json`, fetched 2026-07-04):**

| Target | Verified ID | Registry facts |
|---|---|---|
| Claude Fable 5 (Anthropic direct) | `anthropic/claude-fable-5` | released 2026-06-09, `reasoning: true`, `temperature: false`, 1M context / 128K output |
| Claude Opus 4.8 (Anthropic direct) | `anthropic/claude-opus-4-8` — **dash form; there is no `claude-opus-4.8`** | released 2026-05-28, `reasoning: true`, `temperature: false` |
| GPT-5.5 (OpenAI direct) | `openai/gpt-5.5` (also `openai/gpt-5.5-pro`) | released 2026-04-23, `reasoning: true`, `temperature: false` |
| Same models via OpenCode Zen | `opencode/claude-fable-5`, `opencode/claude-opus-4-8`, `opencode/gpt-5.5` | Zen docs model table lists exactly these IDs: `packages/web/src/content/docs/zen.mdx` lines 63-64 (`gpt-5.5`, `gpt-5.5-pro`), 80-81 (`claude-fable-5`, `claude-opus-4-8`); "use `opencode/gpt-5.5` in your config" at line 116 (<https://opencode.ai/docs/zen/>) |

Additional source corroboration: `packages/opencode/src/provider/transform.ts:617,631` special-cases `fable-5` for adaptive thinking; `transform.ts:1177` special-cases `gpt-5.5` on Azure; the transform tests exercise `openai/gpt-5-5`, `gpt-5.5-pro`, opus 4.7+ and sonnet 5 (`packages/opencode/test/provider/transform.test.ts:3252-3536`).

So the exact strings for this project (Anthropic + OpenAI keys directly): `anthropic/claude-fable-5`, `anthropic/claude-opus-4-8`, `openai/gpt-5.5`. If the user routes through Zen, prefix with `opencode/` instead.

---

## Q8 — Keeping the swarm on task (orchestrator-workflow features)

- **Descriptions drive automatic invocation.** Subagent `description` text is injected verbatim into the task tool description the orchestrator sees (`packages/opencode/src/tool/registry.ts:266-272`), and the task prompt tells the model: *"If the agent description mentions that it should be used proactively, then you should try your best to use it"* (`packages/opencode/src/tool/task.txt:19`). Write worker descriptions as routing instructions ("Use proactively for …").
- **`permission.task` fences the roster.** `deny` removes a subagent from the task description entirely "so the model won't attempt to invoke it" (<https://opencode.ai/docs/agents/#task-permissions>; enforced at registry.ts:262-264 and at execution via `ctx.ask`, task.ts:105-114). Give the orchestrator `task: { "*": "deny", "swarm-*": "allow" }` so it can only use its own workers; leave workers without a `task` grant so they can't recursively spawn (default child deny, `packages/opencode/src/agent/subagent-permissions.ts:25`).
- **`hidden: true`** keeps workers out of the user's `@` autocomplete while remaining Task-invocable (<https://opencode.ai/docs/agents/#hidden>; `packages/core/src/v1/config/agent.ts:27-29`). Optional — visible workers let users address them directly.
- **`disable: true`** removes an agent entirely, including built-ins (`packages/opencode/src/agent/agent.ts:268-271`) — e.g. users could disable `general` to force traffic through the swarm; the built-in `plan` agent already denies `task: { general: "deny" }` as precedent (agent.ts:165-167).
- **Concurrency:** parallel fan-out happens by emitting multiple `task` calls in one assistant message (task.txt:13); no documented or coded per-session cap on concurrent foreground tasks. Background tasks (fire-and-forget with auto-notification) exist behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (task.ts:97-102).
- **Session model:** each task creates a child session (`parentID` set, task.ts:144-147); the TUI navigates parent/child with `session_child_first` / `session_child_cycle` / `session_parent` (<https://opencode.ai/docs/agents/#usage>). Results return to the parent as a single `<task_result>` message — "The result returned by the agent is not visible to the user", so the orchestrator must summarize (task.txt:15). `task_id` resumes a child session with full prior context (task.txt:16; task.ts:121-123).
- **Iteration budget:** `steps` caps agentic iterations per agent, after which the agent is forced to summarize remaining work (<https://opencode.ai/docs/agents/#max-steps>; `packages/core/src/v1/config/agent.ts:34-36`). Useful on workers to bound runaway loops; leave the orchestrator uncapped.
- **Stuck detection:** the `doom_loop` permission fires when the same tool call repeats 3× with identical input (default `ask`; <https://opencode.ai/docs/permissions/#available-permissions>).
- **`experimental.primary_tools`** config lists tools available only to primary agents — automatically denied in every task child session (`packages/core/src/v1/config/config.ts:173-175`; `packages/opencode/src/tool/task.ts:136-140`).
- **Compaction hooks** (`experimental.session.compacting`) let the plugin inject swarm-state context so long orchestrations survive compaction — the docs example is literally "a multi-agent swarm session" continuation prompt (<https://opencode.ai/docs/plugins/#compaction-hooks>).

---

## Discrepancies & unverified items

1. **`scout` subagent:** documented as built-in (<https://opencode.ai/docs/agents/#use-scout>) but absent from `packages/opencode/src/agent/agent.ts` and the rest of `packages/opencode/src` at commit `a226767`. Docs and source disagree.
2. **`permission.ask` plugin hook:** present in `@opencode-ai/plugin` types (`packages/plugin/src/index.ts:261`) but never triggered anywhere in `packages/` at this commit. Do not rely on it.
3. **Anthropic default variant "high":** stated in docs (<https://opencode.ai/docs/models/#built-in-variants>) but I found no automatic default-variant selection in the prompt pipeline; variant application requires explicit selection (user, agent `variant`, or API input) — `packages/opencode/src/session/prompt.ts:646-654`. UNVERIFIED beyond the doc claim.
4. **Docs' Anthropic variant list (`high`/`max`)** is stale for adaptive-thinking models: source gives fable-5/opus-4.8 five levels (`low|medium|high|xhigh|max`) with the `thinking: adaptive` + `effort` shape (`packages/opencode/src/provider/transform.ts:616-628, 902-927`).
5. **Model ID spelling:** the user-requested "claude-opus-4.8" does not exist as an ID; the registry ID is `claude-opus-4-8` (models.dev, fetched 2026-07-04). `claude-fable-5` and `gpt-5.5` are exact.
6. **Repo location:** `sst/opencode` now redirects to `anomalyco/opencode` (GitHub API `repos/get` on both returns `full_name: "anomalyco/opencode"`).
