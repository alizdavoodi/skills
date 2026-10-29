---
name: fable-deslop
description: "Deletion-first patch minimization. Scope the patch with the open-code-review delegate, freeze one bundle, review it with two independent task lanes, then adjudicate every finding against repository and upstream evidence. Use for /skill:fable-deslop, shrinking an oversized PR, or a deletion-first review before implementation."
disable-model-invocation: true
---

# Fable deslop

Turn a large patch into the smallest coherent root-cause change. The `ocr` delegate decides what is in scope
and which rules apply; two `task` items review the same frozen bundle independently. You adjudicate; the lanes
advise.

## Brown-field rule

Correctness is necessary but does not excuse over-editing. Compare the patch with the pre-change code, not an imagined ideal implementation. Preserve existing logic, control flow, names, validation, comments, and formatting unless the requested behavior requires changing them. Deletion and simplification are not wins by themselves. Unnecessary simplification is structural divergence too.

Source: [Coding Models Are Doing Too Much](https://nrehiew.github.io/blog/minimal_editing/)

## Transport

OCR is deterministic and LLM-free in this mode: it selects files and resolves rules. The review itself runs on
the two lanes, so no Oracle endpoint, RepoPrompt window, or `rpce-cli` is involved.

```bash
ocr --version                                   # 1.9.0 or newer for --format json
ocr delegate preview --format json [--from <ref> --to <ref> | -c <hash>] [--exclude <patterns>]
ocr delegate rule --format json <path>...
```

`ocr delegate` reads the Git repository at the current directory; pass `--repo <path>` to override. Every
`git` call during the review uses `--no-pager --no-ext-diff --no-textconv --no-color`.

If `ocr` is missing, stop and report it with the install command
(`npm install -g @alibaba-group/open-code-review`). Do not substitute an ad-hoc file guess; the scope is what
makes the two lanes comparable.

## Process

### 1. Pin the review

Read repository instructions, `git status`, the exact diff, and the originating issue, PR, or investigation. Record:

- Repository and worktree
- Base and head refs, or the exact uncommitted comparison scope
- Observable user impact
- Invariant the patch must preserve, stated as observable behavior
- Smallest plausible causal edit, naming the smallest code region expected to change
- Changed files and added/deleted line counts

Every changed file must belong to the pinned diff. Ask before reviewing when the comparison scope is not determinable from the request and repository state.

### 2. Retrieve authority

Trace the changed execution path, owners, callers, existing helpers, tests, and the validation command. Use current upstream documentation and source when the patch integrates an external CLI, API, or protocol. Exercise an installed CLI when the user authorizes it and the result can distinguish competing designs.

Separate confirmed behavior, plausible mechanism, unproven compatibility, and unknowns. Every compatibility or security claim used to keep code needs a repository, upstream-source, documentation, or live-test basis.

### 3. Scope with the delegate

```bash
ocr delegate preview --format json --from <base> --to <head> -b "<requirement or issue summary>"
```

Pass `--background` only with requirement context the diff cannot show, and keep it under the CLI's limits
rather than truncating the source. Read `mode`, `merge_base`, `reviewable_files`, and `excluded_files`. Report
every previewed file; a file that leaves the review is named with its exclusion reason, never silently dropped.

Then resolve the checklist once for all reviewable paths, in batches when the list is long:

```bash
ocr delegate rule --format json <path>...
```

Rules are grouped by content, so one call covers every file that shares a rule.

### 4. Freeze the bundle

One directory, one generation, one hash. Everything the lanes read lives here:

```bash
BUNDLE=<repo>/tmp/fable-deslop/$(date +%Y%m%d-%H%M%S)
mkdir -p "$BUNDLE"
ocr delegate preview --format json <mode flags> -b "<requirement>" > "$BUNDLE/preview.json"
jq -r '.reviewable_files[].path' "$BUNDLE/preview.json" > "$BUNDLE/paths.txt"
jq -r '.reviewable_files[].path' "$BUNDLE/preview.json" | tr '\n' '\0' | xargs -0 ocr delegate rule --format json > "$BUNDLE/rules.json"
```

`ocr delegate rule` takes paths as arguments, and the preview is the only source for them; never retype a path
by hand. `xargs -0` passes them one argument each, so spaces and quotes survive.

Build one patch file with a command that matches the preview's `mode`, writing to `$BUNDLE/patch.diff`.
`jq -r … | tr '\n' '\0' | xargs -0` keeps paths with spaces intact; `--pathspec-from-file` is not in every
git build.

- **range** — `jq -r '.reviewable_files[].path' "$BUNDLE/preview.json" | tr '\n' '\0' | xargs -0 git --no-pager diff --no-ext-diff --no-textconv --no-color <merge_base>..<to> --`
- **commit** — `jq -r '.reviewable_files[].path' "$BUNDLE/preview.json" | tr '\n' '\0' | xargs -0 git --no-pager show --diff-merges=first-parent --no-ext-diff --no-textconv --no-color <commit> --`
- **workspace** — `jq -r '.reviewable_files[].path' "$BUNDLE/preview.json" | tr '\n' '\0' | xargs -0 git --no-pager diff --no-ext-diff --no-textconv --no-color HEAD --`

`--diff-merges=first-parent` is not optional. OCR builds its preview the same way; plain `git show` on a
merge commit prints a combined diff that omits every change the merge brought in, so the lanes would review
an empty patch against a preview that lists those files. The flag is a no-op on an ordinary commit.

A new untracked file has no diff against `HEAD`; append each one, because the whole file is new code:

```bash
git --no-pager diff --no-index --no-color --src-prefix=a/ --dst-prefix=b/ -- /dev/null "<path>" >> "$BUNDLE/patch.diff"
```

`git diff --no-index` exits 1 when the files differ. That is success here; only a higher code is a failure.

Write `$BUNDLE/meta.md` with the pinned facts, the invariant, the authority gathered, the disproved shortcuts,
and any named suggestions labeled as hypotheses. Then hash the generation:

```bash
shasum -a 256 "$BUNDLE"/{patch.diff,preview.json,rules.json,meta.md}   # sha256sum on Linux
```

Compare `patch.diff` against the preview counts before sending. An empty patch with a non-empty
`reviewable_count` means the wrong mode or refs, not a clean change. Freeze here: no commit, rebase, or file
edit under review until both lanes answer.

Sending this bundle to a lane forwards it to that lane's provider. Explicit invocation of this skill authorizes
that transmission. Otherwise ask first.

### 5. Review with both lanes

Send the shared request from `skill://fable-deslop/references/review-prompt.md` once, as one `task` batch: two
items, the same filled prompt, different `agent`. The item `agent` is what selects the model; a task item has no
model field.

```json
{
  "context": "Frozen fable-deslop bundle: <repo>, <scope>, bundle at <path>, sha256 <hash>. Read-only review; no edits, no child agents.",
  "tasks": [
    { "name": "DeslopLaneAuditor", "agent": "deslop-auditor", "task": "<shared prompt + header>", "solutionSpace": "deletion-first review; findings open, no known defect" },
    { "name": "DeslopLaneIndependent", "agent": "deslop-reviewer", "task": "<identical shared prompt + header>", "solutionSpace": "deletion-first review; findings open, no known defect" }
  ]
}
```

- `deslop-auditor` runs the `advisor` role; `deslop-reviewer` runs the `deslop` role. `skill://setup-pstack`
  writes both, and keeps `deslop` on a different model family from `advisor` when the catalog has one.
- Both items name a deslop agent on purpose. OMP's bundled `reviewer` reports only unintentional defects and
  skips non-blocking changes, which is the opposite of a deletion-first review; routing the advisor-model lane
  through it would make the lane ignore correct-but-unnecessary code. Its model would change; its contract
  would not.
- If either deslop agent is absent from the live `task` inventory, it was never installed. Install both from
  `<repo>/agents/` and re-dispatch. Running the missing lane as `reviewer` is not a substitute; say the panel
  collapsed to one lane instead of presenting a weaker review as agreement.
- Confirm independence from the returned `resolvedModel` on each result, not from the role names. If both lanes
  report the same model, say "one review" in the report; do not present a single opinion as agreement.
- `task.enableEffort` is off by default, so effort comes from the role selector. Put `effort` in an item only
  when the live schema exposes it; never hand-tune a model per call.
- Do not feed one lane's review to another, and do not re-dispatch one lane after reading the other. A follow-up
  to a lane answers that lane only.
- Read each result from `agent://<id>` and the transcript from `history://<id>` when a report is truncated or
  ambiguous. A failed or empty lane is not a review: retry once when safe, then continue with the lane that
  completed and report the missing comparison.

### 6. Adjudicate

Build a finding ledger with one column per lane and one adjudicated column. Check every finding and disagreement against the exact source, predecessor behavior, repository conventions, the current upstream contract, and live evidence. Reinspect any changed transformation or failure boundary that only one lane noticed: agreement is not proof, and omission is not disproof. A shorter final file is not necessarily a smaller edit. Prefer the patch with the least structural divergence from the base that still fixes the root cause.

Reject a recommendation that would:

- Remove the root-cause mechanism
- Rewrite established code when reverting an unrelated hunk is enough
- Weaken trusted launch, state safety, cancellation, cleanup, or fail-closed behavior
- Replace local code with an unverified upstream shortcut
- Introduce a broader abstraction to save local lines
- Delete regression coverage without another test exercising the same boundary

Look for reductions every lane missed, especially data represented twice, a list joined immediately into one argument, copied error normalization, and tests for invented compatibility. A rule from `rules.json` that fires on unchanged code is pre-existing: keep it out of the deletion list and say so.

### 7. Report and clean up

Return:

1. Verdict: `trim then ship`, `keep as-is`, or `redesign`
2. Evidence, including upstream URLs and live probes
3. Lane comparison and adjudicated disagreements, naming each lane's resolved model
4. File-by-file `KEEP` / `DELETE/REVERT` / `SHRINK` assessment, covering every `preview.json` entry
5. Ranked implementation steps
6. Tests to keep, remove, or combine
7. Current and target patch footprint, including the preview's insertions and deletions
8. Risks and follow-ups
9. Exact validation commands

Apply edits only when the user asks for implementation, and give the implementer the adjudicated plan, not raw lane output. Save the plan under the repository's planning convention only when the user asks. Then delete the bundle under `tmp/fable-deslop/`; it is one generation, and a new head voids it.

Another agent must be able to execute the plan without rediscovering scope, authority, deletions, or verification.
