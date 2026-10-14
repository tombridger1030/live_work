# 1st and 2nd touches, email bonus, and away-from-desk hours

## Problem

On Tuesday 2026-10-13 the live ledger showed 208 LinkedIn requests, 54
acceptances, and 25 first messages over Oct 5-13, with 51 first messages owed
that day. The 70 goal points paid for requests and answered replies but not
first messages, so Monday Oct 12 (50 requests, 0 of 43 owed messages) scored
58 of 70. No email had been logged since the channel split, yet every weekday
still asked for emails. Monday Oct 12 also had no captures at all and scored
0 of 30 for hours on a day with 50 requests sent.

## Founder decisions (2026-10-13, option A)

- The 70 goal points pay for 1st touches (connection requests), 2nd touches
  (first LinkedIn messages owed to people who accepted), and replies owed on
  either channel. Each kind is capped at its own number. No daily cap on owed
  2nd touches.
- Emails are bonus on the week: +1 point per email, at most +10, so a week
  scores up to 110. They never move a day's score. Email follow-ups leave the
  score and stay on the to-do list.
- Time away from the desk is logged by hand and counts at half ("harsh: it
  has to be assumed it wasn't good because I wasn't at my desk").
- 2nd touches count on every day since the split (Oct 5). Earlier weeks keep
  the goals they were saved with, so Oct 5-11 still asks for its 50 emails.
- The acceptance-rate math stays as is (owner: acceptance lag varies from same
  day to a couple of days, so no cutoff is right). It corrects itself as the
  28-day window fills on Nov 2.

## Contracts

### What a weekday requires (`lib/ledger.ts`, `daySends`)

```text
firstTouches  = outreachRequirement(tally, day's outreach bar)
secondTouches = { required: due.linkedinMessages, done: min(sent, due) }
replies       = email + LinkedIn answers owed, each capped at its own due
goals points  = round(70 x sum(done) / sum(required)), 70 when nothing is required
```

- `LedgerDay.sends` carries these three; the day report and the Telegram
  outreach checkpoints read them, so neither recomputes a goal.
- Example (live data): Oct 13 is 50 of 50, 22 of 51, 0 of 1, so 72 of 102 and
  49 goal points; with 2.8 desk hours against a 9.2-hour bar the day is 58.

### Email bonus (`lib/ledger.ts`, `weeklyProgress`; `lib/outreach-pace.ts`, `countsEmails`)

```text
emailBonus  = countsEmails(goal) ? 0 : min(EMAIL_BONUS_MAX_POINTS = 10,
                                           EMAIL_BONUS_POINTS_PER_EMAIL = 1 x emails sent)
baseValue   = round(70 x outreach%) + round(30 x hours%)                  (0 to 100)
weeklyValue = baseValue + emailBonus                                     (0 to 110)
```

The week card and the weekly chart tooltip both show `baseValue` with the
bonus beside it ("29 + 4 bonus"); the chart bar plots `weeklyValue`, so a bonus
week can rise above the dashed 100 line.

`countsEmails` is true for a legacy touches goal and for a channel goal with an
email number, so no email is counted twice.

### New weekly goals (`lib/weekly-goal.ts`)

```text
validateWeeklyGoal(weekStart, connectionRequests 1..10000, hours 0.1..168)
connectionRequestGoal(weekStart, requests, hours)
  = { weekStart, reachouts: requests, hours, emails: 0, connectionRequests: requests }
```

The stored shape is the existing channel goal with 0 emails, so Postgres and
the Blob overlay need no migration. The ledger route refuses `weeklyEmails`
with 400 instead of dropping it.

### Away-from-desk time (`lib/ledger-fields.ts`, `lib/ledger.ts`)

```text
awayMinutes: manual count, whole minutes, 0..1000 (entered in half hours, up to 16 h)
creditedHours = deskHours + 0.5 x awayMinutes / 60      (unrounded; displays round)
```

- `LedgerDay.hours` stays desk hours from captures: it is the only hours value
  a published ledger carries, and `mirrorLedgerForToday` and `reassembleLedger`
  rebuild from it. Credited hours are always derived, never published as input.
- Credited hours drive the hours bar, the score, the weekly total
  (`LedgerWeek.creditedHours`, renamed from `hours`), the streak, and totals.
- `awayMinutes` is excluded from `SPLIT_COUNT_FIELDS`, so logging away time can
  never start the outreach pipeline.

## Consequences

- Every day since Oct 5 scores lower: Oct 12 goes from 58 to 38.
- Rollback: an older deployment rejects the `awayMinutes` overlay key, so once
  away time is saved on Vercel a rollback needs a fix forward, as with the
  Oct 8 channel counts.
- The Oct 12-18 goal must be re-saved once as 250 requests (it was saved with
  50 emails); until then that week still asks for emails.
- Open: Oct 8 has 12 old-style touches beside 12 connection requests, which
  looks like a double entry. Not changed; waiting on the owner.
