---
name: tandem-research
description: Explicit-only packet-bound Sol/Astra tandem reasoning with deterministic evidence preparation, cross-critique, and Sol adjudication. Follow-on implementation returns to budget-workflow.
---

# Tandem Research Skill

Use this global skill only when the operator explicitly invokes
`/tandem-research`, explicitly asks for Sol/Astra tandem research, or explicitly
requests two independent frontier researchers. Ordinary audits, architecture
discussions, or requests for "high confidence" do **not** invoke this skill.
If the operator says not to use tandem, this skill is excluded.
`user-intent-acceptance` is a separate packet-only coverage gate and is not
served by tandem research.

Canonical source: `https://github.com/SFenton/copilot-config`.

## Core contract

1. Tandem is **packet-only reasoning orchestration**. Deterministic evidence
   collection happens outside the frontier models.
2. The first-pass Sol and Astra legs receive the **same frozen packet hash** and
   **no tools**.
3. Frontier models do research reasoning only. They do not read repositories,
   browse the web, query history, use shell commands, edit files, run tests, or
   approve implementation, release, or live mutation.
4. Independent findings must complete before cross-critique.
5. Evidence gaps are fulfilled exactly once outside frontier, then identical
   delta packets are sent to both researchers.
6. Implementation always hands back to `budget-workflow` and the project's
   normal `gpt-5.6-luna` medium/default owner flow.

## Required profiles

The standard tandem pair is:

| Role | Model | Effort | Context |
|---|---|---|---|
| Primary researcher and final adjudicator | `gpt-5.6-sol` | `max` | `default` |
| Independent secondary researcher | `gpt-6-astra` | `medium` | `default` |

Default tandem context remains `default`; Sol's `max` effort does **not**
authorize `long_context` by itself. Opus or generic Claude pins are not active
for tandem and any stale Opus tandem receipt or orchestration request fails
closed.

## Deterministic prerequisites

Before any frontier reasoning:

1. Normalize one shared question, scope, safety boundary, and output contract.
2. Prepare deterministic repository/external/hybrid/history evidence.
3. Freeze the evidence into a versioned packet and create its evidence-packet
   receipt.
4. Create exact frontier-dispatch receipts for Sol and Astra.
5. Create a tandem-pair receipt that binds both dispatch receipts to the
   identical packet hash.
6. If exact reader or packet helpers are available, use them; otherwise the
   current owner prepares the packet directly while preserving the same
   deterministic, tool-free frontier boundary.

Use the deterministic orchestration helpers in
`scripts/orchestration.mjs` to validate these bindings. Do not launch the
frontier legs until the receipts and packet hashes align exactly.

## Required workflow

### 1. Independent first pass

- Send the same normalized question and the same packet hash to Sol and Astra.
- Require strict JSON only: `findings`, `blocked`, or `evidence-gap-request`.
- Every finding citation must reference packet source IDs only.
- Do not reveal either model's conclusions to the other before both initial
  reports complete.

### 2. Comparison matrix

Build a deterministic matrix with:

| Claim / decision | Sol | Astra | Agreement | Confidence | Adjudication needed |
|---|---|---|---|---|---|

Classify each material point as:

- agreed and verified;
- disputed interpretation;
- unique high-value finding;
- unknown / needs probe.

### 3. Cross-critique

Each model critiques the other's findings **after** both first-pass reports
exist. The critique is still packet-only and tool-free.

### 4. Evidence gaps

If either model returns `evidence-gap-request`:

1. Merge the exact requests deterministically.
2. Cap the loop at two rounds and six requests per round.
3. Fulfill the gaps outside frontier.
4. Freeze one identical delta packet.
5. Re-bind both legs to that delta packet hash.

### 5. Sol adjudication

Sol remains the final adjudicator. The adjudication leg is packet-only,
reason-only, and tool-free. The coordinator relays Sol's evidence-based ruling
without substituting a new model judgment.

## Safety and privacy

- No repository, shell, browser, session-history, MCP, web, GitHub, or live
  tools in frontier tandem legs.
- No raw session IDs in packets; only pseudonymous refs.
- No raw prompts/session text in durable fixtures or logs.
- No automatic implementation authority, repository apply, release, or live
  mutation from tandem receipts.
- No automatic tandem based only on importance or risk.

## Completion gate

Tandem research is complete only when:

1. Sol and Astra each produced an initial strict result from the identical packet
   hash.
2. Cross-critique completed.
3. Any evidence gaps were fulfilled outside frontier with identical delta packet
   hashes.
4. Sol adjudication completed or the remaining conflict is explicitly blocked.
5. The final handoff clearly separates consensus, disputes, adjudication, and
   follow-on implementation ownership.
