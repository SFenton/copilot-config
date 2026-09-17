# Targeted history lookup

Session history is an additive evidence source, not a mutually exclusive
research mode. Before diagnosing a named recurring system, feature,
integration, or entity, the current owner should run a bounded
`session_store_sql` query using the operator's original nouns.

Return only relevant excerpts and keep the raw operator wording beside any
interpretation. A frozen history packet may be useful for an explicit research
workflow, but it is not required for ordinary work and no reader model is
required.

The fixed templates in `scripts/evidence/history.mjs` cover:

- recent sessions;
- repository/date-bounded sessions;
- PR/issue-linked sessions;
- turn snippets for already resolved sessions;
- files touched;
- model/tool usage;
- prior-approach summaries;
- checkpoint summaries.

Use the default seven-day window first. Widen only to the approved larger
windows and keep exact repository, ref, or session narrowing before any text
scan. Raw session IDs stay in private receipts only; packets carry pseudonymous
refs and bounded excerpts.

```json
{
  "question": "Have I already solved this validator rollback issue?",
  "mode": "history",
  "risk": "medium",
  "objective": "cost",
  "historyRequested": true,
  "workflowId": "workflow-123",
  "promptHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "templateId": "prior-approach",
  "repository": "github.com/example/project"
}
```

```bash
node scripts/evidence/history.mjs plan REQUEST.json
# Run the planned query with the owner/session_store_sql tool and save rows.json
node scripts/evidence/history.mjs run REQUEST.json rows.json
```

History evidence does not authorize repository edits, releases, live probes,
or automatic tandem escalation.
