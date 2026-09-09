---
name: tandem-research
description: Explicit-only independent GPT-5.6 Sol and Claude Opus 5 research with cross-critique and Sol adjudication. Follow-on implementation uses the project hierarchical pipeline.
allowed-tools:
  - write
---

# Tandem Research Skill

Use this global skill only when the operator invokes `/tandem-research`, asks
for Sol/Opus tandem analysis, or explicitly requests two independent
frontier-model investigations. An audit, architecture decision, or request
for high confidence alone does not invoke this protocol. Use budget-workflow
for ordinary work. A request not to use tandem always excludes this skill.

Canonical source: `https://github.com/SFenton/copilot-config`.

The default is **research first**, and this skill is allowed to create and edit
files. Perform implementation when the operator requests a fix, change, or
follow-through, or has already approved implementation. Do not modify
production, databases, or external systems without explicit approval.

## Tool capability contract

The `allowed-tools` frontmatter pre-approves the model-independent `write`
permission. It does not install tools, expose filtered tools, or make a tool
name valid for every model. Use only tools present in the current agent's
actual tool list.

| Agent/model | Search | Read | Mutation |
|---|---|---|---|
| GPT-5.6 Sol | `rg`, `glob` | `view` | `apply_patch` |
| Claude Opus 5 | `grep`, `glob` | `view` | `create`, `edit` |

The Claude mutation tools may be exposed by a `general-purpose` agent, but the
tandem contract keeps Claude read-only. They are not aliases that Sol can call.
Likewise, Claude must not call Sol's `rg` or `apply_patch` names.

`rg` and GNU `grep` are shell executables only when invoked through `bash`;
`apply_patch`, `create`, and `edit` are Copilot built-ins and cannot be
installed as packages. Prefer the built-in search tool. Use `/usr/bin/rg` or
`/usr/bin/grep` through `bash` only as a fallback after `command -v` confirms
the executable exists. Do not pre-approve `shell` globally for this skill.

Before tool use:

1. Search only explicit in-scope paths that exist. Use `glob` to resolve an
   uncertain file name before passing it to `rg` or `grep`; do not recursively
   search the whole home directory by default.
2. The built-in `rg` and `grep` search tools use Rust regular expressions and
   do not support look-around. Rewrite such patterns as simpler searches, or use
   `/usr/bin/rg --pcre2` through an approved `bash` call when necessary.
3. Before creating a file, ensure its parent directory exists. `create` only
   accepts a new path; `edit` requires current, uniquely matching text.
4. Before `apply_patch` or `edit`, re-read the current target after any agent,
   generator, formatter, or earlier edit may have changed it. Do not retry a
   stale patch unchanged.
5. Use valid `apply_patch` `Add File`, `Update File`, or `Delete File` hunks.
   If the expected mutation tool is absent, return implementation ownership to
   the coordinator rather than inventing a tool name or editing through shell
   commands.

## Required model contract

The tandem always consists of:

| Role | Model | Effort | Context |
|---|---|---|---|
| Primary researcher and final adjudicator | `gpt-5.6-sol` | `max` | `long_context` |
| Independent second researcher | `claude-opus-5` | `max` | `long_context` |

Requirements:

1. Launch both researchers explicitly with the exact model, effort, and context
   settings above. Never silently substitute another model.
2. Verify that each launch's resolved runtime configuration reports the exact
   model, effort, and context above. In Copilot CLI, require the
   `subagent.configured` event to contain the expected `model`,
   `reasoningEffort`, and `contextTier`; a successful start alone is
   insufficient.
3. Retain the same GPT-5.6 Sol agent through first-pass research,
   cross-critique, and final adjudication. The parent coordinator orchestrates
   the workflow but does not replace Sol's evidence-based ruling with its own
   model judgment.
4. The first-pass researchers must work independently. Do not reveal either
   model's conclusions to the other before both initial reports are complete.
5. Give both researchers the same normalized question, scope, repository/live
   safety constraints, evidence requirements, and acceptance criteria.
6. Identify each report by model. Do not call one generic "the other agent."
7. If either required model fails, returns no useful report, or resolves to a
   different configuration, retry that model once with the complete prompt. If
   it still fails, report the actual failure and label the result incomplete
   rather than claiming tandem consensus.

## Agent selection

- Use a `research` agent for read-only web, GitHub, standards, provider,
  technology, or external-source research.
- Use a `general-purpose` agent for deep local repository/runtime/database
  analysis that requires the full toolset, and whenever the same explicitly
  pinned Sol agent may proceed from research into implementation.
- Use `code-review` only when a concrete diff already exists and the requested
  task is specifically a diff review.
- Independent first-pass researchers must not mutate anything before
  adjudication, even when their agent type exposes mutation tools. This
  preserves an unbiased evidence baseline without removing the tandem skill's
  ability to create or edit during approved implementation.

Launch both independent first-pass agents in parallel when the environment
supports it. In Copilot CLI, use background agents because the required
cross-critique needs follow-up turns through `write_agent`, which is unavailable
for synchronous agents. Wait for completion notifications rather than polling,
then read both reports before sending either cross-critique. Use synchronized
parallel calls only in runtimes that support follow-up turns on those agents.

## Required workflow

### 1. Normalize the research contract

Before delegation, turn the request into one shared brief:

- question or decision to make;
- in-scope and out-of-scope surfaces;
- repository paths, branches, diffs, runtime targets, or external sources;
- current facts and prior decisions that must not be rediscovered incorrectly;
- safety constraints and prohibited mutations;
- evidence/citation requirements;
- measurable acceptance, rejection, or confidence gates;
- requested output and whether implementation is approved.

When details are missing, make conservative assumptions for research. Enable
implementation only when the operator's request includes a fix, change,
implementation, or equivalent follow-through.

### 2. Run independent first-pass research

Prompt each model to:

- follow the model-specific search and mutation mapping in the Tool capability
  contract, using only names present in its actual tool list;
- investigate the complete shared scope independently;
- inspect primary evidence rather than repeating the prompt;
- separate verified facts, inferences, hypotheses, and unknowns;
- identify strengths, weaknesses, failure modes, alternatives, and tradeoffs;
- rank findings by impact, confidence, urgency, and implementation cost;
- cite repository files/lines, commands/logs/queries, or external URLs;
- state what evidence would falsify each important conclusion;
- make a clear recommendation without assuming the other model agrees.

Do not split one continuous question into artificial halves. The value of this
skill is independent overlap on the same important decision.

### 3. Build the comparison matrix

After both initial reports complete, the parent coordinator constructs a
claim-by-claim matrix:

| Claim / decision | Sol evidence and view | Opus evidence and view | Agreement | Confidence | Adjudication needed |
|---|---|---|---|---|---|

Classify each material item as:

- **agreed and verified**;
- **agreed but weakly evidenced**;
- **disputed interpretation**;
- **factual conflict**;
- **unique high-value finding**;
- **unknown / needs probe**.

Agreement is not proof. Prefer primary evidence over model confidence or
majority.

### 4. Cross-critique

Send each researcher the other model's initial findings and the comparison
matrix. Ask each to:

- identify factual mistakes, unsupported leaps, missed evidence, and hidden
  assumptions in the other report;
- defend or revise its own disputed claims;
- propose the smallest safe probe that resolves each remaining conflict;
- distinguish substantive disagreement from different wording.

Use the same existing agent conversations for this second turn when possible.
Do not launch replacement agents merely to restate the same critique.

### 5. Resolve evidence gaps and adjudicate

The parent coordinator gathers evidence, then the retained GPT-5.6 Sol agent
owns final adjudication:

1. The coordinator runs the smallest safe read-only probes needed to resolve
   factual conflicts.
2. The coordinator rechecks citations and reproduces important measurements.
3. Send the resolved evidence, comparison matrix, and remaining conflicts to
   the retained Sol agent.
4. The Sol agent rejects attractive conclusions that fail evidence or safety
   gates and produces the final ruling.
5. The coordinator relays that ruling without substituting a new model
   judgment, preserves unresolved uncertainty explicitly, and still enforces
   higher-priority safety and repository rules.
6. Do not fabricate consensus, measurements, citations, or tool failures.

For live systems, follow the active repository's safety rules before probes.
For web/UI claims, use real browser measurements. For database/runtime claims,
use actual queries, commands, logs, or metrics.

### 6. Produce the tandem report

Use this structure unless the operator requests another format:

1. **Executive decision** - the practical answer and confidence.
2. **What both models agree on** - verified consensus only.
3. **Where they disagreed** - both positions and Sol's evidence-based ruling.
4. **Unique findings** - valuable items found by only one model.
5. **Rejected hypotheses** - what was considered and why it failed.
6. **Prioritized work** - ordered phases/tasks, dependencies, risks, expected
   outcomes, validation, and rollback.
7. **Open evidence gaps** - exact unknowns and the probes needed.
8. **Implementation gate** - approved, not requested, or blocked.

For audits, include a concise quality assessment such as
`great / good / okay / poor / bad` when useful.

## Sol-adjudicated hierarchical implementation contract

If implementation follows the research:

1. **GPT-5.6 Sol owns tandem adjudication; the resolved project pipeline owns implementation.**
2. Code changes, tests, builds, benchmarks, migrations, deployments, restarts,
   production probes, rollback, commits, and final validation must first resolve
   the exact project opportunity through `budget-workflow`. The tandem
   research profile is not implementation residency. Known-pattern work uses
   the opportunity's medium coordinator/reviewer and any explicitly qualified
   staging-only cheap worker. Never delegate implementation to a `research` or
   `code-review` agent.
3. Claude Opus 5 may perform read-only research, critique, design review, or
   post-change review, including read-only inspection commands. It must not
   edit files, run commands with side effects, own tests/builds/benchmarks,
   deploy, or approve production mutation.
4. Implementation must follow the active repository instructions and use the
   smallest targeted validation that proves the requested outcome.
5. A research recommendation is not authorization for destructive or live
   changes. Respect repository/operator gates.
6. Overall model identity never bypasses routing. If the current Sol,
   HydraFusion, or other coordinator exactly matches the resolved project role,
   it may fill that role; otherwise it dispatches the pinned profile. An
   unqualified current model may orchestrate and read evidence but gains no
   semantic, repository-apply, live, release, or destructive authority.
7. Sol max/long-context may return only for
   `tandem-consequential-final-review-conflict`, after an evidence-bound trigger
   receipt linked to the preceding deterministic/team receipt. Task terminology,
   complexity, or the fact that tandem research ran is not that trigger.
8. The implementation owner must use the mutation tool actually present
   in its tool list. In Copilot CLI this is `apply_patch`, which performs file
   creation (`Add File`), editing (`Update File`), and deletion (`Delete File`).
   Claude's `create` and `edit` tools are not Sol fallbacks.
9. Model role is separate from side-effect authorization. Repository apply
   needs explicit operator apply authorization; GitHub, live system,
   production, release, database, and destructive effects retain their
   project/operator gates and deterministic machines.

## Prompt template for each independent researcher

```text
You are the <GPT-5.6 Sol | Claude Opus 5> member of an independent tandem
research pass.

Research question:
<normalized question>

Scope:
<paths/systems/sources>

Known facts and constraints:
<facts, safety rules, no-mutation rules>

Required evidence:
<citations, measurements, tests, logs, queries>

Decision gates:
<accept/reject/confidence criteria>

Tool contract:
- Use only tools present in your actual tool list.
- GPT-5.6 Sol searches with `rg`/`glob` and reads with `view`.
- Claude Opus 5 searches with `grep`/`glob` and reads with `view`.
- Search only explicit existing in-scope paths. Resolve uncertain paths with
  `glob`; do not recursively search the whole home directory.
- Built-in `rg`/`grep` do not support regex look-around. Rewrite the pattern or
  use a read-only `/usr/bin/rg --pcre2` fallback through approved `bash`.
- This first pass is read-only. Do not call `apply_patch`, `create`, or `edit`.

Work independently. Do not assume the other model's conclusions. Separate
facts, inferences, hypotheses, and unknowns. Report prioritized findings,
tradeoffs, falsification evidence, and a clear recommendation. Do not modify
anything.
```

## Completion gate

Tandem research is complete only when:

- both required independent reports exist;
- both researchers' resolved model, effort, and context match the required
  contract;
- cross-critique is complete;
- material factual conflicts are resolved or explicitly left open;
- citations/measurements for the final decision are verified;
- the retained Sol agent has produced the final adjudication;
- the final report distinguishes consensus, Sol adjudication, and
  uncertainty;
- any follow-on implementation is clearly gated and assigned only to an
  exact-pinned GPT-5.6 Sol `general-purpose` agent.
