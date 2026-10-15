# Touch definitions and LinkedIn follow-ups

Replaces the touch names in
[2026-10-13-touches-email-bonus-away-hours.md](2026-10-13-touches-email-bonus-away-hours.md).
Everything else in that record (email bonus, away hours, 70/30 split) stands.

## Problem

The Oct 13 record named connection requests "1st touches" and first messages
"2nd touches". The owner's terms are different, and the score had no place for
what the owner calls a 2nd touch:

| What the owner does                                              | Oct 13 code | Owner's name |
| ---------------------------------------------------------------- | ----------- | ------------ |
| Connection request                                               | 1st touch   | Request      |
| First message to someone who accepted                            | 2nd touch   | 1st touch    |
| Follow-up 5 business days after a first message, to non-repliers | not tracked | 2nd touch    |

The day report also folded this week's leftover email goal into "1st touches
50 of 63", which read as 13 missing requests.

## Founder decisions (2026-10-14)

- Requests, 1st touches (first messages), 2nd touches (LinkedIn follow-ups),
  and replies owed each count toward the 70 goal points, each capped at its
  own number.
- A 2nd touch is due 5 business days after a first message, to people who
  have not replied.
- Option A: replies received reduce the follow-ups owed, because the ledger
  stores daily counts and cannot say who replied. Its error asks for too few,
  never too many.
- Unchanged and assumed by default: a first message is owed the day someone
  accepts; one follow-up per person, no 3rd touch.
- Emails are bonus from the week of Oct 12 without re-saving its goal. Owner:
  "we just agreed that emails are bonus and that requests is out of goal/5".
  The Oct 12-18 goal was saved on Oct 12 with 50 emails, so Tuesday Oct 13
  read "Emails + requests 50 of 63" (50 requests plus 13 paced emails).

## Contracts

### Logged count (`lib/ledger-fields.ts`)

`linkedinFollowUps`: whole count 0..1000 per day, stored in the existing
`outreach_counts` JSONB and Blob overlay keys. No migration; rows without the
key read as 0.

### Which weeks ask for emails (`lib/weekly-goal.ts`, `outreachGoalOf`)

```text
outreachGoalOf(storedRow, forWeek)
  channel row, forWeek >= EMAILS_BONUS_FROM_WEEK ("2026-10-12") -> { emails: 0, connectionRequests }
  channel row, earlier week                                     -> { emails, connectionRequests } as saved
  touches row                                                   -> { touches } as saved
```

`forWeek` is the week being scored, not the row's own `weekStart`, because a
goal carries forward until a newer one is saved. Stored rows are not
rewritten. Every reader (day bars, week card, goal editor, email bonus,
published mirror) gets its goal through `resolveWeeklyGoal`, which calls this.

Requests per weekday stay the Oct 8 catch-up bar: (weekly requests - sent on
earlier weekdays) / weekdays left. On pace that is goal / 5, e.g. 250 / 5 = 50.

### What a day owes (`lib/outreach-funnel.ts`, `dueToday`)

```text
linkedinFollowUps due on D =
  max(0, first messages sent on days S with S + LINKEDIN_FOLLOW_UP_WEEKDAYS (5) weekdays <= D
         - LinkedIn replies received through D
         - LinkedIn follow-ups sent before D)
```

All sums run over the existing 28-day pipeline window. D's own follow-ups
are "done", never "less due"; a reply logged on D lowers what D owes.

Known error (accepted with option A): every LinkedIn reply in the window lowers
the follow-ups owed, including replies to a follow-up and replies to a first
message not yet 5 business days old. So it can ask for fewer follow-ups than
are really owed, by at most the replies in the window, and never for more.

Example (live data, Oct 14): first messages were 3 on Tue Oct 6 and 25 on Tue
Oct 13. On Tue Oct 13 the 3 are due, 2 LinkedIn replies had arrived, none
followed up: 1 owed. (tests/touch-scoring.test.ts uses the Oct 13 afternoon
snapshot, when 1 reply had arrived: 2 owed, and the day scores 57.)

### What a weekday requires (`lib/ledger.ts`, `daySends`)

```text
outreach      = outreachRequirement(tally, day's outreach bar)   (requests, plus emails in a week that asks for them)
firstTouches  = { required: due.linkedinMessages,  done: min(linkedinMessages, due) }
secondTouches = { required: due.linkedinFollowUps, done: min(linkedinFollowUps, due) }
replies       = email + LinkedIn answers owed, each capped at its own due
goals points  = round(70 x sum(done) / sum(required)), 70 when nothing is required
```

`lib/ledger-ui.ts` owns the display names (`TOUCH_LABELS`, `sendLines`). The
outreach row is named by `outreachGoalUnit` of the day's bar: "Requests 50 of
50" from Oct 12, and "Emails + requests" only in the Oct 5-11 week, the one
week that still asks for emails. Days before the channel split show only
"Touches", since nothing else was tracked then.

The Telegram outreach checkpoints read `sends.outreach` (renamed from
`firstTouches`); what they count is unchanged.

## Consequences

- Follow-ups alone move one past day of live data: Tue Oct 13 from 64 to 63
  (1 follow-up owed, 0 logged). Past days can now log follow-ups, so a
  follow-up actually sent that day can be entered.
- Emails as bonus from Oct 12 then move Oct 12-14 (live data, Oct 14
  afternoon): Mon 34 to 38, Tue 63 to 68 ("Requests 50 of 50 · 1st touches 25
  of 60 · 2nd touches 0 of 1 · Replies 1 of 2"), Wed 35 to 39. The Oct 12-18
  week's base goes from 37 to 43 (131 of 250 requests instead of 131 of 300
  sends), and its emails earn the bonus. Oct 5-11 does not move.
- The pipeline's "Replied" rate is still people who replied over people
  messaged; it now includes replies that came after a follow-up.
- No goal needs re-saving: the Oct 12-18 row keeps its stored 50 emails and
  is read as 250 requests. Re-saving it later changes nothing.
- The Oct 5-11 week still asks for its 50 emails, as the Oct 13 record
  decided. Reading it as requests-only too would move Oct 5 from 69 to 89,
  Oct 6 51 to 68, Oct 8 28 to 35, Oct 9 37 to 53, and the week 58 to 81.
- Rollback: an older deployment rejects the `linkedinFollowUps` overlay key,
  so once a follow-up is saved on Vercel a rollback needs a fix forward, as
  with `awayMinutes`.
- The outreach pipeline card does not show LinkedIn follow-ups yet.
