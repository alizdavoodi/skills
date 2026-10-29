---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Adversaries try to break a change or design, and only findings proven by a run survive."
disable-model-invocation: true
---

# Interrogate

Adversaries try to break a change or a design. Spawn one adversary per configured seat, and the adversarial signal comes from model diversity, not assigned personas. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill (`skill://in-your-own-words`), from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Fan out

Run Phase A steps 3 and 4 and Phase B of the **arena** skill (`skill://arena`), with four changes. Read the seat table below in place of arena's default seats, labeled Reviewer A, B, and so on. Copy the scope's uncommitted changes into each worktree. Each adversary runs as an item that keeps its tools, because it must run a repro, with a brief that forbids edits and commits. In place of the arena task and rationale, give each adversary the scope, the intent, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

Package the diff or file contents with any surrounding context files the adversaries need to understand the code. When the package is large, write it to `local://interrogate-<slug>.md` with the base and head SHAs at the top. Freeze that package before any adversary starts. Do not change it while they run.

| Seat | Agent |
|------|-------|
| Reviewer A | `reviewer` |
| Reviewer B | `task` |

Reviewer B runs as `task` under a brief that forbids edits, so it stays read-only by its brief. A task item never names a model. Each agent's model comes from `task.agentModelOverrides` and `modelRoles` in `~/.omp/agent/config.yml`, which `/skill:setup-pstack` (`skill://setup-pstack`) writes. The diversity this skill relies on exists only when the operator has configured distinct overrides for the seat agents. Add further seats from `security-reviewer` and `poteto-agent` when the operator configured overrides for them, within `task.maxConcurrency` (32 by default). Adversaries are leaves. They never call `task`, which keeps the panel inside `task.maxRecursionDepth` (2).

`context` holds the stated intent, the SHAs, and the path to the frozen package. Set `solutionSpace` to say that the scope and the intent are given and what is wrong, if anything, is open, and never mention the other adversaries in it. Set each item's `effort` for the job only when the `task` schema shows an `effort` field (`task.enableEffort`). Otherwise omit it.

Claim that adversaries ran on different models only from the resolved-model metadata OMP returns with each result. If the metadata shows two seats on one model, or does not report a model, say so in the output and treat their agreement as repeated sampling, not independent confirmation.

Skip arena Phases C, D, and E. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Verify

Verify each finding per arena Phase F by rerunning its command. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.
