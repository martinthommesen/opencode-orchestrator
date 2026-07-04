import { describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import OrchestratorPlugin from "../src/index.ts"
import type { AgentDefinition } from "../src/index.ts"

const PRIMARIES = ["orchestrator", "orchestrator-plan"] as const
const WORKERS = ["explorer", "implementer", "designer", "reviewer"] as const
const SWARM = [...PRIMARIES, ...WORKERS] as const

async function inject(config: Config = {}): Promise<Config> {
  const hooks = await OrchestratorPlugin.server({} as PluginInput)
  if (!hooks.config) throw new Error("plugin must provide a config hook")
  await hooks.config(config)
  return config
}

function agentsOf(config: Config): Record<string, AgentDefinition> {
  return (config.agent ?? {}) as Record<string, AgentDefinition>
}

const READS = {
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
} as const

describe("plugin module", () => {
  test("exposes a v1 plugin module with an id for file-based loading", () => {
    expect(OrchestratorPlugin.id).toBe("opencode-orchestrator")
    expect(typeof OrchestratorPlugin.server).toBe("function")
  })
})

describe("roster", () => {
  test("injects exactly the six swarm agents into an empty config", async () => {
    const config = await inject()
    expect(Object.keys(agentsOf(config)).sort()).toEqual([...SWARM].sort())
  })

  test("primaries run claude-fable-5 at high effort as opt-in primary agents", async () => {
    const agents = agentsOf(await inject())
    for (const name of PRIMARIES) {
      expect(agents[name]?.mode).toBe("primary")
      expect(agents[name]?.model).toBe("anthropic/claude-fable-5")
      expect(agents[name]?.variant).toBe("high")
    }
  })

  test("workers are subagents pinned to their models at high effort", async () => {
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
    for (const name of SWARM) {
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

  test("the Plan Orchestrator carries the full Orchestrator prompt plus a plan-mode preamble", async () => {
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

  test("the Implementer and Designer keep their full toolset but can never spawn subagents", async () => {
    const agents = agentsOf(await inject())
    for (const name of ["implementer", "designer"] as const) {
      expect(agents[name]?.permission).toEqual({ task: { "*": "deny" } })
    }
  })
})

describe("merge safety", () => {
  test("never overwrites a pre-existing user agent of the same name", async () => {
    const userOrchestrator = { model: "user/model", mode: "all" as const, prompt: "mine" }
    const config: Config = { agent: { orchestrator: { ...userOrchestrator } } }
    await inject(config)
    expect(config.agent?.["orchestrator"]).toEqual(userOrchestrator)
    expect(Object.keys(agentsOf(config)).sort()).toEqual([...SWARM].sort())
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
    expect(Object.keys(agentsOf(config)).sort()).toEqual([...SWARM, "mine"].sort())
  })
})
