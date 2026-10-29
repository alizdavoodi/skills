---
name: pstack-omp-host-translation
description: "Reference for pstack-omp. Maps Cursor host mechanisms in upstream pstack text to their OMP replacement, so a sync can tell a translated directive from an untranslated one."
---

# Host translation ledger

Upstream pstack is written for Cursor. This port runs on OMP. Every place upstream names a Cursor path, field, tool, product surface, or model slug has a replacement here, and this file records what replaced it.

Read it before auditing a sync. A three-way merge carries new upstream lines verbatim, so a new skill arrives with Cursor text intact. A translated paragraph can also come back untranslated when upstream edits the same passage, because the merge resolves both sides and keeps upstream's wording for any line the port did not change.

This skill is port-only. `scripts/sync-upstream.mjs` skips every skill in `PORT_ONLY`, so a sync never rewrites this file.

## Four translation shapes

Each substitution is one of these. Name the shape when you audit, because the shapes fail differently.

**Rename.** OMP has the same capability under a different name. The smallest risk, since the sentence keeps its meaning and only the noun changes.

**Retarget.** OMP has the capability, but through a different mechanism or field. The sentence has to change shape, not just vocabulary.

**Substitute.** No direct equal. The upstream step names one mechanism, and the port names the OMP mechanism that accomplishes the same job. The wording moves furthest here, so these are the rows most worth re-reading after a sync.

**Gap.** No equal at all. The ported text says so in one line rather than inventing a substitute. Search for these when a reader reports a missing capability.

## Paths and install

| Upstream | OMP | Shape |
|---|---|---|
| `.cursor/skills/<name>/` | `.omp/skills/<name>/` in the project | Rename |
| `~/.cursor/skills/<name>/` | `~/.omp/agent/skills/<name>/` | Rename |
| `.cursor/skills/<handle>/<handle>-mode/` | `.omp/skills/<handle>-mode/` | Retarget. OMP discovers skills one level under `skills/` only, so a nested category directory never loads. |
| `plugins/cache/`, `~/.cursor/plugins/` | the source directory under `skills.customDirectories` | Retarget. Edit the source, never a cache. |
| `/add-plugin pstack`, Customize sidebar, `/plugin marketplace` | install from the repository, set `skills.customDirectories`, restart OMP | Substitute |
| `.cursor/skills/verify-<app>/` | `.omp/skills/verify-<app>/` | Rename |

## Transcripts and history

| Upstream | OMP | Shape |
|---|---|---|
| `agent-transcripts/` from the system prompt | `history://<id>`, or `archive.sessions()` in the `eval` tool | Substitute. `xd://eval/archive` is the doc. |
| `~/.cursor/projects/<slug>/agent-transcripts/` glob | leave `project` at its default. Never pass `"*"`. | Retarget. Both cross a boundary that reads private sessions from unrelated work. |
| a cloud-agent URL | `agent://<id>` | Rename |
| pinned chats in the sidebar | the root's recorded `agent://<id>` sessions | Substitute |

## Models

| Upstream | OMP | Shape |
|---|---|---|
| `~/.cursor/rules/pstack-models.mdc` | `modelRoles` and `task.agentModelOverrides` in `~/.omp/agent/config.yml`, written by `/skill:setup-pstack` | Retarget |
| `model: <slug>` on a task | no model field exists. The agent's configured role decides. | Retarget |
| `claude-opus-5-5-xhigh`, `grok-4.7-xhigh-fast` defaults | resolved from config. No slug appears in port prose. | Retarget |
| `inherit-parent`, `auto` | the role is left unset, so it runs on the session model | Rename |
| a per-role reasoning budget in the `.mdc` rule | `/skill:setup-pstack` writes an effort suffix per tier | Retarget |

## Task spawn fields

| Upstream | OMP | Shape |
|---|---|---|
| `Task` with `subagent_type: generalPurpose` | one `task` call, `tasks[]`, each item carrying `agent` | Retarget |
| `subagent_type: "poteto-agent"` | `agent: "poteto-agent"` | Rename |
| `subagent_type: "comment-sicko"` | `agent: "comment-sicko"` | Rename |
| `readonly: true` | read-only by brief. Use `scout`, or a brief that forbids edits. | Substitute |
| `readonly: false`, "agent mode" | a `task` or `reviewer` item that keeps its MCP tools, with the brief forbidding writes | Substitute |
| `run_in_background: true` | omit. Spawns are background jobs by default. | Gap, in the sense that the field has no equal |
| `environment: "cloud"` | its own worktree or branch, plus `isolated` when `task.isolation.enabled` exposes it | Substitute |
| `environment: "local"` | omit | Gap |
| `cloud_base_branch` | name the branch and its base SHA in the brief | Substitute |
| `resume` | `write agent://<id>` for a coupled next phase, or a fresh agent with the earlier result pasted | Substitute |
| `file_attachments` | list the paths in the brief | Rename |
| a built-in planning or designer subagent | `task`, with the specialization in the brief | Substitute. Recorded in `skill://pstack-omp`. |

## Tools and product surfaces

| Upstream | OMP | Shape |
|---|---|---|
| `create-skill` | the authoring-a-skill playbook, plus `omp://skills.md` for the format | Substitute. Appears in `automate-me`, `poteto-mode`, `authoring-a-skill`, `reflect`, and the reflect lenses. |
| `/deslop` from `cursor-team-kit` | `skill://fable-deslop` when `rpce-cli` is configured, otherwise skip with a one-line note | Substitute |
| `control-cli` for CLIs and TUIs | `bash` with named services, `pty`, and `proc://` | Substitute |
| `control-ui` for browser and Electron | the `eval` tool's `browser` object | Substitute |
| `AskQuestion` | the `ask` tool | Rename |
| `/loop` | OMP's `/loop`, given `--until` or `--while` with a check that can pass or fail | Retarget |
| Cursor Plan Mode | OMP plan mode | Rename |
| a Cursor cloud VM per live lane | one worktree per lane at the PR head | Substitute |
| `https://api2.cursor.sh/automations/webhook/<id>` | name the JSON fields the UI sends and the handler prompt | Substitute |
| Custom Modes | no OMP equal. Say so in one line. | Gap |
| an unreleased Cursor feature, such as Bugbot automations | name it as upstream's, then name the OMP path or say there is none | Gap |

## Where the translations live

Forty-one mirrored files carry at least one. The ones with the most, and therefore the ones to read first after a sync:

| File | Translated lines |
|---|---|
| `skills/setup-pstack/SKILL.md` | 26 |
| `skills/reflect/SKILL.md` | 11 |
| `skills/poteto-help/SKILL.md` | 11 |
| `skills/automate-me/SKILL.md` | 11 |
| `skills/poteto-mode/SKILL.md` | 9 |
| `skills/poteto-mode/playbooks/multi-phase-plan.md` | 5 |
| `skills/why/SKILL.md`, `skills/interrogate/SKILL.md` | 4 each |
| `skills/arena/SKILL.md`, `skills/swarm/SKILL.md`, `skills/create-verification-skill/SKILL.md`, `skills/architect/SKILL.md`, `skills/how/SKILL.md` | 1 to 3 each |
| The rest of `skills/poteto-mode/playbooks/`, `skills/reflect/references/`, and `agents/poteto-agent.md` | 1 to 2 each |

## Auditing a sync

The sync prints a `host` line for any file it would write whose merged text introduces a host token the port file did not already contain. That line is a pointer, not a verdict. It cannot tell a legitimate mention from an untranslated directive, because `poteto-help` and the Bugbot triage deliberately name Cursor and Bugbot while explaining the port.

For each file it names:

1. Read the merged text, not the incoming diff. A clean merge produces no conflict line, so the summary will not point at it.
2. Decide the shape. A rename needs a noun swap. A retarget needs the sentence rebuilt around an OMP field. A substitute needs the OMP mechanism named, and the upstream mechanism usually stays as context.
3. If there is no equal, say so. Do not invent a substitute, and do not drop the paragraph. A reader who hits a missing capability should find one line explaining why.

Two files in the 0.15.28 to 0.15.32 range needed this. `reflect` had a `plugins/cache/` instruction that became "edit the source directory directly under `skills.customDirectories`". `swarm` had `subagent_type`, `environment: "cloud"`, and `run_in_background` in one sentence, which became a `task` batch with `agent` per item and a worktree per worker.
