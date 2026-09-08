# Evaluation boundaries

`scenario-builder.mjs OUTPUT_DIR` creates transparent hypothetical
research-to-release cost scenarios for HA, EverShelf, the integration and FST.
Output files use exclusive creation; use a new directory for a new version.
It uses published 2026-09-06 per-million-token rates and explicitly lists all
assumed calls, cache categories and tokens. Cache writes are set to zero in
these scenarios, not omitted from the estimator. Change the scenario when
fresh-cache writes or provider thresholds apply.

Each scenario compares the previous Sol/Opus tandem against selective
Sonnet/mini/Astra/Opus work, also reports the newer Astra-based baseline, and
adds three unexpected frontier calls as a sensitivity analysis. These are
not measured end-to-end project deliveries. Validation/release evidence legs
remain in both sides; authorization to release is not granted.

The `pilot.mjs` supplied-evidence comparison tests a different, narrower claim:
whether bounded exact evidence and a cheaper single worker can answer a
specific source question with the required schema/citations. Its baseline
is one Astra max/long-context call, not tandem. A smoke run cannot establish
research, debugging, implementation or release equivalence.

## Local research comparison

`research.mjs` and `research-cases.json` add frozen-corpus, read/search-enabled
research comparisons rather than simple extraction. Criteria and anonymous
answer order are sealed outside the solvers' allowed working directories.
The original cheap quotation-based assessor was unreliable; the retained
second protocol uses deterministic paragraph IDs and stronger independent
assessors. It never modifies solver answers or silently discards failed runs.

See [research qualification](research-qualification.md) for the negative
qualification decision, observed limitations, statistics and reproduction
commands. These cases are now consumed evaluation material, not fresh holdouts.

## Four-arm profile/workflow comparison

`factorial.mjs` compares Sol max and Astra low with and without the tested
adapter/evidence/handoff treatment. It retains shared source opportunity,
counterbalanced positions, full preparation attribution and four-way anonymous
paragraph-based grading. See [factorial results](factorial-results.md) for the
observed cost increase from the handoff and the direct Astra speed/cost tradeoff.

For real promotion, freeze:

- starting commit, data, task class, input/fixture hashes, and permitted tools;
- independent hidden behavior assertions and critical safety failures;
- blinded research rubric: accuracy, evidence coverage, alternatives,
  falsification, uncertainty, actionability;
- matched resource/time limits and complete all-leg usage;
- intended noninferiority margin and statistical method before scoring.

Run `budget.mjs evaluate` on independently retained paired outcomes. Missing
results and critical failures block promotion. Visible prompt-tuning tasks
remain calibration cases; never relabel them held-out.

## Evidence-mode architecture calibration

`mode-study.mjs` and `mode-cases.json` exercise full adapter-allowed repository
discovery, external documentation discovery, and repo-contract/external-gap
hybrid research. They compare raw file/document presentation and eager
historical roots with lean phase context and syntax-aware evidence. Both arms
share the broker's approved public-source/privacy capability; this is not an
unrestricted-web or literal old production-session replay.

```bash
node evals/mode-study.mjs prepare evals/mode-cases.json roots.json NEW_OUTPUT
node evals/mode-study.mjs solve OUTPUT CASE
node evals/mode-study.mjs assess OUTPUT CASE
node evals/mode-study.mjs report OUTPUT
```

A retained `BASELINE_STUDY` fifth argument reuses its sealed raw answers rather
than charging another baseline. Final `cost` argument chooses Sol high/default
instead of Astra low/default. This measures **architecture plus model** together,
not architecture-only causality. Each study owns an explicit reservation ledger.

`retry OUTPUT CASE` is explicit, only permits an invalid original, records its
selection before the new run, retains the failed directory and charges the same
ledger. It is not best-of-N quality selection. Reports expose prior attempt
costs; do not advertise only the successful attempt as total iteration spend.

Opus medium assesses anonymous paragraph-anchored answers against actual source
and hidden criteria. Web review separates retained broker output from current
oracle material. Mutable public pages are not silently substituted as historical
evidence. CLI transport/log truncation is explicit: a registered source ID or
full `detailedContent` does not prove all text reached the solver. Missing intact
responses remain evidence gaps. New lean broker responses avoid that threshold.

The retention floor is valid completion, >=80% criterion score and no critical
criterion scored zero. It permits limited detail loss and is **not** a statistical
equivalence certificate. These six questions were used for calibration and
iteration; they are not fresh holdouts, large architecture investigations,
implementation/release benchmarks or actual HydraFusion/tandem comparisons.
