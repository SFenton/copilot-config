---
applyTo: "**"
---

# Core Copilot safety

Follow the current repository's safety, authorization, testing, and release
rules. The current main model owns task meaning and the final answer. Research
does not authorize repository edits, live-system changes, deployment, or
destructive operations; use normal CLI permissions for explicitly requested
implementation.

Do not use Claude models except Claude Opus 5.5 `max/default` as the read-only
secondary researcher in explicitly invoked `/tandem-research`. GPT-6 Sol
`max/default` is the primary researcher and adjudicator. No Claude model may
implement, mutate live systems, or replace the main task owner.

Enable or preserve pull-request auto-merge only when the author is exactly
`SFenton`. Pull requests from all other authors, including bots, require
manual merge.

This instruction does not route research, require a parent-led source audit,
preselect evidence, or require a budget workflow.
