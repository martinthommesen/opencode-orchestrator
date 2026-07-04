# opencode-orchestrator

An opencode plugin that ships an Orchestrator agent and the Swarm of Workers it directs. The Orchestrator plans and delegates; Workers execute.

## Language

**Orchestrator**:
The primary agent (claude-fable-5) that decomposes work, briefs Workers, and integrates their results. It never edits files or executes commands itself.
_Avoid_: manager, coordinator, main agent

**Plan Orchestrator**:
The Orchestrator behind a Swarm fence that admits only read-only Workers (Explorer, Reviewer), so nothing it spawns can mutate the working tree.
_Avoid_: plan mode, planner

**Worker**:
A subagent defined by a single role and pinned to a specific model. A Worker does exactly its role, nothing else.
_Avoid_: helper, sub-agent (generic), swarm agent

**Swarm**:
The fixed set of Workers the Orchestrator is permitted to spawn.
_Avoid_: roster, crew, team

**Spot-check**:
A small, targeted read the Orchestrator performs to verify a Worker's claim. Distinct from exploration, which always belongs to the Explorer.
_Avoid_: audit, inspection

**Brief**:
The self-contained task prompt the Orchestrator writes for a single Worker invocation, carrying all context and evidence the Worker is allowed to rely on.
_Avoid_: task description, prompt (generic)

**Verdict**:
The Reviewer's judgment on a plan or diff: accept or revise, with concrete findings. Every non-trivial diff needs a Verdict before the Orchestrator accepts it; trivial diffs may be accepted on a Spot-check.
_Avoid_: approval, sign-off

### Workers

**Explorer**:
The read-only Worker (gpt-5.5) for codebase and docs reconnaissance; answers questions and maps territory.
_Avoid_: scout, researcher

**Implementer**:
The Worker (gpt-5.5) that writes code to a tight brief — features, refactors, migrations, tests — for everything except User-facing surfaces.
_Avoid_: coder, developer, tester

**Designer**:
The Worker (opus-4.8) that owns User-facing surfaces end to end: it proposes and implements UI, UX, copy, and visual polish, and produces taste-sensitive proposals (API shapes, architecture options).
_Avoid_: architect, ui-implementer

**User-facing surface**:
Anything an end user sees or touches — UI, UX flows, visual styling, copy, public API shape. Work on a User-facing surface always routes to the Designer, never the Implementer.
_Avoid_: frontend (broader than UI code)

**Reviewer**:
The read-only Worker (opus-4.8) that judges plans and diffs, returning a verdict with concrete findings.
_Avoid_: critic, checker
