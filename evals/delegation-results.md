# Bounded implementation delegation calibration

Date: 2026-09-08

## Decision

Historical evidence only. This six-case v1 study does not qualify any current
capability, model, validator, sandbox, or application path. Its solve entry
point is disabled. Current v2 promotion requires at least 30
capability-matched cases, complete all-leg accounting, a qualified registered
sandbox, frontier review, and explicit reviewed application; acceptance is
never automatic.

## Frozen evaluation

The historical run covered six independent synthetic repository cases:

- two convention-matching scaffolds;
- two `node:test` suites required to pass the correct implementation and kill
  three hidden mutants each;
- two existing-file mechanical transforms with hidden behavioral validators.

Every arm used the same bounded evidence and strict JSON artifact contract.
Sol high/default was the frontier baseline. Failed workers would be charged
together with a Sol fallback; no selected worker required fallback.

| Worker | Passed | Credits | Credit savings | Tokens | Token savings | Elapsed change |
|---|---:|---:|---:|---:|---:|---:|
| Sol high baseline | 6/6 | 16.2167 | - | 29,221 | - | - |
| MAI Code 1.1 Flash | 6/6 | 0.87094 | 94.6% | 21,920 | 25.0% | 76% slower |
| GPT-5 mini | 6/6 | 1.064075 | 93.4% | 21,271 | 27.2% | 175% slower |
| GPT-5.4 mini | 6/6 | 2.146395 | 86.8% | 29,118 | 0.4% | effectively equal |

Gemini 3.8 Flash passed the mutation-test pilot but attempted a denied tool on
the scaffold pilot. That isolation failure disqualifies it from this lane.

Expanded calibration also tested Gemini 3.5/3.6/3.7, Claude Haiku 4.5, MAI Code
1 Flash Picker, and HydraFusion. Gemini 3.7 passed the generic suite but was
less efficient than MAI; Gemini 3.6 requested a denied tool, Haiku violated
strict JSON, MAI Picker required fallback, and HydraFusion was unavailable even
with experimental mode. Repository suites subsequently qualified GPT-5 mini
for React, Gemini 3.7 for EverShelf and HA-EverShelf, and MAI for FST.

## Current enforcement

The v2 reviewed artifact path requires adapter opt-in, a repository-selected
bounded phase, exact registered validator and sandbox profile, low risk,
complete sanitized evidence, clean exact targets, one worker attempt, and
network-off isolated validation. Staged output is untrusted. Application
requires a validation-bound frontier acceptance receipt, unchanged revision
and scope, a promoted capability explicitly approved for reviewed
application, post-apply isolated validation, and exact rollback on failure.
The public apply command remains disabled.

## Limits

This is a six-case historical measurement, not a current calibration or
population-level equivalence proof. It does not qualify research,
architecture, debugging, security, semantic
documentation, UI/visual behavior, database/concurrency/performance work,
cross-contract changes, live systems, releases, destructive operations, dirty
targets, ambiguous tasks, or validators that do not encode the real contract.

The table excludes the already-active interactive owner's packaging cost and
therefore cannot establish current all-leg production savings. The router and
validators themselves use no model calls. Projects retain their implementation,
validation, safety, release, and specialist-model gates.
