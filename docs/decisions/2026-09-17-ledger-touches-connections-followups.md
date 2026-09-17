# Ledger touches, connections, and follow-ups

## Problem and success criteria

The daily ledger currently presents `reachouts`, `replies`, and `meetings booked`.
The owner wants the first section called **Touches**, plus editable, durable
sections for **Connections** and **Follow-ups sent**. Existing reachout values
must remain intact, and edits must work on both the live origin and the deployed
mirror origin.

Done means a user can open any displayed day, change all five counters, see the
new values immediately, reload, and still see the saved values. Existing weekly
touch goals, scoring, reply-rate, and booking-rate behavior remain unchanged.

## Constraints and known facts

- `reachouts` is the persisted Postgres/local-storage key and feeds activity
  scoring and weekly goals.
- The deployed mirror stores owner edits in a private JSON overlay and rebuilds
  the derived ledger from it.
- The current day report already has one reusable count-field interaction with
  debounced save, optimistic display, inline retry, and owner authentication.
- Database schema is initialized in `lib/store.ts` with additive `ALTER TABLE`
  statements, so new counters can be added without rewriting historical rows.

## Alternatives

### A. Rename the persisted domain field from `reachouts` to `touches`

Shape: rename the TypeScript field, database column, API payload, weekly-goal
field, mirror overlay, charts, tests, and migration scripts.

Trade-offs:

1. It makes the internal vocabulary match the new UI immediately.
2. It amplifies change across scoring, weekly goals, restore tooling, and all
   historical fixtures.
3. It requires a production migration and careful compatibility with old mirror
   documents and older clients.

### B. Keep `reachouts` as the storage/score contract and relabel the UI

Shape: preserve `reachouts` internally and add `connections` and
`followUpsSent` through the same entry, route, database, and overlay boundaries.
Use “Touches” everywhere the owner sees the old label.

Trade-offs:

1. Existing values, scoring, goals, and old documents remain compatible.
2. The storage name is slightly less conversational than the UI name.
3. A later full domain rename remains possible as a separate, intentional
   migration rather than being hidden inside this small UI request.

## Decision

Choose B. The user asked for ledger sections, not a storage migration. One
canonical persistence contract remains hidden behind the existing ledger route;
the new counters travel through the same contract and use additive schema
changes. The UI language becomes “Touches” while the existing weekly goal and
score semantics stay stable.

## Thin vertical slice

```text
day report controls
  -> optimistic draft + debounced save
  -> authenticated ledger POST
  -> Postgres/local row OR mirror overlay
  -> ledger assembly
  -> server refresh / reload
  -> same five sections with persisted values
```

The demo proof is a browser edit of Connections and Follow-ups sent on a
historical day, followed by a reload on the same origin showing both values.

## Contract and verification plan

- Counts are integers from 0 through 1000; omitted fields preserve their
  persisted value.
- New fields never affect activity score, touches goals, reply rate, or booking
  rate.
- Existing mirror overlay documents without the new keys parse as zero-valued
  fields.
- Run targeted ledger/overlay tests, file lint, typecheck, then exercise the
  deployed-origin browser flow and capture a visual proof.
