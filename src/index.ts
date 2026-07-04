import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"
import type { AgentDraft, PluginContext, Plugin as PluginV2 } from "@opencode-ai/plugin/v2/promise"
import {
  DESIGNER_PROMPT,
  EXPLORER_PROMPT,
  IMPLEMENTER_PROMPT,
  ORCHESTRATOR_PLAN_PROMPT,
  ORCHESTRATOR_PROMPT,
  REVIEWER_PROMPT,
} from "./prompts.ts"

type PermissionAction = "allow" | "ask" | "deny"
type PermissionRules = Record<string, PermissionAction | Record<string, PermissionAction>>

/**
 * The agent config shape this plugin relies on.
 *
 * The published SDK's generated `AgentConfig` type lags the runtime schema:
 * it lacks `variant` and closes `permission` over five keys, while the
 * runtime accepts the full rule set. Every field below is verified against
 * opencode source in docs/research/opencode-orchestrator-plugin.md (Q2, Q3,
 * Q5); the single widening cast lives in the config hook.
 */
export type AgentDefinition = {
  description: string
  mode: "primary" | "subagent"
  model: string
  variant: "high"
  prompt: string
  permission: PermissionRules
}

/**
 * An agent blueprint carries an ordered model chain instead of a pinned
 * model: the first entry is the primary, the rest are startup fallbacks used
 * when the primary's provider is not authenticated on this machine. opencode
 * has no per-request failover (agent config takes a single model; the engine
 * retries transient errors on the same model), so the chain is resolved once
 * at injection time.
 */
type AgentBlueprint = Omit<AgentDefinition, "model"> & { models: readonly [string, ...string[]] }

const FABLE = "anthropic/claude-fable-5"
const OPUS = "anthropic/claude-opus-4-8"
const GPT_5_5 = "openai/gpt-5.5"

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
}

/**
 * Providers usable on this machine: an env API key, an entry in opencode's
 * auth store, or a provider configured in the loaded config. Best effort —
 * an unreadable store just means env/config decide.
 */
export function authenticatedProviders(configured: Iterable<string> = []): Set<string> {
  const providers = new Set(configured)
  for (const [provider, key] of Object.entries(PROVIDER_ENV_KEYS)) {
    if (process.env[key]) providers.add(provider)
  }
  try {
    const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
    const auth = JSON.parse(readFileSync(join(dataHome, "opencode", "auth.json"), "utf8")) as Record<string, unknown>
    for (const provider of Object.keys(auth)) providers.add(provider)
  } catch {
    // no auth store on this machine
  }
  return providers
}

function resolveModel(models: readonly [string, ...string[]], available: ReadonlySet<string>): string {
  return models.find((model) => available.has(model.slice(0, model.indexOf("/")))) ?? models[0]
}

/**
 * The platform's own read gates, restated so a broad read allow cannot
 * override them (rules are last-match-wins, and the lockdown's rules come
 * after the globally composed defaults).
 */
const READ_GATES = {
  "*": "allow",
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow",
} as const satisfies Record<string, PermissionAction>

/**
 * Spot-check reads: the only filesystem access the locked-down agents keep.
 * `external_directory` is restated at the platform's `ask` default because the
 * blanket `"*": "deny"` would otherwise wipe it — silently blocking reads of
 * anything outside the workspace (global skills, docs) for these agents and,
 * via subagent permission inheritance, for every Worker they spawn.
 */
const READS = {
  read: READ_GATES,
  grep: "allow",
  glob: "allow",
  list: "allow",
  external_directory: "ask",
} as const satisfies PermissionRules

function orchestratorPermission(fence: Record<string, PermissionAction>): PermissionRules {
  return {
    "*": "deny",
    ...READS,
    todowrite: "allow",
    question: "allow",
    task: { "*": "deny", ...fence },
  }
}

const BLUEPRINTS: Record<string, AgentBlueprint> = {
  orchestrator: {
    description:
      "Directs the Swarm: decomposes work into Briefs, routes them to Workers, verifies claims by Spot-check, and gates acceptance behind Reviewer Verdicts. Never edits files or runs commands itself.",
    mode: "primary",
    models: [FABLE, GPT_5_5],
    variant: "high",
    prompt: ORCHESTRATOR_PROMPT,
    permission: orchestratorPermission({
      explorer: "allow",
      implementer: "allow",
      designer: "allow",
      reviewer: "allow",
    }),
  },
  "orchestrator-plan": {
    description:
      "The Orchestrator behind a read-only Swarm fence: it can spawn only the Explorer and Reviewer, so nothing reachable from this agent can mutate the working tree. Plan here, then switch to orchestrator to execute.",
    mode: "primary",
    models: [FABLE, GPT_5_5],
    variant: "high",
    prompt: ORCHESTRATOR_PLAN_PROMPT,
    permission: orchestratorPermission({
      explorer: "allow",
      reviewer: "allow",
    }),
  },
  explorer: {
    description:
      "Read-only reconnaissance Worker. Use proactively for codebase and docs questions: mapping territory, locating symbols, and gathering cited evidence before work is briefed.",
    mode: "subagent",
    models: [GPT_5_5, OPUS],
    variant: "high",
    prompt: EXPLORER_PROMPT,
    permission: {
      "*": "deny",
      ...READS,
      webfetch: "allow",
    },
  },
  implementer: {
    description:
      "Implementation Worker for everything except User-facing surfaces. Use proactively for features, refactors, migrations, and tests once a tight, self-contained Brief exists.",
    mode: "subagent",
    models: [GPT_5_5, OPUS],
    variant: "high",
    prompt: IMPLEMENTER_PROMPT,
    permission: {
      task: { "*": "deny" },
    },
  },
  designer: {
    description:
      "Design-and-build Worker that owns User-facing surfaces (UI, UX flows, visual styling, copy, public API shape) end to end, and produces taste-sensitive proposals such as API shapes and architecture options.",
    mode: "subagent",
    models: [OPUS, GPT_5_5],
    variant: "high",
    prompt: DESIGNER_PROMPT,
    permission: {
      task: { "*": "deny" },
    },
  },
  reviewer: {
    description:
      "Read-only review Worker. Use proactively for Verdicts on plans and diffs: accept or revise, with concrete located findings classified as execution or approach flaws.",
    mode: "subagent",
    models: [OPUS, GPT_5_5],
    variant: "high",
    prompt: REVIEWER_PROMPT,
    permission: {
      "*": "deny",
      ...READS,
    },
  },
}

/** Materializes the blueprints against the providers available right now. */
export function resolveAgents(available: ReadonlySet<string>): Record<string, AgentDefinition> {
  return Object.fromEntries(
    Object.entries(BLUEPRINTS).map(([name, { models, ...definition }]) => [
      name,
      { ...definition, model: resolveModel(models, available) },
    ]),
  )
}

type SdkAgentConfig = NonNullable<Config["agent"]>[string]

/**
 * v1 surface (CLI/TUI server): the config hook injects the agent entries into
 * opencode's live merged config before agents are materialized.
 */
const server: Plugin = async () => ({
  config: async (config) => {
    const available = authenticatedProviders(Object.keys(config.provider ?? {}))
    const agents = (config.agent ??= {})
    for (const [name, definition] of Object.entries(resolveAgents(available))) {
      // Never overwrite an agent the user already defined under the same name.
      // Widening cast: see the AgentDefinition doc comment.
      agents[name] ??= definition as unknown as SdkAgentConfig
    }
  },
})

/**
 * v2 surface (Desktop sidecar server): agents are registered through the
 * agent-draft transform pipeline. Permission semantics are rule lists with
 * last-match-wins — the same order our v1 permission maps carry — so each
 * v1 map converts mechanically to `{ action, resource, effect }` triples.
 */
export type PermissionRule = { action: string; resource: string; effect: PermissionAction }

export function toRuleset(permission: PermissionRules): PermissionRule[] {
  return Object.entries(permission).flatMap(([action, rule]) =>
    typeof rule === "string"
      ? [{ action, resource: "*", effect: rule }]
      : Object.entries(rule).map(([resource, effect]) => ({ action, resource, effect })),
  )
}

/**
 * v2 has no permission inheritance for plugin-created agents (an agent with
 * no matching rule falls back to "ask" for everything), so full-toolset
 * Workers carry the same baseline opencode gives its own `build` agent.
 */
const FULL_TOOLSET_BASELINE: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  ...toRuleset({ external_directory: "ask", read: READ_GATES }),
]

function toV2Ruleset(definition: AgentDefinition): PermissionRule[] {
  // Locked-down agents (blanket "*" deny) are self-contained rule sets — the
  // read gates and external_directory default live inside their maps;
  // full-toolset Workers get the platform baseline before their task fence.
  if ("*" in definition.permission) return toRuleset(definition.permission)
  return [...FULL_TOOLSET_BASELINE, ...toRuleset(definition.permission)]
}

function modelRef(model: string): { providerID: string; id: string; variant: "high" } {
  const slash = model.indexOf("/")
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), variant: "high" }
}

function upsertAgents(draft: AgentDraft): void {
  for (const [name, definition] of Object.entries(resolveAgents(authenticatedProviders()))) {
    // Never overwrite an agent that already exists (user-defined or built-in).
    if (draft.get(name)) continue
    draft.update(name, (agent) => {
      agent.description = definition.description
      agent.mode = definition.mode
      agent.system = definition.prompt
      agent.model = modelRef(definition.model)
      agent.permissions.push(...toV2Ruleset(definition))
    })
  }
}

const setup: PluginV2["setup"] = async (context: PluginContext) => {
  await context.agent.transform(upsertAgents)
}

export default {
  id: "opencode-orchestrator",
  server,
  setup,
} satisfies PluginModule & PluginV2
