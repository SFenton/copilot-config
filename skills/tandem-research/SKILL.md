---
name: tandem-research
description: Independent GPT-6 Astra and Claude Opus 5 research, cross-critique, evidence adjudication, consensus reporting, and Astra-only implementation. Use for tandem research, deep audits, competing hypotheses, architecture decisions, incident analysis, high-stakes second opinions, or research-led implementation in any repository.
allowed-tools:
  - write
---

# Tandem Research Skill

Use this global skill when the operator invokes `/tandem-research`, asks for
Astra/Opus tandem analysis, requests two independent frontier-model opinions,
or wants a high-confidence research/audit decision before implementation.

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
| GPT-6 Astra | `rg`, `glob` | `view` | `apply_patch` |
| Claude Opus 5 | `grep`, `glob` | `view` | `create`, `edit` |

The Claude mutation tools may be exposed by a `general-purpose` agent, but the
tandem contract keeps Claude read-only. They are not aliases that Astra can
call. Likewise, Claude must not call Astra's `rg` or `apply_patch` names.

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
| Primary researcher and final adjudicator | `gpt-6-astra` | `max` | `long_context` |
| Independent second researcher | `claude-opus-5` | `max` | `long_context` |

Requirements:

1. Launch both researchers explicitly with the exact model, effort, and context
   settings above. Never silently substitute another model.
2. Verify that each launch's resolved runtime configuration reports the exact
   model, effort, and context above. In Copilot CLI, require the
   `subagent.configured` event to contain the expected `model`,
   `reasoningEffort`, and `contextTier`; a successful start alone is
   insufficient.
3. Retain the same GPT-6 Astra agent through first-pass research,
   cross-critique, and final adjudication. The parent coordinator orchestrates
   the workflow but does not replace Astra's evidence-based ruling with its own
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
  pinned Astra agent may proceed from research into implementation.
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

| Claim / decision | Astra evidence and view | Opus evidence and view | Agreement | Confidence | Adjudication needed |
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

The parent coordinator gathers evidence, then the retained GPT-6 Astra agent
owns final adjudication:

1. The coordinator runs the smallest safe read-only probes needed to resolve
   factual conflicts.
2. The coordinator rechecks citations and reproduces important measurements.
3. Send the resolved evidence, comparison matrix, and remaining conflicts to
   the retained Astra agent.
4. The Astra agent rejects attractive conclusions that fail evidence or safety
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
3. **Where they disagreed** - both positions and Astra's evidence-based ruling.
4. **Unique findings** - valuable items found by only one model.
5. **Rejected hypotheses** - what was considered and why it failed.
6. **Prioritized work** - ordered phases/tasks, dependencies, risks, expected
   outcomes, validation, and rollback.
7. **Open evidence gaps** - exact unknowns and the probes needed.
8. **Implementation gate** - approved, not requested, or blocked.

For audits, include a concise quality assessment such as
`great / good / okay / poor / bad` when useful.

## Astra-only implementation contract

If implementation follows the research:

1. **GPT-6 Astra owns all implementation decisions and side effects.**
2. Code changes, tests, builds, benchmarks, migrations, deployments, restarts,
   production probes, rollback, commits, and final validation must be performed
   by a `general-purpose` agent launched explicitly with `model: gpt-6-astra`,
   `reasoning_effort: max`, and `context_tier: long_context`. Verify the
   resolved runtime configuration before mutation. Never delegate
   implementation to a `research` or `code-review` agent.
3. Claude Opus 5 may perform read-only research, critique, design review, or
   post-change review, including read-only inspection commands. It must not
   edit files, run commands with side effects, own tests/builds/benchmarks,
   deploy, or approve production mutation.
4. Implementation must follow the active repository instructions and use the
   smallest targeted validation that proves the requested outcome.
5. A research recommendation is not authorization for destructive or live
   changes. Respect repository/operator gates.
6. Reuse the retained Astra agent when it is a `general-purpose` agent with the
   required mutation tool. Otherwise launch another `general-purpose` Astra
   agent with the exact pins above and give it the adjudicated evidence.
7. The Astra implementation agent must use the mutation tool actually present
   in its tool list. In Copilot CLI this is `apply_patch`, which performs file
   creation (`Add File`), editing (`Update File`), and deletion (`Delete File`).
   Claude's `create` and `edit` tools are not Astra fallbacks.
8. If the Astra implementation agent lacks mutation tools or permission,
   return ownership to the coordinator, which must launch or reuse a qualifying
   exact-pinned Astra agent. If none is available, report a blocker rather than
   allowing an unpinned parent agent to implement.

## Prompt template for each independent researcher

```text
You are the <GPT-6 Astra | Claude Opus 5> member of an independent tandem
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
- GPT-6 Astra searches with `rg`/`glob` and reads with `view`.
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
- the retained Astra agent has produced the final adjudication;
- the final report distinguishes consensus, Astra adjudication, and
  uncertainty;
- any follow-on implementation is clearly gated and assigned only to an
  exact-pinned GPT-6 Astra `general-purpose` agent.
