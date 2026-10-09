# Ledger editing session recovery

## Problem and decision

On October 5, three production POSTs to `/mirror-api/ledger` returned 401.
Safari retained a draft of one touch and one follow-up for October 5, but the
day report only said "Could not save." The owner unlock form was outside the
open report, inside the weekly goals section.

Restoring the production owner session and retrying both fields returned 200.
An independent deployed browser read confirmed both values were persisted.
The local and production owner secrets differed; no credentials were changed.

The authentication form now lives in one `LedgerOwnerAccess` component used
by both weekly goals and the day report. A rejected save brings recovery into
the same surface as the unsaved entry. Draft values and explicit retry remain
unchanged. Authentication, session lifetime, rate limiting, and storage are
unchanged.

```text
Day edit -> same-origin POST -> 401 -> unlock form inside day report
                                      |
                              existing session exchange
                                      |
                             retry -> storage -> reload
```

## Verification

Lint and typechecking passed; all 263 existing tests passed. The separate
presence-only camera evaluation failed with 17 mismatches across 79 cases.
No camera, model, capture, or evaluation code is included in this change.
The production upload was assembled from HEAD plus the four ledger UI files,
excluding the pre-existing local evaluation-script changes and scratch files.

Production deployment `dpl_6iRPD89v12vZLxUFFJDfeHLapFwK` is live on
`https://tally-focus.vercel.app`. In an independent browser with no owner
session, an edit returned 401 and displayed the unlock form inside the open
day report while retaining the draft. The form exchanged the production
secret successfully (200), and retry saved the original one-touch value.
Screenshots in `docs/screenshots/ledger-owner-recovery-2026-10-05.png` and
`docs/screenshots/ledger-save-recovered-2026-10-05.png` record the UI proof.

The weakest part is session longevity: this recovery verifies a newly issued
session, not thirty days of browser cookie retention. A future missing or
expired session still requires the owner to unlock editing and retry.
