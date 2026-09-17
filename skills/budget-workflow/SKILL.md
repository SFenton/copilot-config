---
name: budget-workflow
description: Minimal non-Claude engineering workflow with one semantic owner, targeted history continuity, direct tools, and bounded evidence delegation.
---

# Budget workflow

Use this skill as lightweight guidance, not as a routing ceremony.

1. Keep the current main model responsible for understanding the operator's
   request, resolving ambiguity, integrating evidence, and producing the final
   answer or implementation.
2. Preserve the operator's wording verbatim. Record interpretations separately
   and do not silently translate physical-device behavior into UI terminology.
3. For a named recurring system, feature, integration, or entity, run a narrow
   session-history search with the original terms before diagnosing it. Bring
   back only relevant excerpts and revalidate facts that may be stale.
4. Use deterministic tools directly. Delegate only bounded file/repository
   reading, web research, history lookup, logs, tests, builds, or read-only
   review when delegation is genuinely cheaper or keeps the main context clean.
5. Use non-Claude delegates. Give each the raw task plus an exact evidence
   objective; delegates must not normalize the task or acquire semantic,
   repository-apply, live-system, release, or destructive authority.
6. Load specialist skills only after identifying the owning layer. Tandem and
   multi-agent panels remain explicit-only.
7. Follow repository safety, authorization, testing, and release contracts.
   Use the smallest validation that proves the requested outcome.

Opportunity planners, evidence modes, frozen packets, manifests, receipts,
fixed model roles, and staged-worker machinery remain available as optional
utilities. They are never prerequisites for ordinary research or engineering.
