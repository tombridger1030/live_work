# Scoring worktree closeout

The owner requested that all needed work be committed and this worktree be
closed. This record preserves the useful release evidence and lessons from
ignored session notes before the worktree is removed.

## Delivered changes

- `a59b364`: adaptive live hours scoring. Prior observed workdays teach the
  expected share by the current clock time, scaled to today's catch-up goal.
  Today's late start cannot move its own expectation. The full daily goal
  stays visible; completed days and weekly progress retain full-goal scoring.
- `7d1201d`: requests, first messages (1st touches), LinkedIn follow-ups
  (2nd touches), and replies owed each earn their own capped goal share.
  Follow-ups are due after five business days. Emails are bonus from the
  week of Oct 12, including goals saved earlier with an email requirement.

Design and contracts are in
[adaptive hours pace](2026-10-14-adaptive-hours-pace.md) and
[touch definitions](2026-10-14-touch-definitions-linkedin-follow-ups.md).

## Final release and verification

The final feature commit is `7d1201d`. The production deployment is
`dpl_H6fQaFbuv97zKg1vm7piKMv1bQfA`, serving livework-one.vercel.app and
tally-focus.vercel.app. This supersedes the adaptive-hours-only deployment
`dpl_Wx33veDCLimq6zNGpH1GQsBraWgc`.

- Final feature checks: 324 tests passed, lint and typecheck passed. A build
  in a separate copy succeeded after the still-running local dev server
  interfered with the worktree's shared `.next` route manifest.
- Production Chrome: Oct 13 displayed 68 = goals 47 + hours 21; requests
  50/50, first messages 25/60, follow-ups 0/1, replies 1/2. Existing saved
  counts loaded. Email Sent displayed "Bonus · +0 of 10 on the week".
- Exact historical date `/?day=2026-10-13`: its 8 PM images and 6.3-hour
  total loaded on the production origin.
- Production ledger reads on both domains: Oct 12 scored 38, Oct 13 scored
  68, Oct 14 scored 40 at the observed time; the week's effective goal
  was 250 requests and zero required emails. No production data was changed
  merely to test a save.
- The final deployment's error logs were empty over the observed 30 minutes.

The capture presence evaluation has 17 existing mismatches. For the hours
release, both the changed tree and an isolated copy of its exact pre-change
commit evaluated the same 79 cases and produced identical mismatch IDs:
54/71 faithful-resolution labels matched, with eight low-resolution cases.
No labels, tests, or allowances were changed to make that check green. The
later touch changes did not modify capture, vision, presence, agent, or model
files. The failing capture evaluation remains a known limitation.

## Lessons and remaining limits

- Adaptive pace describes stronger observed timing; it cannot invent an
  aspirational 4–5-hour noon standard. Sparse or partial history must remain
  explicit, and today's behavior must not train today's bar.
- Use the owner's metric definitions before explaining a score: requests
  are requests, 1st touches are first messages, 2nd touches are follow-ups.
- Apply agreed rule changes to the existing rows they cover. Do not hand the
  owner a goal re-save chore when the decision already settles the behavior.
- Follow-up counts lack person-level identity. The accepted approximation
  lets replies reduce estimated follow-ups owed and can ask for too few.
- A downgrade before LinkedIn follow-up support needs a fix forward after
  follow-ups have been saved; do not silently discard the new count field.

The work remains on branch `align-hour-scoring-e53e543b`. Closing the worktree
does not merge it into `main` or alter the main checkout's pending changes.
