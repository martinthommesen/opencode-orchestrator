import { describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import type { AgentDraft, PluginContext } from "@opencode-ai/plugin/v2/promise"
import OrchestratorPlugin, { resolveAgents } from "../src/index.ts"
import type { AgentDefinition, PermissionRule } from "../src/index.ts"

// Model resolution consults this machine's provider auth; pin both providers
// as available so the seam tests are hermetic and assert the primary models.
process.env["ANTHROPIC_API_KEY"] ??= "contract-test"
process.env["OPENAI_API_KEY"] ??= "contract-test"

const PRIMARIES = ["orchestrator", "orchestrator-plan"] as const
const WORKERS = ["explorer", "implementer", "designer", "reviewer"] as const
const INJECTED_AGENTS = [...PRIMARIES, ...WORKERS] as const

async function inject(config: Config = {}): Promise<Config> {
  const hooks = await OrchestratorPlugin.server({} as PluginInput)
  if (!hooks.config) throw new Error("plugin must provide a config hook")
  await hooks.config(config)
  return config
}

function agentsOf(config: Config): Record<string, AgentDefinition> {
  return (config.agent ?? {}) as Record<string, AgentDefinition>
}

const READ_GATES = {
  "*": "allow",
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow",
} as const

const READS = {
  read: READ_GATES,
  grep: "allow",
  glob: "allow",
  list: "allow",
  external_directory: "ask",
} as const

describe("plugin module", () => {
  test("exposes a v1 plugin module with an id for file-based loading", () => {
    expect(OrchestratorPlugin.id).toBe("opencode-orchestrator")
    expect(typeof OrchestratorPlugin.server).toBe("function")
  })

  test("exposes a v2 setup on the same default export for the Desktop server", () => {
    expect(typeof OrchestratorPlugin.setup).toBe("function")
  })
})

describe("injected agents", () => {
  test("injects exactly the six agent entries into an empty config", async () => {
    const config = await inject()
    expect(Object.keys(agentsOf(config)).sort()).toEqual([...INJECTED_AGENTS].sort())
  })

  test("primaries run claude-fable-5 at high effort as opt-in primary agents", async () => {
    const agents = agentsOf(await inject())
    for (const name of PRIMARIES) {
      expect(agents[name]?.mode).toBe("primary")
      expect(agents[name]?.model).toBe("anthropic/claude-fable-5")
      expect(agents[name]?.variant).toBe("high")
    }
  })

  test("Workers are subagents pinned to their models at high effort", async () => {
    const agents = agentsOf(await inject())
    const models: Record<(typeof WORKERS)[number], string> = {
      explorer: "openai/gpt-5.5",
      implementer: "openai/gpt-5.5",
      designer: "anthropic/claude-opus-4-8",
      reviewer: "anthropic/claude-opus-4-8",
    }
    for (const name of WORKERS) {
      expect(agents[name]?.mode).toBe("subagent")
      expect(agents[name]?.model).toBe(models[name])
      expect(agents[name]?.variant).toBe("high")
    }
  })

  test("every agent ships a description and a prompt, never sets temperature, and stays @-mentionable", async () => {
    const agents = agentsOf(await inject())
    for (const name of INJECTED_AGENTS) {
      const agent = agents[name]
      expect(agent?.description?.length).toBeGreaterThan(0)
      expect(agent?.prompt?.length).toBeGreaterThan(0)
      expect(agent).not.toHaveProperty("temperature")
      expect(agent).not.toHaveProperty("hidden")
    }
  })
})

describe("orchestrator lockdown", () => {
  test("the Orchestrator is stripped to Spot-check reads, todos, questions, and its Swarm", async () => {
    const agents = agentsOf(await inject())
    expect(agents["orchestrator"]?.permission).toEqual({
      "*": "deny",
      ...READS,
      todowrite: "allow",
      question: "allow",
      task: {
        "*": "deny",
        explorer: "allow",
        implementer: "allow",
        designer: "allow",
        reviewer: "allow",
      },
    })
  })

  test("the Plan Orchestrator's task fence admits only the read-only Workers", async () => {
    const agents = agentsOf(await inject())
    const { task: planFence, ...planRest } = agents["orchestrator-plan"]?.permission ?? {}
    const { task: fullFence, ...fullRest } = agents["orchestrator"]?.permission ?? {}
    expect(planFence).toEqual({ "*": "deny", explorer: "allow", reviewer: "allow" })
    expect(planRest).toEqual(fullRest)
    expect(fullFence).not.toEqual(planFence)
  })

  test("the Plan Orchestrator carries the full Orchestrator prompt plus a mode preamble", async () => {
    const agents = agentsOf(await inject())
    const base = agents["orchestrator"]?.prompt ?? ""
    const plan = agents["orchestrator-plan"]?.prompt ?? ""
    expect(plan).toContain(base)
    expect(plan.length).toBeGreaterThan(base.length)
  })
})

describe("worker permission matrix", () => {
  test("the Explorer is mechanically read-only plus webfetch", async () => {
    const agents = agentsOf(await inject())
    expect(agents["explorer"]?.permission).toEqual({
      "*": "deny",
      ...READS,
      webfetch: "allow",
    })
  })

  test("the Reviewer is mechanically read-only with no webfetch and no bash", async () => {
    const agents = agentsOf(await inject())
    expect(agents["reviewer"]?.permission).toEqual({
      "*": "deny",
      ...READS,
    })
  })

  test("the Implementer and Designer keep their full toolset but can never spawn Workers", async () => {
    const agents = agentsOf(await inject())
    for (const name of ["implementer", "designer"] as const) {
      expect(agents[name]?.permission).toEqual({ task: { "*": "deny" } })
    }
  })
})

describe("model fallback chains", () => {
  const PRIMARY: Record<string, string> = {
    orchestrator: "anthropic/claude-fable-5",
    "orchestrator-plan": "anthropic/claude-fable-5",
    explorer: "openai/gpt-5.5",
    implementer: "openai/gpt-5.5",
    designer: "anthropic/claude-opus-4-8",
    reviewer: "anthropic/claude-opus-4-8",
  }

  test("with the direct providers available every agent runs its primary model", () => {
    const agents = resolveAgents(new Set(["anthropic", "openai", "github-copilot"]))
    for (const [name, model] of Object.entries(PRIMARY)) expect(agents[name]?.model).toBe(model)
  })

  test("fallbacks route through the Copilot subscription, never API-key billing", () => {
    const agents = resolveAgents(new Set(["github-copilot"]))
    for (const name of ["orchestrator", "orchestrator-plan", "explorer", "implementer"]) {
      expect(agents[name]?.model).toBe("github-copilot/gpt-5.5")
    }
    for (const name of ["designer", "reviewer"]) {
      expect(agents[name]?.model).toBe("github-copilot/claude-opus-4.8")
    }
  })

  test("a missing provider never reroutes to another direct API provider", () => {
    const agents = resolveAgents(new Set(["anthropic"]))
    expect(agents["orchestrator"]?.model).toBe("anthropic/claude-fable-5")
    // openai and github-copilot both unavailable: keep the primary rather
    // than crossing to a different direct provider.
    expect(agents["explorer"]?.model).toBe("openai/gpt-5.5")
  })

  test("with no provider available the primary model is kept for a clear runtime error", () => {
    const agents = resolveAgents(new Set())
    for (const [name, model] of Object.entries(PRIMARY)) expect(agents[name]?.model).toBe(model)
  })
})

describe("merge safety", () => {
  test("never overwrites a pre-existing user agent of the same name", async () => {
    const userOrchestrator = { model: "user/model", mode: "all" as const, prompt: "mine" }
    const config: Config = { agent: { orchestrator: { ...userOrchestrator } } }
    await inject(config)
    expect(config.agent?.["orchestrator"]).toEqual(userOrchestrator)
    expect(Object.keys(agentsOf(config)).sort()).toEqual([...INJECTED_AGENTS].sort())
  })

  test("preserves unrelated agents and unrelated config keys", async () => {
    const config: Config = {
      model: "user/default-model",
      theme: "user-theme",
      agent: { mine: { description: "user agent", mode: "subagent" } },
    }
    await inject(config)
    expect(config.model).toBe("user/default-model")
    expect(config.theme).toBe("user-theme")
    expect(config.agent?.["mine"]).toEqual({ description: "user agent", mode: "subagent" })
    expect(Object.keys(agentsOf(config)).sort()).toEqual([...INJECTED_AGENTS, "mine"].sort())
  })
})

// --- v2 (Desktop server) seam -------------------------------------------

type V2Agent = {
  id: string
  model?: { providerID: string; id: string; variant?: string }
  request: { headers: Record<string, string>; body: Record<string, unknown> }
  system?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  permissions: PermissionRule[]
}

function emptyV2Agent(id: string): V2Agent {
  return { id, request: { headers: {}, body: {} }, mode: "all", hidden: false, permissions: [] }
}

/** Runs the plugin's v2 setup against a Map-backed AgentDraft stand-in. */
async function injectV2(initial: V2Agent[] = []): Promise<Map<string, V2Agent>> {
  const agents = new Map(initial.map((agent) => [agent.id, agent]))
  const draft: AgentDraft = {
    list: () => [...agents.values()] as never,
    get: (id) => agents.get(id) as never,
    default: () => {},
    update: (id, fn) => {
      const current = agents.get(id) ?? emptyV2Agent(id)
      agents.set(id, current)
      fn(current as never)
      current.id = id
    },
    remove: (id) => void agents.delete(id),
  }
  const transforms: Array<(draft: AgentDraft) => Promise<void> | void> = []
  const context = {
    options: {},
    agent: {
      transform: async (callback: (draft: AgentDraft) => Promise<void> | void) => {
        transforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
  } as unknown as PluginContext
  await OrchestratorPlugin.setup(context)
  for (const transform of transforms) await transform(draft)
  return agents
}

/** Spot-check reads with the platform's .env gates and external_directory default intact. */
const V2_READS: PermissionRule[] = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
]

const V2_FULL_TOOLSET: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "task", resource: "*", effect: "deny" },
]

describe("v2 injected agents", () => {
  test("upserts exactly the six agent entries with models, modes, and prompts", async () => {
    const agents = await injectV2()
    expect([...agents.keys()].sort()).toEqual([...INJECTED_AGENTS].sort())
    for (const name of PRIMARIES) {
      expect(agents.get(name)?.mode).toBe("primary")
      expect(agents.get(name)?.model).toEqual({ providerID: "anthropic", id: "claude-fable-5", variant: "high" })
    }
    const models: Record<(typeof WORKERS)[number], { providerID: string; id: string }> = {
      explorer: { providerID: "openai", id: "gpt-5.5" },
      implementer: { providerID: "openai", id: "gpt-5.5" },
      designer: { providerID: "anthropic", id: "claude-opus-4-8" },
      reviewer: { providerID: "anthropic", id: "claude-opus-4-8" },
    }
    for (const name of WORKERS) {
      expect(agents.get(name)?.mode).toBe("subagent")
      expect(agents.get(name)?.model).toEqual({ ...models[name], variant: "high" })
    }
    for (const name of INJECTED_AGENTS) {
      expect(agents.get(name)?.system?.length).toBeGreaterThan(0)
      expect(agents.get(name)?.description?.length).toBeGreaterThan(0)
      expect(agents.get(name)?.hidden).toBe(false)
    }
  })

  test("the Orchestrator ruleset is a blanket deny with Spot-check, todo, question, and Swarm allows", async () => {
    const agents = await injectV2()
    expect(agents.get("orchestrator")?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      ...V2_READS,
      { action: "todowrite", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "task", resource: "*", effect: "deny" },
      { action: "task", resource: "explorer", effect: "allow" },
      { action: "task", resource: "implementer", effect: "allow" },
      { action: "task", resource: "designer", effect: "allow" },
      { action: "task", resource: "reviewer", effect: "allow" },
    ])
  })

  test("the Plan Orchestrator's task fence admits only the read-only Workers", async () => {
    const agents = await injectV2()
    const taskRules = agents.get("orchestrator-plan")?.permissions.filter((rule) => rule.action === "task")
    expect(taskRules).toEqual([
      { action: "task", resource: "*", effect: "deny" },
      { action: "task", resource: "explorer", effect: "allow" },
      { action: "task", resource: "reviewer", effect: "allow" },
    ])
  })

  test("the Explorer and Reviewer are mechanically read-only", async () => {
    const agents = await injectV2()
    expect(agents.get("explorer")?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      ...V2_READS,
      { action: "webfetch", resource: "*", effect: "allow" },
    ])
    expect(agents.get("reviewer")?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      ...V2_READS,
    ])
  })

  test("the Implementer and Designer carry the full-toolset baseline with a task fence", async () => {
    const agents = await injectV2()
    for (const name of ["implementer", "designer"] as const) {
      expect(agents.get(name)?.permissions).toEqual(V2_FULL_TOOLSET)
    }
  })

  test("never overwrites an agent that already exists in the draft", async () => {
    const existing = { ...emptyV2Agent("orchestrator"), description: "user agent", mode: "primary" as const }
    const snapshot = structuredClone(existing)
    const agents = await injectV2([existing])
    expect(agents.get("orchestrator")).toEqual(snapshot)
    expect([...agents.keys()].sort()).toEqual([...INJECTED_AGENTS].sort())
  })
})
