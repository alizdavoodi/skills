# Arena: hardening `scripts/sync-upstream.mjs`

## Base

**CandidateC** (`poteto-agent` seat), 21 tests, +104/−50 on its own. The cross-judge
scored it highest (24/25 against B 22, A 21) and I agree independently: it is the only
candidate that closes all four defects named in the rubric *and* binary/symlink
corruption, with the smallest diff. Its structure is the reason it wins — file identity
lives in one place (`listFiles` returns `{sha, exec}` and rejects anything that is not a
regular file) and every conflict goes through one `conflict()` function.

Cross-judge's own numbers: A 21, B 22, C 24.

## Rubric scores (mine)

| | A | B | C |
|---|---|---|---|
| C1 Silent corruption | 4 | 4 | 5 |
| C2 Contract preservation | 2 | 4 | 4 |
| C3 Regression proof | 5 | 5 | 5 |
| C4 Live-range invariance | 5 | 5 | 5 |
| C5 Code discipline | 3 | 4 | 5 |

I scored A lower than the judge did on C2 because I reproduced its rename feature
deleting port content: it moved `references/a.md` but left the port's edited
`SKILL.md` stranded at the old path and adopted upstream's raw text at the new one.
`git mv` plus a content edit defeats similarity-based rename detection, so the "edit"
never pairs. A's central feature is unsound, not merely risky.

## Grafts, by source

**From B — `--upstream` resolution (1).** `--show-toplevel` plus a
`cat-file -e <sha>:pstack/skills` check. This closes a *silent* no-op that C has on real
data: `--upstream /tmp/up-head/harness` passes C's `existsSync(pstack)` guard and then
lists zero files, because `git -C <subdir>` resolves pathspecs relative to that
subdirectory. Exit 0, `add 0 update 0 conflict 0` — indistinguishable from "the port is
current". It also accepts the `--no-checkout` clone the script builds for itself, and
B's three tests came with it.

**From B — plan-then-write (2).** C wrote inside the loop, so any fatal error on a later
file left earlier files already rewritten with exit 2 and no summary of what landed.
Writes now accumulate and apply only after every file is planned. Test: a symlink at a
late sort position leaves the earlier file byte-identical.

**From all three — mode change lost on conflict (3).** Not in the rubric; the
cross-judge found it and I reproduced it on all three candidates. Upstream flips
`run.sh` to `755` *and* makes a conflicting text edit → every candidate exits 1 and
leaves the file at `644`. The human resolves the text, the pin advances, and the bit is
gone forever. Fixed by treating the bit as independent of the text: a conflict can still
queue a `chmod`. Verified: synthesized build lands `755`, C-base stays `644`.

**From B — identical-change fast path (4).** When both sides made the *same* change, C
still called `merge-file`, which refuses binary content and returns 255. C read that as
"binary, changed on both sides" and reported a spurious conflict forever. Now
`ours.equals(theirs)` short-circuits before the merge. Verified: exit 0, zero conflicts
where C reported one.

## Rejected

**A's rename following.** Unsound as shown above, and it silently `rmSync`s port files
with no stdout line. Not grafted.

**A's `-c core.quotepath=false` for non-ASCII paths.** Only applies to calls through
`git()`; `readAt`, `isAncestor` and `mergeThreeWay` bypass it, and a path containing a
double quote still breaks. B and C use `ls-tree -z`, which is correct.

**C's per-file `.merge` deletion, A's per-file `.merge` deletion.** C refuses to run
while any `.merge` exists. That is the only policy that also protects a half-finished
human resolution, so it is kept. A deletes stale files, B leaves them silently; both can
destroy or commit a resolution in progress.

## Convergence

All three independently found and fixed: dropped exec bits, resurrected port deletions,
inverted/empty ranges, the phantom `no base at pin` conflict that promised a `.merge` and
wrote none, dead `MIRRORED` + `relative`, and binary/symlink handling (C, B). All three
preserved the exact stdout shape, exit codes, and the `28/11/5` live range. That
agreement is why the base needed no restructuring.

## Known gaps, deliberately not fixed

**Deleted-skill fragments.** I built a guard for this and reverted it: it fired on
`statechart` and `ketchup-video` in the pre-sync reference tree, because a file absent
from the port because it was *never synced* is indistinguishable from one deliberately
deleted when both look at the pin. Breaking the reference count is a worse defect than
the orphan it prevents. It needs pin awareness the script does not have.

**Exec bit on a "deleted here, changed upstream" merge.** The `.merge` carries no mode,
so resolving it leaves the port's bit.

**Rename handling.** Upstream renames land as `add` (raw upstream text) plus
`removed upstream, kept here`. Both lines are reported, so it is not silent, and the
live range contains zero renames.

**README pin drift.** The README told the next sync to use `--pin b1a1298` while the
port already contained `99b609a`, seven commits later. Corrected to `99b609a` in this
change.

## Verification

- `node --test scripts/sync-upstream.test.mjs`: **26 pass, 0 fail**.
- Red state: same test file against the original script gives **7 pass, 19 fail** — the
  original 7 pass byte-unmodified, every added test fails before its fix.
- Live range on a pre-sync export of `170e0a1`:
  `would add 28, update 11, conflict 5, upstream-removed 0`, and the full stdout is
  **byte-identical** to the original's (`diff` empty).
- Real (non-dry) run on that export: exit 1, `did add 28, update 11, conflict 5`, five
  `.merge` files, and `watch-pr`, `worktree-audit.sh`, `log.sh` still `-rwxr-xr-x`.
- At HEAD: `0/1/8` against the original's `0/1/34`. The 26 dropped conflicts are
  `statechart` files already byte-identical to upstream; C's empty-base merge is the
  only cause.

## Models

The arena's value did not rest on model diversity: seat overrides in
`~/.omp/agent/config.yml` map `reviewer`→`@advisor` and `poteto-agent`→
`anthropic/claude-opus-5-5`, while `task`→`@task`. OMP did not return resolved-model
metadata with these results, so I am not claiming which model produced which candidate.

## How the numbers were measured

Three independent candidates were built in separate git worktrees from the same
brief, then cross-judged. The reproductions above were throwaway fixtures, each a
two-commit upstream repo plus a fake port tree, deleted afterwards. To re-check a
claim, the tests in `sync-upstream.test.mjs` are the durable form: every one of them
fails against the pre-hardening script and passes against this one.
