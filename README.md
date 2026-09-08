# Copilot Config

Version-controlled personal Copilot skills and deterministic budget/evidence
tooling. Node 22+, Git and ripgrep are required; model calls additionally require
an authenticated Copilot CLI. Run `npm ci` in this checkout for evidence tools.
No Portal account, external inference endpoint, database server or persistent
extension runtime is required.

The evidence service uses the MCP SDK/Zod for three typed tools, linkedom for
inert HTML extraction, ipaddr.js for public-address checks, WASM tree-sitter
for TS/TSX/JS/Python/C# syntax units, and php-parser for PHP. Exact dependency
versions are locked. Tree-sitter 0.20.8 matches the bundled grammar ABI; its PHP
scanner failed on real source, so PHP deliberately uses its native JS parser.

## Skills and ownership

- `budget-workflow`: deterministic-first routing, exact evidence, one execution
  owner, bounded revisions, project-owned tests, and explicit release gates.
- `tandem-research`: preserved Sol/Opus max/long-context protocol with Sol-only
  implementation, **explicit invocation only**. Complexity alone no longer
  triggers it.

HydraFusion can be the user-selected coordinator. Do not nest it under itself
or add an automatic tandem layer. Its critique pattern is not two independent
research investigations. Unproven high-risk/novel tasks keep frontier reasoning.
Model choice is advisory; repository safety and explicit specialist pins win.

The [four-arm research comparison](evals/factorial-results.md) found Astra low
direct faster but modestly more expensive than Sol max direct, while the tested
worker/packet handoff raised total cost. Those are bounded-task findings, not an
automatic model-default or full-research-equivalence promotion.

## Install and rollback

```bash
node scripts/install.mjs
# If replacing links from a known previous checkout, explicitly name that root:
node scripts/install.mjs "$HOME/repos/copilot-config"
```

The installer links both skills and installs the native large-read hook plus
`instructions/budget-workflow.instructions.md` as regular files into
`$COPILOT_HOME` or `~/.copilot`. It refuses real-file/directory collisions and
unknown symlinks. It writes a rollback receipt before changes. Existing
unrelated skills, hooks, model defaults, credentials and permissions are not
modified. Links point at this checkout: retain the worktree until promoted.

The short personal instruction makes budget-workflow the default for substantive
engineering/research tasks: ask normally, without explicitly naming the skill.
It applies across ordinary checkouts as well as budget worktrees. Without a
project adapter, the assistant uses native project rules/direct tools; the full
phase-aware project integration still requires that project's adapter changes.
Small questions and known commands do not require workflow ceremony.

This is default instruction-based behavior, not an installed `/plugin` package,
an automatic interactive model switch or a hard billing/security interceptor.
Start a fresh session to load the new instructions, skill descriptions and hooks.
Existing sessions may retain old context. To restore the previous installation:

```bash
node scripts/install.mjs --rollback /absolute/path/to/budget-install-TIMESTAMP.json
```

The installer writes regular hook JSON; skill directories remain symlinked.
Runtime enforcement is not certified across launch contexts. A minimal
standalone Git fixture with an absolute command hook denied the large read, but
installed user/worktree registrations did not consistently fire, including
tests with normal permissions. Pre-approved runs also passed the read.
Project registrations are supplied for compatible runtimes, not as a universal
guard. The deterministic packet command enforces its own limits independently.
When invoked, the hook denies unbounded `view`/`Read` operations on files over 350 lines.
Exact ranges of at most 350 lines and required instruction contracts pass.
`[start,-1]` is not bounded. It recommends direct ranges before delegation.
This is a spend guardrail, not a security barrier: shell reads, disabled hooks,
runtime timeouts, or alternative tools can bypass it. Do not deliberately
bypass it; use the source ranges needed for real reasoning and edits.
The hook returns `{}` on allowed reads so normal permissions remain in force.

## Deterministic CLI

```bash
node skills/budget-workflow/scripts/budget.mjs validate /path/to/project
node skills/budget-workflow/scripts/budget.mjs audit /path/to/project
node skills/budget-workflow/scripts/budget.mjs route /path/to/project task.json
node skills/budget-workflow/scripts/budget.mjs packet /path/to/project ranges.json
node skills/budget-workflow/scripts/budget.mjs evaluate outcomes.json
node skills/budget-workflow/scripts/budget.mjs estimate scenario.json
npm test
```

The project supplies `.github/agent-budget.json`:

```json
{
  "version": 1,
  "project": "example",
  "instructions": ["AGENTS.md"],
  "riskTerms": ["publication", "ontology"],
  "gates": ["Affected existing tests; explicit release authorization"]
}
```

Instruction paths must exist inside the repository. The adapter describes
gates, not executable permissions. Each project owns its targeted test
selection, research evidence, live safety, release and rollback rules.

Optional cross-project regression uses `BUDGET_PROJECT_MANIFEST` with `cases`
containing `id` and `root`. For relocated HA/EverShelf instruction checks, pin
`instructionBaselineRef` to the pre-migration commit so the preservation check
remains reproducible after committing or merging (the pre-commit default is
`HEAD`). Keep local manifest paths and raw evidence outside the repository.

`task.json`:

```json
{
  "question": "Find the existing helper signature",
  "kind": "lookup",
  "risk": "low",
  "novel": false,
  "evidenceComplete": true,
  "deterministic": true
}
```

Kinds: lookup, implementation, debugging, research, test, release.
Risk: low, medium, high, unknown. Unknown/high risk, novelty, risk terms and
incomplete reasoning evidence escalate conservatively. Simple known commands
require no LLM. Complete supplied-evidence extraction can use GPT-5.4 mini.
This legacy broad-task router retains conservative Astra high research advice
and points research to the evidence-mode planner below. Do not chain the two as
successive model gates. There is no automatic draft worker. Sonnet 5 is not
qualified for standalone research decisions: the source-backed comparison
found material gaps. See [research qualification](evals/research-qualification.md).
These are conservative routing choices, not certified equivalence to tandem.
HydraFusion is the coordinator preference; the route also names Sonnet 5 as an
explicit fallback. Report a runtime availability failure before using fallback.

`ranges.json`:

```json
[{"file":"src/helper.ts","start":10,"end":40}]
```

Packets preserve numbered source and full-file SHA-256, reject path/symlink
escapes and common secret filenames, and enforce a compact-JSON byte cap
(24,000 default; 200,000 maximum). The source file limit is 2 MB. This is not
a content-classification or secret-scanning guarantee: inspect supplied paths
and sanitize content. Never use a packet to work around content exclusions.
Token counts from `audit`/`packet` are labelled `chars/4` estimates, not billing.
Audit distinguishes always-loaded roots, scoped rules and on-demand skills;
it reports duplication, missing Markdown links and expensive model pins without
deleting or downgrading any instructions.

## Three evidence modes, one owner

The active research architecture is **deterministic retrieval plus one owner**,
not Portal-style mandatory worker handoffs. The tested reader/packet workflow
increased total cost; smaller frontier context alone was a misleading metric.
Use native direct tools for tiny tasks. For broader research:

```bash
node skills/budget-workflow/scripts/evidence/research.mjs plan task.json /path/to/project
node skills/budget-workflow/scripts/evidence/research.mjs init task.json /path/to/project /private/new-session /private/cache
node skills/budget-workflow/scripts/evidence/research.mjs evidence /private/new-session find '{"scope":"repository","query":"knownSymbol"}'
node skills/budget-workflow/scripts/evidence/research.mjs evidence /private/new-session open '{"path":"src/helper.ts","symbol":"knownSymbol"}'
```

`init` and `evidence` reuse the current owner and launch **zero models**.
For an explicit neutral single-owner run, replace `init` with `run`. Use root
`-` for external-only questions. `run` is research-only and exposes just the
session evidence MCP, not shell, native filesystem, arbitrary URL or history
tools. Each output includes broker state, sources, actual usage and a reference
appendix. Broker validity establishes tool sequence/source access, not factual
accuracy, citation sufficiency or research equivalence.

| Mode | Context and flow |
|---|---|
| Repository | Full adapter-allowed source tree; complete small files and relevant syntax units. No web. |
| External | No repository root/context; approved public queries/documentation roots only. |
| Hybrid | Small opened-source local contract, external gaps, then local applicability. |

Guides with input examples: [repository](skills/budget-workflow/modes/repository.md),
[external](skills/budget-workflow/modes/external.md),
[hybrid](skills/budget-workflow/modes/hybrid.md).
`auto` requires explicit `repositoryRelevant` and `externalRequired` booleans;
otherwise it requests a bounded scope probe instead of guessing absence.
Risk is separate: high/unknown risk, novelty and matching risk terms retain
frontier reasoning. User-selected profiles are explicit overrides recorded by
the runner, not implicit interactive model changes. No automatic tandem,
cheap-reader agent or second HydraFusion layer.

| New single-owner run | Default profile |
|---|---|
| Bounded low/medium risk, cost objective | Sol high / default context |
| Bounded low/medium risk, speed objective | Astra low / default context |
| High/unknown risk, novelty or project risk terms | Astra high / default context |

These are pragmatic operating defaults, not model-quality certification. The
[mode calibration](evals/mode-results.md) retained all six selected candidate
answers above its floor and reduced research credits, but did not reduce total
tokens. Explicit evaluation pins are not proof that a high-risk project class
has been promoted to the cheaper default.

Adapters add `evidencePolicy.always`, `phases.research/implementation/validation/
release`, and `content.allowPaths/denyPaths/maxFileBytes`. Research context stays
small; implementation/release still require their full applicable project
contracts. These strings select context, not permissions or executable gates.

### Retrieval, freshness and limits

Repository discovery examines tracked/untracked allowed source, respects ignore
and denied/secret paths, rejects escaping symlinks and reports searched/skipped/
ranked coverage. Fixed-string discovery inspects at most 200 candidate matches;
it is not exhaustive semantic analysis. Declaration ranking and known path/
symbol opens reduce irrelevant reads. Units include guards/decorators and
module assignments. Parse failure is explicit, not a fabricated AST.
Source IDs bind path, content hash and extractor version; dirty changes require
rediscovery. Syntax metadata is cached without a duplicate private source body.

External discovery supports approved documentation roots, public GitHub
repository search (`gh api`, public results only), and Crossref metadata (no
abstracts). The model chooses preapproved query IDs; private text cannot become
an outbound query. Exact hosts and redirect destinations must be approved.
HTTPS retrieval checks/pins public DNS addresses, rejects URL credentials/IP
literals, and bounds response bytes, decompression and time. Static HTML/plain
text only: no browser JS, PDFs, authenticated sites or general web search.
An unsupported source is a reported gap, not a silent provider fallback.
Bing RSS was rejected because its reuse terms do not permit this use.

Web references retain source URL, content hash, extractor version, paragraph IDs
and freshness. Cache hits/revalidation/request counts are recorded. Expired or
changed evidence is not silently substituted. Retention defaults to metadata;
`persistTextHosts` must explicitly approve storing document text. Returned
excerpts still appear in CLI transcripts. Cache is local and caller-owned;
per-session limits do **not** impose a global disk quota or automatic eviction.
Use a dedicated private cache and remove explicitly identified stale session
directories when no longer needed; never broad-delete a shared directory.

Hybrid orientation reserves external headroom: at most eight repository
operations, or one-third of a smaller session budget, before source-backed
contract/external transition. Repository applicability reads resume after web
evidence. The owner must still open actual authoritative pages: reading an
index is not proof of a technical claim.

Unchanged evidence is deduplicated unless `reopen`/`refresh` is explicit.
Serialized lean output is bounded below the CLI's large-tool-output threshold;
oversized results ask for narrower evidence and are not falsely marked read.
Every operation reports remaining budget. Exhaustion persists across CLI calls
and means finalize with gaps, not repeatedly retry. Blank optional fields are
normalized; nonempty private web query text is still rejected.

## Bounded leaf runs and accounting

`run-leaf.mjs` accepts a JSON request and a **new** output directory:

```json
{
  "prompt": "Answer this supplied-evidence question. Do not use tools.",
  "sanitized": true,
  "model": "gpt-5.4-mini",
  "effort": "medium",
  "context": "default",
  "maxCredits": 30,
  "timeoutSeconds": 120,
  "ledger": "/absolute/private/path/month-ledger.json"
}
```

```bash
node skills/budget-workflow/scripts/usage.mjs init /private/month-ledger.json 300 0
node skills/budget-workflow/scripts/run-leaf.mjs request.json /private/new-run
node skills/budget-workflow/scripts/usage.mjs summary /private/new-run
```

The ledger's limit and initial spend are explicit caller inputs. Its scope is
admitted runs only: other projects/clients need to use the same ledger or their
spend must be supplied separately. It is not the account billing system.
The UTC month must match; initialize a new file for a new month. Reservations
serialize via an exclusive lock; contention fails closed rather than launching
unaccounted work. Never remove a live lock. A crash/missing usage retains its
reservation until the operator reconciles the actual run; no automatic refund.

The CLI cap is soft (minimum 30), not a hard monthly guarantee. Reserve the
whole per-run cap before launch, settle actual reported credits after return,
and block future admission after overshoot. No automatic model retries or cap
increases. Wrapper termination is bounded; OS-level sandboxing remains separate.

The launcher owns a cancellable process group/tree rather than killing only
the outer CLI loader. Descendant termination and the actual CLI loader grouping
were exercised on Linux; Windows uses PID-scoped `taskkill /T /F` but was not
runtime-tested here. Interrupted runs may still lack final usage, in which case
reservations remain held until actual accounting is recovered.

### Important installed-CLI isolation behavior

CLI 1.0.83 treated `--available-tools=` as its normal tool set, not an empty
set. The runner therefore allows only the CLI-documentation schema and denies
that tool, shell, writes and URLs. All configured MCPs are disabled, custom
repository instructions and remote export are disabled, and the working
directory is the isolated evidence directory. Any tool request or unexpected
tool schema makes the run incomplete. This is a supplied-evidence leaf,
not a general coding agent. Repository safety material must be included in
the supplied evidence whenever the question needs it.

The output includes request hash, runtime, requested model profile, tool
isolation evidence, answer, raw events, errors and usage. Do not feed full raw
event logs back into a model: they contain bulky opaque runtime fields.

Research evaluation may explicitly set `toolMode: "research"` and an absolute
`workspace` containing a hash-bound `corpus.json`. This exposes only read/search
tools, disables implicit temporary-directory access, and audits every requested
path plus corpus integrity. The mode is opt-in and is not a general permission
grant. A failed out-of-scope attempt invalidates the run, even if it read no data.

Use `tokenDetails`' disjoint input/cache-read/cache-write/output counts and
`totalNanoAiu / 1e9` credits. Never add `agentMetrics`/`modelMetrics` to the
already aggregated total, or mistake premium-request multipliers for credits.
An unavailable model may explicitly report zero calls/usage without token
details; it is still a failed run. Missing or invalid telemetry otherwise fails
closed. Raw counters are retained for audit.

HydraFusion may be available through the interactive session's task launcher
but unavailable to a standalone `copilot --model hydrafusion --experimental`.
Do not infer one transport's availability or accounting from the other.

## Quality gates and experiments

`evaluate` accepts one project/task class, margin <=0.05 and paired cases:

```json
{
  "project": "example",
  "taskClass": "retrieval",
  "margin": 0.05,
  "cases": [{
    "id": "case-1",
    "inputHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "heldOut": true,
    "independentReview": true,
    "baseline": {"score": 1, "complete": true, "criticalFailure": false},
    "candidate": {"score": 1, "complete": true, "criticalFailure": false}
  }]
}
```

This example deliberately **does not promote**: one case is insufficient.
The gate requires >=30 unique frozen inputs, zero critical/missing results, independent review,
held-out inputs, and a one-sided 95% distribution-free paired-score bound above
the chosen noninferiority margin. The bound is conservative: 30 is a minimum,
not sufficient statistical power; identical scores need about 2,397 cases for
a 5-point Hoeffding margin. A domain-specific paired statistical analysis can
be conducted externally, but this tool must not silently loosen its gate.
Imported flags/scores are attestations, not cryptographic proof of independent
review. Keep underlying test results, source evidence and blinded assessments.
Universal research equivalence cannot be guaranteed by any finite smoke suite.

The separate `evals/research.mjs` benchmark evaluates actual read/search research
inside frozen source corpora with hidden criteria, sealed prompts, and anonymous
paired assessment. Paragraph IDs replace unreliable model-copied quotations.
It preserves failed attempts and assessor disagreement, counts independent
source families rather than rubric rows, and reports exact one-sided regression
risk bounds. It never relabels a single-model reference as a tandem baseline.

`pilot.mjs` prepares frozen, visible supplied-evidence retrieval cases, runs
baseline/candidate profiles, supports one explicit schema revision and reports
all-leg cost. The fixture shape contains `cases` with `id`, `root`, `question`,
`shape`, `expected`, and exact `ranges`; its `ledger` is shared across cases.
The baseline is single Astra max/long-context with full source/root instructions,
not a rerun of tandem. Neither results nor prompt tuning are held-out promotion
evidence. `revise` retains and charges the initial failed attempt.

```bash
node skills/budget-workflow/scripts/pilot.mjs prepare manifest.json /private/pilot
node skills/budget-workflow/scripts/pilot.mjs run /private/pilot case-id
node skills/budget-workflow/scripts/pilot.mjs revise /private/pilot case-id
node skills/budget-workflow/scripts/pilot.mjs report /private/pilot case-id
```

`estimate` takes `baseline` and `candidate` leg arrays. Each leg has `count`,
disjoint `input`, `cached`, `cacheWrite`, `output`, and `rates` with the same
four keys, priced per million tokens. Require `rateUnit` and `assumptions`.
Include orchestration, research, critique, implementation, retries, tests,
release and fallback legs. A long-context selection alone does not mean the
actual prompt crosses the provider's high-context pricing threshold.

## Evidence and design sources

- [Spotify article](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90):
  frontier-context savings, not complete billing or research parity.
- [Shunt benchmarks](https://github.com/spotify/portal-ai-plugins/blob/main/plugins/shunt/evals/benchmarks.json):
  four fixture scenarios, chars/4 approximation.
- [HydraFusion announcement](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/):
  medium-effort offline comparisons, first-turn preview focus.
- [Native hook contract](https://docs.github.com/en/copilot/reference/hooks-reference).
- [Current pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).

Implementation is independent; no Portal source code was copied and no private
project material is sent to Portal. Specialized legacy skill pins are preserved
until their own evidence supports migration.
