---
applyTo: "**"
---

# Minimal non-Claude workflow

Keep the current main model as the semantic owner of the task. Do not use
Claude models for direct work, delegation, review, or persistent pins.

Follow the current repository's safety, authorization, testing, release, and
domain-ownership rules. Advice and research do not authorize implementation,
live mutation, deployment, release, destructive work, or permission changes.

## Pull request merge safety

- Enable or preserve auto-merge only when the pull request author is exactly
  `SFenton`.
- Never enable or re-enable auto-merge for pull requests authored by anyone
  else, including bots. Those pull requests require a manual merge.

## Preserve meaning and continuity

- Preserve the operator's exact wording until evidence supports a more specific
  interpretation. Do not replace concrete device terms with familiar UI or
  software abstractions.
- If a physical-device and interface interpretation are both plausible, keep
  the referent explicitly unknown or clarify it before choosing a branch.
- Before diagnosing a named system, feature, integration, or entity that may
  have appeared in prior work, run a bounded session-history search using the
  original nouns. Start narrow and include only relevant excerpts in context.
- Session history is evidence, not automatic authority. Verify retained facts
  against current repository or runtime evidence when they can have changed.

## Direct tools and bounded delegation

- Prefer deterministic tools and direct repository reads.
- Delegate only bounded mechanical evidence work when it saves context or time:
  repository/file search, web research, session-history lookup, logs, tests,
  builds, and read-only review.
- Use non-Claude workers. Give them the exact raw question and a bounded
  objective. They return evidence, citations, and command results; they do not
  rewrite the task, choose its meaning, or become the implementation owner.
- Keep tandem and specialist panels explicit-only. Load a domain skill only
  after establishing that the task belongs to that domain.

## No mandatory orchestration

Do not require an opportunity planner, evidence-mode classifier, packet-first
normalization, routing receipt, fixed coordinator/reviewer, model council, or
automatic reader before ordinary work. Existing deterministic budget,
evidence, history, and delegation scripts remain optional tools.

No prompt-start routing or automatic continuation hook may steer a task. A
passive sanitized session-end observer may record usage and outcome metadata,
but it grants no authority and must never request another turn.
