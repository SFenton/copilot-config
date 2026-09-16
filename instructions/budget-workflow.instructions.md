---
applyTo: "**"
---

# Default budget-aware workflow

Apply the installed personal `budget-workflow` skill automatically for
substantive engineering and research tasks; the user need not name it.
For small questions, lookups or known commands, act directly without agent or
broker setup. A question asking for advice does not authorize implementation.

Keep one owner and prefer deterministic tools. For research, choose repository,
external or hybrid evidence; load only the relevant guide. Use a project's
`.github/agent-budget.json` when present. Without one, use native project rules
and direct tools rather than requiring a special checkout or inventing policy.
An optional sparse override at `.github/budget-contract.override.v1.json` may
add stricter gates or undiscoverable bindings, but it cannot widen model
authority, remove native repository rules, or enable release/destructive work.
For substantive project work, run the installed
`scripts/opportunities.mjs plan ROOT TASK.json` before selecting a model,
specialist skill, or tooling path, even when the current branch predates the
adapter's `opportunityPolicy` fields. The planner may read the one valid policy
bundle from an already-fetched local default-branch ref; it never fetches or
modifies the worktree. Version 3 runs the deterministic router, evidence
collection, and registered local tools without a model launch or model-bound
authorization. This is Markdown-first routing guidance plus non-blocking
observability, not a universal tool-blocking hook.
Known-pattern work then uses the exact project medium coordinator/reviewer.
Route by explicit role, not by the ambient interactive model:

- Frontier models handle research reasoning, architecture, adjudication, and
  final intent coverage from frozen evidence only.
- Repository/history/web evidence collection, coding, tests, review, and
  release preparation/execution should be delegated to deterministic tools or
  exact cheaper non-Claude roles whenever they are available.
- Always pin `model`, `reasoning_effort`, `context_tier`, and `agent_type` on
  every `task` dispatch.
- Default exact roles are `gpt-5.4` medium/default coordinator and reviewer,
  project-qualified workers on their evaluated pins, history/diagnostics/readers
  on mini/default profiles where supported, and explicit tandem on Sol
  max/default plus Astra medium/default.
- Availability fallback: delegation is preferred, but it must never prevent
  starting or resuming a session, invoking a skill, using explicit operator
  tools, delegating work, or calling `task_complete`. If the required cheaper
  worker/tool is unavailable, the current owner may proceed directly, preserve
  the project's safety/release gates, and report the routing exception plus any
  likely avoidable credits supported by evidence.
- Do not add or preserve persistent Claude task/session pins.

Deterministic packets, history plans, manifests, and receipts remain useful
optimization helpers. They are optional unless a project-specific safety or
release contract explicitly requires them, and they are not a prerequisite for
ordinary repository work.

For non-research implementation, the shared delegation runner may create only a
staged, untrusted provisional artifact when the repository adapter opts into the
exact task class and the work is low-risk, fully specified, and bounded to clean
exact targets. A medium reviewer may request exactly one defect-receipt-bound
revision. Provisional workers have no application authority. Reviewed
application additionally requires isolated pre-validation, medium acceptance,
separate operator repository-apply authorization, identical post-validation,
and exact rollback binding. Do not
delegate research, architecture,
debugging, security, semantic documentation, live-system, release, destructive,
ambiguous, or incompletely evidenced work.

Preserve mandatory project safety, validation and release contracts. Never
automatically invoke tandem, a reader agent or nested HydraFusion. Explicit
user requests and specialist model pins take precedence. Do not silently switch
the interactive model, change permissions or authorize production work.

Version 3 `releaseMachine` files use registered deterministic tools after
explicit operator authorization and must
remain `enabled: false` while any required GitHub, HA, database or production
tool is disabled. A project medium reviewer checks scope; Sol max/long exception
review requires a project trigger receipt, including failed rollback where
declared. Models never execute release commands or grant external authority.

The installed routing lifecycle hook keeps only `userPromptSubmitted` and
`sessionEnd`. It starts a private workflow identity, clears routing state, and
records non-blocking session-end compliance summaries using only sanitized
counts, hashes, and classes. The continuous-improvement observer keeps
`postToolUse`, `postToolUseFailure`, `subagentStop`, and `agentStop`.
The deterministic opportunity planner binds the selected plan to that workflow
through the session ID before substantive execution.
Its plan and any default-ref policy are advisory routing evidence only. They do
not grant repository-apply, external, live, release, production, destructive,
credential, or other side-effect authority.
It stores hashes, byte counts, operation/path/risk shapes, receipt lineage,
result classes, delegation/compliance counts, and reconciled usage, never raw
prompts, responses, tool results, source, commands, credentials, repository
paths, or environment values. Logging/reporting errors must never block session
completion, and the hook must never request another turn only for compliance.
It silently allows completion when no reusable subgraph exists. An eligible project with
`automaticBuild: true` may force one exact repository-local prepare/delegate
turn; `automaticPromotion` remains separate and false unless every evidence
gate is later proven. `stop_hook_active` and durable prompt markers prevent
recursive blocks. Learning grants no repository-apply, live, release,
destructive or external authority.
