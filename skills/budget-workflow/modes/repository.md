# Repository-only research

Use when current source can answer the question without external evidence.
Keep required repository instructions, but do not eagerly load unrelated release
or visual instructions. `evidencePolicy.always` and `.phases.research` select
additional research context; mandatory scoped rules still apply when triggered.

Task input:

```json
{"question":"How does the existing validation helper reject invalid keys?","mode":"repository","risk":"medium","objective":"cost"}
```

From the shared skill directory:

```bash
node scripts/evidence/research.mjs init TASK.json /absolute/repo /private/new-session /private/cache
node scripts/evidence/research.mjs evidence /private/new-session find '{"scope":"repository","query":"validation"}'
node scripts/evidence/research.mjs evidence /private/new-session open '{"path":"src/helper.ts","symbol":"validate"}'
```

Discover across the adapter's allowed tree. Results report searched/skipped/ranked
coverage; ranking is not exhaustive semantic search. Direct path/symbol reads
avoid redundant handle discovery. Complete syntax units retain guards and
decorators. Follow callers/shared validators only when needed for correctness.

Changed source invalidates old handles. Re-discover rather than treating a stale
summary as truth. Before implementation, return to native project tools, inspect
the current edit region, and load all applicable implementation contracts.
