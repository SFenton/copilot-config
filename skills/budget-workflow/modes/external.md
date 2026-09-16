# External-only research

Use when the question has no meaningful repository dependency. A neutral
`run TASK.json - NEW_OUTPUT CACHE` avoids sending unrelated project context.
Alternatively `init`/`evidence` lets the current owner use the same tools with
no extra model; it cannot erase context already loaded into that conversation.

Configure explicit public documentation roots and exact allowed hosts. For
discovery, preapprove public query text under IDs with provider `github` or
`crossref`. The model chooses IDs, not outbound query strings. Never derive
public query text from private code, identifiers, logs, customer data or secrets.

```json
{
  "question":"What is SQLite foreign-key enforcement scope?",
  "mode":"external","risk":"medium","objective":"cost","sanitized":true,
  "web":{
    "allowedHosts":["www.sqlite.org"],
    "persistTextHosts":["www.sqlite.org"],
    "maxAgeSeconds":86400,
    "seeds":[{"url":"https://www.sqlite.org/docs.html","title":"SQLite docs"}],
    "queries":{}
  }
}
```

Find `{"scope":"external","queryId":"seeds"}`, then open returned source IDs.
Follow authoritative links, not every search result. `focus` filters fetched
text locally and is not sent as a search query.
Freeze the opened evidence into a packet before any model reasoning. Frontier
research receives the frozen packet in `reason-only` mode and no web tools.

Only approved HTTPS static HTML/plaintext is supported. GitHub repository search
and Crossref metadata are not unrestricted web/paper search. Missing browser,
PDF, authenticated or general-search capability is an explicit evidence gap:
use an independently authorized native tool/provider, not a hidden fallback.
Respect source reuse terms. Metadata-only cache is the default; enable text
retention only for approved hosts. Returned excerpts also enter CLI transcripts.
