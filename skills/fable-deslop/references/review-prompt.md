# Shared review prompt

Send this text to every lane of one `task` batch, once per item, word for word. Fill the bracketed fields from
the pinned review and the frozen bundle before sending. The lanes are independent only if the request and the
bundle are identical, so the text below stays byte-identical across items; only the item's `agent` differs.

## Header to fill

- Repository and worktree
- Comparison scope: `preview.json` mode, base and head refs, or the exact uncommitted scope
- Bundle path and its `sha256`, plus `patch.diff`, `preview.json`, `rules.json`, and `meta.md`
- Observable user impact
- Invariant the patch must preserve, as observable behavior
- Smallest plausible causal edit
- Authoritative evidence: which selected files and upstream sources decide a claim
- Shortcuts already disproved by a live probe
- Named suggestions, labeled as hypotheses
- Reviewable file count from `preview.json`

## Body

Audit this patch in two passes. First, audit the semantic delta independently, without reference to any suggestion below. Second, adjudicate the supplied suggestions. The named suggestions are hypotheses, not the review scope.

- Report only high-confidence issues caused or worsened by the diff that materially affect correctness, scope, maintenance, or safe reversion. Identify pre-existing issues separately. A clean review is valid. Do not nitpick or manufacture findings.
- Apply YAGNI and minimize degrees of freedom before line count. Start from the pre-change code and retain only changes necessary for the stated outcome and invariant.
- Require every new branch, mode, flag, fallback, compatibility check or cache, migration path, defensive conditional, validation, rewrite, rename, helper extraction, refactor, duplicated infrastructure, or test to be justified by an explicit requirement, an observed consumer or persisted/external contract, or a reproduced bug. Otherwise mark it `DELETE/REVERT`.
- Propose the smallest patch, not the shortest or cleanest final implementation. Prioritize reverting unnecessary or out-of-scope code as safely as possible. Do not reshape, inline, rename, or reformat retained code merely to reduce lines.
- Distinguish required explicit recovery from silent fallback. Do not remove real security, authorization, sandboxing, untrusted-input, network, filesystem, or external-API boundary defenses.
- Treat `rules.json` as a checklist, not a verdict. A rule that fires on unchanged code is pre-existing; say so and keep it out of the deletion list.
- Assess every changed implementation and test line against the pre-change code. Group only inseparable adjacent lines. Mark each range `KEEP`, `DELETE/REVERT`, or `SHRINK`.
- Separate root-cause requirements from hardening and speculation. Identify correctness defects separately from edit-minimality findings.
- Compare every new or changed transformation and failure boundary with its predecessor: whitespace and content preservation, thrown versus swallowed errors, nil/default/fallback behavior, ordering and cardinality, cancellation and cleanup, and terminal output state.
- Trace each transformed value from caller to external boundary. Require a test for every intentional semantic delta.
- Compare current and target degrees of freedom (branches, modes, configuration, state paths), changed-line counts, structural divergence, and cognitive-complexity direction.
- State the risk of every proposed deletion.
- Classify a necessary remedy that exceeds the pinned scope as a scope decision instead of expanding the patch.
- Every finding must name a concrete impact and the evidence behind it. Passing tests alone do not establish a faithful edit.
- Account for every file listed in `preview.json`: `reviewed`, or `skipped` with the concrete reason.
- End with a ranked deletion list and exactly one verdict: `trim then ship`, `keep as-is`, or `redesign`.

Account for every changed line and end with a plan another engineer can check.
