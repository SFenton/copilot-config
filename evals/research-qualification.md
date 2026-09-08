# Research qualification: not promoted

Decision date: 2026-09-07 UTC. The cheaper **Sonnet 5 / medium / default-context**
profile is not qualified as a standalone research decision owner. It may draft
or collect bounded evidence; a frontier owner retains source adjudication.
This is a routing safeguard, not certification of another model's equivalence.

## What was compared

Twelve new, curated local-research questions across HA React, EverShelf,
ha-evershelf and FST. Models had to discover relevant evidence with read/search
tools in identical frozen source snapshots. They could not use shell, network,
write tools, live services, hidden criteria, or another solver's answer.

The reference was **one Sol max/long-context researcher**, not the previous
Sol/Opus tandem. Complete equal-input historical Sol/Opus artifacts could not
be recovered. A partial Astra/Opus FST archive supplied a separately labelled
causal-reasoning challenge; it is not a full tandem replay.

The cases and criteria were sealed before the solver runs. Both defensible
designs and unsafe shortcuts were included. No solver was repaired or rerun
after grading; one attempted out-of-corpus path remains protocol-invalid.

## Findings and interpretation

The original conservative worst-of-two assessor grades cleared all required
critical criteria and the score floor on 8/12 reference answers versus 3/12
candidate answers. Assessors disagreed on at least one criterion in 11/12
pairs. These are **model-graded diagnostic counts, not ground-truth accuracy
or population-equivalence estimates**.

Direct source review confirmed examples of material candidate gaps:

- HA: an authoritative live-state change supersedes a garage command; it does
  not necessarily prove the target position was reached.
- EverShelf: logical request epoch/generation/hash are not all renewed on
  every retry; they differ from per-attempt lease identity.
- Integration: a request builder proves input shape, not that optional
  expected-target/token fields are the only backend concurrency mechanism.
- FST: an existing immutable planner cycle can return before current
  quiescence/broadcast checks; old success is not current safety evidence.

Some rubric penalties were debatable or reflected omitted detail rather than
false claims. In particular, a copied-fixture requirement was not included in
one solver's source corpus. The original grades remain immutable; they must
not be treated as final human-adjudicated labels or tuned into a promotion.

The reference also missed details. This study neither proves the reference
equivalent to tandem nor establishes a universal frontier-model guarantee.

## Harness hardening

The initial cheap assessor often paraphrased text labelled as exact quotations.
The revised protocol binds evidence to deterministic paragraph IDs, validates
same-answer support references, and uses independent Opus medium and Sol high
assessors with reversed anonymous answer order. Original failed assessments
and all their costs remain in the evidence.

`run-leaf.mjs` has an explicit research mode with read/search tools, default
CWD path permissions, temporary-directory access disabled, frozen-corpus hashes,
post-run tool-path auditing, and the same soft credit cap/shared ledger.
This is not an OS sandbox; out-of-scope attempts invalidate a run even when
the attempted file did not exist. Use relative paths, never reconstructed
session UUID paths.

## Promotion boundary

`research.mjs` reports a one-sided Clopper-Pearson upper bound on regression
risk per source family, with a four-project family-wise correction. Even with
zero regressions, 86 independent families per project are needed just to get
the upper bound under 5% at that correction; three hand-picked cases per
project cannot establish it. More samples would still not repair a missing
tandem baseline, correlated tasks, or unvalidated model judgments.

Do not spend on a larger equivalence study while these concrete regressions
and evaluation-provenance gaps remain. Preserve frontier decision ownership,
use deterministic evidence/format tooling, and treat this batch as consumed
evaluation material, not a fresh holdout for future prompt tuning.

## Reproduction

```bash
npm test
node evals/research.mjs prepare evals/research-cases.json roots.json /private/new-study 1500
node evals/research.mjs solve /private/new-study case-id reference
node evals/research.mjs solve /private/new-study case-id candidate
node evals/research.mjs prepare-assessment /private/new-study
node evals/research.mjs assess /private/new-study case-id opus
node evals/research.mjs assess /private/new-study case-id sol
node evals/research.mjs report /private/new-study
```

`roots.json` maps `ha`, `evershelf`, `integration`, and `fst` to repository paths
containing the referenced commits. Do not execute the whole study casually:
the limit is explicit, per-call limits are soft, and failures still cost money.

Sources: frozen commits and source paths in `research-cases.json`; statistical
reference https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm.
