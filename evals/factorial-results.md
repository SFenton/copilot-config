# Sol max / Astra low: profile x workflow comparison

Study date: 2026-09-07. Eight fresh, mixed-difficulty source-research questions
were run through four arms. This is a controlled comparison of a **tested
infrastructure treatment**, not a certificate for all research or a literal
replay of the old production environment.

| Arm | Total credits | Total billed-category tokens | Mean component latency | Mean model-graded rubric score |
|---|---:|---:|---:|---:|
| Sol max, legacy-style direct | 297.33 | 997,666 | 131.4s | 99.1% |
| Sol max, infrastructure handoff | 424.33 | 3,839,252 | 191.7s | 98.2% |
| Astra low, legacy-style direct | 341.91 | 610,370 | 55.9s | 100.0% |
| Astra low, infrastructure handoff | 493.38 | 3,651,464 | 151.6s | 100.0% |

These are totals over the same eight questions, except latency and score.
Tokens include cached context repeated across calls, without double-counting
token categories within a call. Scores are model assessments, not accuracy
certificates.

## Findings

- Direct Astra low was 38.8% lower in tokens and 2.35x faster than direct Sol
  max, but cost 15.0% more credits. Excluding one protocol-invalid Sol run,
  Astra's premium was 20.3% and speedup 1.93x.
- The tested handoff increased credits by 42.7% for Sol and 44.3% for Astra,
  with no demonstrated material quality improvement. It should not be promoted
  as a general budget optimization on these tasks.
- Preparation cost 95.84 credits and 2.93 million tokens. Two selections failed;
  successful preparations alone still left the handoff 33-36% more expensive
  on the matched subset.
- Even excluding all preparation fees, target-model credits rose 10.5% for Sol
  and 16.3% for Astra. The handoff/checklist also caused redundant source/policy
  inspection; a cheaper worker alone would not solve that.

The direct-action-first rule remains important. These corpora were already
localized to relevant files, so the study does not measure potential savings
from discovering files in an entire large repository. The autonomous
range-selector used here is also not Spotify's one-shot, tool-less bulk reader.
Do not generalize this negative result to every possible evidence pipeline.

## Treatment and fairness

Both profiles retained their settings across workflows: Sol max/long-context
and Astra low/default-context. All observed charges reconciled to published
default-tier rates; selecting long context was not itself a price-doubling
factor.

Legacy-style: eager full historical root instructions and direct read/search
research, without router, worker, packet or budget checklist.

Infrastructure: adapter/router handoff (experimental profile override),
deterministic complete packets for <=8 KB/200-line tasks, otherwise one
GPT-5.4 mini range selector, source-verified exact packets, a source-adjudication
checklist, and at most one mechanical-protocol correction. Full source and policy
opportunity was identical. A failed selection explicitly fell back to discovery.

Preparation ran once per question so the two infra profiles received the same
packet. Its full cost/time is attributed to EACH infra arm for standalone-query
comparison; actual study expenditure counts the execution once.

The shared measurement envelope retained read-only tools, source hashes, path
limits and budget observation for all arms. It excluded full historical tool
catalogs, live systems, literal HydraFusion, native read-hook enforcement, and
tandem workflows. Root instructions were represented, not every old scoped
instruction or conversation history.

Question/criterion/profile/source seals preceded model runs. Orders were
position-balanced cyclic rotations; carryover and API-cache effects were not
fully balanced. Independent Opus medium and Sol high assessors saw anonymous
four-way answers with reversed order and deterministic paragraph IDs.

## Failures and safeguards

One calendar range selector timed out. The original launcher killed only its
loader, leaving a CLI child to finish later. Its late packet was rejected;
final telemetry was recovered and the full 29.65 credits charged. The launcher
now cancels an owned process group/tree, with real descendant termination tests.
The actual CLI loader/child process-group behavior was also checked without
making a model call. No successful primary run timed out.

Another selector exceeded the declared range limit and was rejected, with its
cost retained. One Sol direct run attempted a parent-directory read that was
denied; its answer still received full content scores but remains
protocol-invalid. No solver was silently rerun or omitted.

All model/effort/prompt/source bindings matched, all primary answers met the
word limit, and all sixteen final assessors passed structural/provenance checks.
No actual research model default or project application was changed.

## Accounting and interpretation

Actual study expenditure was **1,883.590505 credits**:

- target research: 1,365.25933;
- shared evidence preparation: 95.843775;
- independent evaluation: 422.4874.

The 55 CLI run invocations contained multiple API calls. Setup, case authoring,
the separate canary and parent analysis are not included in that study ledger.
No outstanding reservations remained inside its 2,500-credit ceiling.

No blanket research-equivalence promotion follows from eight near-ceiling,
curated tasks. Astra low direct is a promising latency/cost tradeoff for bounded
source research; Sol max direct was cheapest in aggregate. Test lean,
phase-relevant deterministic preparation before broadening the handoff.

## Reproduction

```bash
npm test
node evals/factorial.mjs prepare evals/factorial-cases.json roots.json /private/new-study 2500
node evals/factorial.mjs run-case /private/new-study case-id
node evals/factorial.mjs assess /private/new-study case-id opus
node evals/factorial.mjs assess /private/new-study case-id sol
node evals/factorial.mjs report /private/new-study
```

Run all eight case IDs. `roots.json` maps `ha`, `evershelf`, `integration` and
`fst` to repositories containing the referenced commits. These cases are now
consumed evaluation material, not fresh holdouts after tuning.
