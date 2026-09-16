# History research

Use when prior Copilot session history is materially relevant and repository or
external evidence alone is insufficient. History extraction is deterministic
and packet-first: the current owner plans a bounded `session_store_sql` query,
sanitizes the rows, freezes a history packet, and only then optionally launches
a packet-only `gpt-5.4-mini` or `gpt-5.4` reason-only leg.

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

History packets support extractive summaries only. They do not authorize
repository edits, releases, live probes, or automatic tandem escalation.
