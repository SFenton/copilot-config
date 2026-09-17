---
name: tandem-research
description: Explicit-only independent Sol/Astra research with shared raw intent, matched evidence, cross-critique, and Sol adjudication.
---

# Tandem research

Use this skill only when the operator explicitly invokes `/tandem-research`,
requests Sol/Astra tandem research, or asks for two independent frontier
researchers. Never trigger it from task importance alone.

## Invariants

1. The operator's exact prompt is canonical. Give it unchanged to both
   researchers and never replace it with a normalized question.
2. The current owner gathers deterministic evidence directly or through
   bounded non-Claude readers. For a named recurring system, search relevant
   session history with the original nouns before the first research pass.
3. Sol `max/default` and Astra `medium/default` receive the same raw prompt and
   the same evidence bundle. They reason independently before seeing the other
   report.
4. Evidence bundles may be hashed for reproducibility, but packet machinery and
   routing receipts are not prerequisites. Evidence must retain source
   provenance and distinguish current facts from historical context.
5. After both first passes, compare material agreements, disputes, unique
   findings, and evidence gaps. Fulfill bounded gaps once, then give both
   researchers the same additions.
6. Each researcher critiques the other's completed report. Sol performs the
   final evidence-bound adjudication.
7. Tandem grants no implementation, repository-apply, live-system, release, or
   destructive authority. Follow-on work returns to the current main owner and
   the repository's normal safety and validation rules.

Do not use Claude models in tandem or as fallback researchers.
