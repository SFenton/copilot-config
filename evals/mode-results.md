# Evidence-mode calibration and operating decision

Date: 2026-09-07. Six consumed calibration questions, not held-out promotion
evidence. Repository-only, external-only and hybrid each have two questions.

## Decision

Use one current owner plus deterministic evidence operations. No automatic
reader/selector agent, draft worker or tandem. For explicit new bounded
low/medium-risk runs, cost-first uses Sol high/default and speed-first uses Astra
low/default. High/unknown risk, novelty and project risk terms retain Astra
high/default. Explicit specialist/user pins win.

This is a lower-credit operating choice, **not a lower-total-token claim**.
Current-owner `init`/`evidence` launches no extra model. Optional `run` isolates
one research owner; it does not change the interactive coordinator.

## What was measured

The raw baseline uses Astra low/default, eager historical root rules and raw
file/document presentation. Both sides use the same allowed-tree/public-source
broker opportunity. The lean treatment uses phase context, syntax discovery,
bounded evidence, deduplication and one owner. It is not a literal replay of old
production sessions, unrestricted web search or actual HydraFusion.

| Stage | Solver spend | Result |
|---|---:|---|
| v1: raw plus initial lean, fixed Astra low | 720.53 credits | External savings; parser failures and over-research exposed. |
| v2: repaired lean, fixed Astra low; retained raw | 319.41 credits | 16.6% fewer credits and 18.5% fewer tokens overall versus raw; uneven by mode. |
| v3: Sol high lean; retained raw | 207.29 credits including failed hybrid | 179.31 for six selected answers; 27.97 for the retained invalid first hybrid attempt. |
| v3 independent assessments | 123.20 credits | All six selected candidates met the calibration floor. |

The final v3 ledger spent 330.48 of its 350-credit ceiling with no outstanding
reservations. Across all three mode studies, spend was 1,370.42 credits.
Two external canaries add 40.75: 1,411.17 controlled credits total. Parent
authoring/research and earlier studies are separate overhead, not savings.

## Selected-answer comparison

| Case / project | Raw credits | Lean credits | Credit reduction | Raw tokens | Lean tokens | Lean rubric |
|---|---:|---:|---:|---:|---:|---:|
| Ingredient validation / HA integration | 78.14 | 23.80 | 69.5% | 146,377 | 129,526 | 100% |
| Feature state / FST | 38.57 | 28.43 | 26.3% | 87,586 | 125,899 | 100% |
| SQLite foreign keys / external | 60.87 | 22.79 | 62.6% | 200,782 | 143,605 | 100% |
| TaskGroup / external | 48.52 | 20.48 | 57.8% | 141,734 | 134,709 | 100% |
| WAL / EverShelf | 79.26 | 48.28 | 39.1% | 241,185 | 520,220 | 100% |
| Layout effects / HA React | 77.46 | 35.54 | 54.1% nominal* | 117,573 | 256,552 | 100% |

*The raw HA reference failed its hybrid evidence gate (no external read).
Its arithmetic is retained, not treated as a quality-qualified baseline.
EverShelf's failed first lean attempt adds 27.97 credits and 175,517 tokens:
including that retry history, its cost reduction is only 3.8%.
The explicit Sol evaluation pin does not promote all SQLite/ontology work past
the project's conservative risk-term gate.

Selected totals: **382.82 -> 179.31 credits (53.2% lower)**, but
**935,237 -> 1,310,511 tokens (40.1% higher)**. Including the failed hybrid:
207.29 credits (45.9% lower) and 1,486,028 tokens (58.9% higher).
Selected solver elapsed time was 405.4s versus 320.3s (26.6% slower).
Across only evidence-valid baseline pairs, selected credit reduction is 52.9%.
These figures combine architecture and model changes; they cannot identify
the standalone effect of Sol high or the broker.

| Mode | Selected credit reduction | Selected token change |
|---|---:|---:|
| Repository | 55.3% | 9.2% more |
| External | 60.4% | 18.7% fewer |
| Hybrid | 46.5% nominal* | 116.5% more |

## Quality and iteration limits

Opus medium independently graded anonymous answers with source-backed criteria
and deterministic answer paragraph IDs. All six selected lean answers scored
100%; raw scored 100% except WAL at 87.5% (the external claim was supported only
by an index and explicitly qualified). Parent source review checked important
null/key-presence, strict-boolean, existing-WAL and layout-lifecycle distinctions.
This is not a population guarantee: six familiar bounded questions do not
establish broad research, implementation or previous Sol/Opus tandem parity.

Retained issues include blank optional arguments, PHP grammar failure, hybrid
orientation starvation, and CLI response/log truncation. The selected FK run
has one index-page transport evidence gap; direct technical pages supported its
conclusion. Missing intact output is never reconstructed as proof of access.
Review uses retained excerpts plus separately labeled current oracle sources.

Final fixes normalize blank optionals, narrow schemas, cap hybrid orientation,
persist remaining budget and bound serialized lean output below CLI truncation.
The final transport repair is covered deterministically, not by another paid
six-case rerun. Some selected answers therefore predate final ergonomics fixes.
Do not relabel iterations as holdouts or hide their spend.

Web cache stats were recorded but not controlled as a dedicated cold/warm
experiment. Shared per-study caches, counterbalanced initial arm ordering and
retained baselines have order effects. No universal warm-cache saving is claimed.

## Beyond research

No production implementation/release was run merely to manufacture an end-to-end
comparison. For planning, if research represents fraction `f` of current credits,
other phases stay unchanged, and this calibration transfers, expected overall
reduction is `f * research_credit_reduction`, less any escalation/review overhead.
At `f=0.5`: integration 34.8%, FST 13.2%, EverShelf 19.5%, HA 27.1% nominal.
Including the observed EverShelf retry lowers that estimate to 1.9%.
These are conditional estimates, not measured deliveries. Measured token counts
above explicitly rule out promising token reductions in every project.

See [evaluation protocol](README.md) for reproduction and
[shared architecture](../README.md) for supported modes, dependencies, privacy,
freshness, project gates, installation and rollback.
