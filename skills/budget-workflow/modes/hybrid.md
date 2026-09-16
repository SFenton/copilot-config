# Hybrid research

Use when external evidence must fit existing architecture or reusable code.
Task configuration combines a repository root with the public-source policy
from [external research](external.md). Private source never becomes public query
text. Contracts remain local.

1. Inspect decisive local ownership, interfaces and reuse points. Orientation
   is limited to at most eight repository operations (one-third of the total
   budget for smaller sessions). This is not a full code audit.
2. Record a contract with **actually opened** source IDs, local constraints
   and explicit remaining external gaps:

```json
{"sourceIds":["r_SOURCE/u0"],"constraints":["Reuse the existing transaction helper"],"gaps":["Documented writer concurrency under WAL"]}
```

3. Discover/open approved public evidence for those gaps. The broker requires
   the source-backed contract first and reserves phase headroom. After external
   evidence has been opened, repository reads resume for applicability.
4. Freeze the combined repository/external evidence into one packet before any
   model reasoning. Frontier legs receive the identical packet hash with
   `toolMode: reason-only` and no tools.
5. Map the conclusion back to existing owners, alternatives, concrete offline
   validation proposals and uncertainty. A public recommendation is not proof
   of compatibility or a measured performance improvement.

The phase gate proves sequence, not semantic adequacy: opening an index does
not establish the external claim. If the orientation allowance cannot establish
a defensible contract, finalize as incomplete rather than inventing constraints.
Do not repeatedly call an exhausted broker. Re-scope or explicitly authorize
one bounded escalation if the unresolved question warrants it.
