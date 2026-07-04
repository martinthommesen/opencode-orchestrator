import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"
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

const FABLE = "anthropic/claude-fable-5"
const OPUS = "anthropic/claude-opus-4-8"
const GPT = "openai/gpt-5.5"

/** Spot-check reads: the only filesystem access the Orchestrator keeps. */
const READS = {
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
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

const AGENTS: Record<string, AgentDefinition> = {
  orchestrator: {
    description:
      "Directs the Swarm: decomposes work into Briefs, routes them to Workers, verifies claims by Spot-check, and gates acceptance behind Reviewer Verdicts. Never edits files or runs commands itself.",
    mode: "primary",
    model: FABLE,
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
    model: FABLE,
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
    model: GPT,
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
    model: GPT,
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
    model: OPUS,
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
    model: OPUS,
    variant: "high",
    prompt: REVIEWER_PROMPT,
    permission: {
      "*": "deny",
      ...READS,
    },
  },
}

type SdkAgentConfig = NonNullable<Config["agent"]>[string]

const server: Plugin = async () => ({
  config: async (config) => {
    const agents = (config.agent ??= {})
    for (const [name, definition] of Object.entries(AGENTS)) {
      // Never overwrite an agent the user already defined under the same name.
      // Widening cast: see the AgentDefinition doc comment.
      agents[name] ??= definition as unknown as SdkAgentConfig
    }
  },
})

export default {
  id: "opencode-orchestrator",
  server,
} satisfies PluginModule
