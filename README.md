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

- `budget-workflow`: deterministic-first routing, exact evidence, project-tuned
  medium coordination, one-revision bounded workers, explicit trust tiers, and
  deterministic release gates.
- `tandem-research`: preserved Sol/Opus max/long-context research/adjudication
  protocol, **explicit invocation only**. Follow-on implementation returns to
  the hierarchical project route; complexity alone does not trigger tandem or
  max-resident implementation.

HydraFusion can be the user-selected coordinator. Do not nest it under itself
or add an automatic tandem layer. Its critique pattern is not two independent
research investigations. Unproven high-risk/novel tasks keep frontier reasoning.
Overall model identity is not authority. Sol, HydraFusion, or another current
model may fill a role only when it exactly matches that project's resolved pin;
otherwise it may orchestrate/read while the router dispatches the pinned role.
Repository safety, operator authorization, and explicit specialist pins win.

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

The installer links both skills and installs the native large-read and
continuous-improvement lifecycle hooks plus
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
For substantive project tasks, the installed opportunity planner still runs
when the current branch predates the routing-policy files. It may read the one
valid policy bundle from an already-fetched local default-branch ref without
fetching or modifying the worktree. Its result is advisory routing evidence
only and grants no repository-apply, live, release, destructive, production, or
other side-effect authority.

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

The continuous-improvement hook listens to `postToolUse`,
`postToolUseFailure`, `subagentStop`, `agentStop` and `sessionEnd`. It writes
user-local `0600` event shards under `$COPILOT_HOME/learning` containing only
stable trace/receipt hashes, normalized operation shapes, path categories,
result classes, timings and accounting metadata. It never persists raw
prompts, responses, source, tool results, commands, credentials or environment
values, and it never modifies a successful tool result. General-purpose agent
work is covered by actual parent tool events, receipt lineage and transcript
file metadata hashes; `subagentStop` is optional enrichment.

Projects opt in with `.github/agent-learning.json`. Existing branches and
worktrees that predate that file use one valid policy bundle from a local
default-branch ref; the hook never fetches or mutates the worktree. Learning
state is keyed by a hashed project and canonical repository identity so linked
worktrees share events and candidates without storing remote URLs or
credentials. The observer silently
no-ops below recurrence thresholds. At most one threshold-crossing candidate
can request one continuation, with durable recursion and `stop_hook_active`
guards. Real project policies keep automatic promotion disabled unless a
repository explicitly enables the narrow replay/review/value/scope/rollback
path for a zero/low-side-effect repository-local tool or skill.

Historical event imports can classify otherwise unhinted prompts with an
enabled opportunity:

```bash
node skills/budget-workflow/scripts/continuous-improvement.mjs \
  backfill-events /path/to/project /path/to/events.jsonl \
  --opportunity OPPORTUNITY_ID
```

The override is a non-authorizing workflow classification. Exact unique prompt
triggers take precedence; unknown and disabled IDs are rejected. Persisted
events record only that an operator/coordinator supplied the classification and
a stable hash, never raw classification text.

## Deterministic CLI

```bash
node skills/budget-workflow/scripts/budget.mjs validate /path/to/project
node skills/budget-workflow/scripts/budget.mjs audit /path/to/project
node skills/budget-workflow/scripts/budget.mjs route /path/to/project task.json
node skills/budget-workflow/scripts/budget.mjs packet /path/to/project ranges.json
node skills/budget-workflow/scripts/budget.mjs evaluate outcomes.json
node skills/budget-workflow/scripts/budget.mjs estimate scenario.json
node skills/budget-workflow/scripts/opportunities.mjs validate /path/to/project
node skills/budget-workflow/scripts/opportunities.mjs plan /path/to/project task.json
node skills/budget-workflow/scripts/continuous-improvement.mjs validate /path/to/project
node skills/budget-workflow/scripts/continuous-improvement.mjs status /path/to/project
node skills/budget-workflow/scripts/continuous-improvement.mjs backfill-events /path/to/project /path/to/events.jsonl
node skills/budget-workflow/scripts/improvement-replay.mjs replay candidate.json trajectories.json
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

## Bounded artifact staging

Repository adapters can opt specific low-risk non-research artifact classes into
staged worker generation with one reviewer-directed revision maximum:

```json
{
  "delegation": {
    "allowedClasses": ["scaffold", "test-generation"],
    "requireCleanTargets": true,
    "requireDeterministicValidator": true
  }
}
```

Run or inspect a reviewed job with:

```bash
node skills/budget-workflow/scripts/delegation.mjs plan job.json /path/to/project
node skills/budget-workflow/scripts/delegation.mjs run job.json /path/to/project /private/output pipeline-state.json
node skills/budget-workflow/scripts/delegation.mjs validate-staged job.json /path/to/project /private/output
```

Example reviewed job:

```json
{
  "opportunityId": "focused-tests",
  "kind": "bounded-artifact",
  "taskClass": "test-generation",
  "instruction": "Create the focused tests described by the supplied source and adjacent test.",
  "risk": "low",
  "novel": false,
  "evidenceComplete": true,
  "sanitized": true,
  "boundaries": {
    "research": false,
    "architecture": false,
    "ambiguous": false,
    "debugging": false,
    "security": false,
    "liveSystem": false,
    "release": false,
    "destructive": false,
    "semanticDocumentation": false
  },
  "deterministicValidator": true,
  "validatorId": "project-focused-test-validator",
  "inputs": [
    { "file": "src/value.ts", "start": 1, "end": 40 },
    { "file": "src/value.test.ts", "start": 1, "end": 60 }
  ],
  "outputs": ["src/new-value.test.ts"]
}
```

`opportunityId` is mandatory when the repository adapter names an opportunity
policy. The selected version 3 entry must contain exactly one matching
`cheap-worker` phase and worker candidate with the requested
`delegationClass`, an allowed provisional pin, an exact registered validator,
and an exact checked-in sandbox profile.
Owner, specialist, live, and release opportunities cannot enter the
artifact lane even if caller-supplied risk metadata is optimistic.

For version 3, `pipeline-state.json` contains the verified receipt array (or an
object with a `receipts` array) plus the exact workflow ID, base revision, and
scope hash. Every receipt must carry the same run/repository binding. Initial
generation requires the immediately preceding medium-coordinator dispatch
receipt. A second invocation is accepted only when the immediately preceding
medium-review receipt requests the one allowed revision and binds the first
worker receipt.

Before any worker launch, the executor rechecks the complete opportunity and
referenced-tool contract hash, exact ordered receipt prefix, canonical job,
source/evidence hashes, target state, locally pinned sandbox image, dependency
fingerprints, and runtime readiness checks. Those values are part of the scope
and acceptance bindings; an unavailable or changed validator environment fails
with zero worker model calls.

The worker receives only an exact evidence packet and returns strict JSON for
1-6 named files. It has no filesystem, shell, network, history, MCP,
instruction, or mutation tools. Production apply and automatic acceptance are
disabled. `run` creates staged, explicitly untrusted provisional output after a
static prohibited-capability scan and zero-model sandbox readiness preflight.
`validate-staged` copies the repository into
a disposable Docker workspace with no network, read-only container root,
dropped capabilities, no host environment, collateral-write detection and a
locally pinned image. The reviewed apply primitive additionally requires
full-repository/revision/scope-bound medium acceptance with exact resolved
configuration evidence plus separate operator repository-apply authorization,
verifies the repository is unchanged, applies exact targets, revalidates in a
fresh sandbox and restores exact bytes on failure. The public `apply` CLI
remains disabled. One reviewer-directed revision is permitted and must bind the
exact defect receipt; a second revision fails closed.

The historical six-case frozen study covered two scaffolds, two mutation-tested test
files, and two mechanical transforms. MAI Code 1.1 Flash passed 6/6 and reduced
marginal model credits by 94.6% and tokens by 25.0% versus Sol high within that
study, while taking
76% longer. GPT-5 mini passed 6/6 but was more expensive and 175% slower. Gemini
3.8 Flash attempted a denied tool and was rejected. These results support only
provisional staging hypotheses only; the legacy solve entry point is now
disabled and the measurements do not establish automatic application, broad
implementation, or research equivalence. See
[delegation calibration](evals/delegation-results.md).

Project-specific evidence provides provisional staging profiles only: React
uses GPT-5 mini, EverShelf uses Gemini 3.7 Flash, and FST uses MAI Code 1.1
Flash based on three cases each. HA-EverShelf's incomplete packets were
invalidated, leaving zero valid cases and disabling its cheap-worker launch.
`reviewed-application` has no 30-case floor, but it always requires isolated
pre-validation, medium acceptance, separate operator apply authorization,
identical post-validation, and exact rollback binding. Only
`unattended-application` uses the >=30 matched held-out case gate (and >=10
families where that dimension applies), independent review, confidence,
matching terminal outcomes, zero critical failures, fault-tested rollback,
reconciled all-leg usage, and positive complete all-leg savings.

Instruction paths must exist inside the repository. The adapter describes
gates, not executable permissions. Each project owns its targeted test
selection, research evidence, live safety, release and rollback rules.

All four project `.github/agent-opportunities.json` policies use version 3 and
resolve exactly 44 project-tuned teams. Supported phase kinds are
`deterministic`, `research-frontier`, `spec-planner`,
`medium-coordinator`, `cheap-worker`, `medium-review`,
`risk-triggered-frontier-review`, and `deterministic-release`.
Routine deterministic phases need no model launch or model-bound authorization.
Conditional frontier phases require named trigger receipts. Model role never
grants repository apply, GitHub, Home Assistant, database, production, release,
external, or destructive authority.

Project release machines also use version 3. Repository-local validation
drivers are executable; GitHub, HA, HACS, database and production drivers are
represented as typed disabled tools, so each complete machine remains
`enabled: false`. Explicit operator authorization precedes deterministic
execution. A project medium reviewer checks evidence but cannot authorize side
effects; max/long exception review requires a project trigger receipt. Shared
fake-driver tests exercise authorization, receipt
binding, expected rejection, abnormal failure, rollback verification and
cleanup for GitHub PR/release/workflow, Home Assistant, HACS, deployment,
database capture and rollback classes without external mutation.

Capability promotion uses:

```bash
node evals/project-sandbox-qualification.mjs /path/to/project capability-id
node evals/capability-qualification.mjs qualification.json
node evals/benchmark-budget-planner.mjs evals/capability-study-budget.json
```

The four current project dependency profiles are qualified with network-off
Docker execution, read-only dependency mounts, fixed runtime checks, no host
environment, explicit writable/cache paths and lockfile or fixture evidence.
That sandbox qualification does not promote a model capability.

It requires at least 30 capability-matched held-out cases across at least ten
source families, independent review, zero critical failures, matched terminal
outcomes and known usage for every model leg. Three-case project inventories
remain explicitly provisional and publish no savings.

The checked-in hierarchical study budget describes complete team topologies,
not an isolated `[bounded-worker, frontier-review]` pair. Planning, evidence,
implementation, deterministic validation, review, one revision, grading,
failure, fallback, escalation, and release legs are represented. Because at
least one mandatory production leg lacks matched expected usage, expected
savings remain `null`, the candidate pool authorizes zero calls, and
`runStudy` remains `false`.

Fail-closed cross-project regression uses `npm run test:projects` and requires
`BUDGET_PROJECT_MANIFEST` with `cases`
containing `id` and `root`. For relocated HA/EverShelf instruction checks, pin
`instructionBaselineRef` to the pre-migration commit and
`instructionMigrationRef` to the migration commit so the historical
verbatim move remains reproducible while the live contract evolves. Keep local
manifest paths and raw evidence outside the repository. The shared CI workflow
checks out all four projects with the read-only `CROSS_REPO_READ_TOKEN`.

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
successive model gates. Its legacy route has no automatic draft worker; the
separately controlled provisional artifact lane is described below. Sonnet 5 is not
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
node skills/budget-workflow/scripts/usage.mjs ledger /private/month-ledger.json
```

The ledger's limit and initial spend are explicit caller inputs. Its scope is
admitted runs only: other projects/clients need to use the same ledger or their
spend must be supplied separately. It is not the account billing system.
The UTC month must match; initialize a new file for a new month. Reservations
serialize via an exclusive lock; contention fails closed rather than launching
unaccounted work. Never remove a live lock. Missing usage changes the
reservation to explicit `unreconciled` state. Reports expose known spend,
active and unreconciled reservations, and reserved exposure separately.
Savings are ineligible while required usage is unknown; the soft cap is never
reported as actual spend.

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

The output includes request hash, runtime, requested model profile, the exact
resolved `subagent.configured` event evidence, tool isolation evidence, answer,
raw events, errors and usage. Missing or mismatched resolved model, effort, or
context fails closed. Do not feed full raw
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
