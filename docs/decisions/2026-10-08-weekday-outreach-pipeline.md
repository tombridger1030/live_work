# Weekday outreach, catch-up goals, and the outreach pipeline

## Problem

On Thursday 2026-10-08 the week stood at 54 of 150 touches and the day report
asked for 21. The daily bar was `weekly / 7`, computed once and never adjusted
for what was already sent, so it could not catch up. It also expected sends on
Saturday and Sunday, when sends do not happen.

The owner also wants the pipeline exposed: which inputs they control (emails,
LinkedIn connection requests, follow-ups), which outputs follow (acceptances,
replies, meetings), and whether low replies mean the message is wrong.

## Founder decisions (2026-10-08)

- Decision 1 = A: separate weekly goals for emails and connection requests.
  Follow-ups get a computed "due today" count, not a goal.
- Decision 2 = A: replies and meetings are recorded per channel; LinkedIn gains
  a "first messages" step between accepted and replied. Ratios run over a
  trailing 28 days against the owner's targets (30-40% accept, 50% reply, 50%
  meet).
- Fix 1 contract accepted as proposed; hours stay spread over seven days.

## Contracts

### Weekday catch-up bar (`lib/outreach-pace.ts`)

```text
bar(day) = ceil(max(0, weeklyGoal - loggedEarlierThisWeek) / weekdaysLeft(day))
weekdaysLeft(Mon..Fri) = 5, 4, 3, 2, 1        bar(Sat|Sun) = none
```

- Depends only on earlier days of the same week, so it never moves while the
  owner logs the day itself. Editing an earlier day re-derives later bars.
- Whole numbers: the shown number is the number that clears the bar.
- Ahead of pace gives a bar of 0, which counts as met. Behind on Friday gives
  whatever is left; no cap.
- Touches logged on a weekend still count toward the week.
- A channel goal runs this rule once per channel.

### Activity score (`lib/ledger.ts`)

- Weekday: outreach 4/7 + hours 3/7, each capped at its bar (unchanged weights).
- Weekend: hours only. Without this, a bar of 0 would give every Saturday 4/7
  for free.
- Channel weeks: outreach progress is `(min(emails, emailBar) +
min(requests, requestBar)) / (emailBar + requestBar)`, so one channel cannot
  cover for the other. Outputs (accepts, replies, meetings) never touch the
  score.

### Stored counts (`lib/ledger-fields.ts`)

One registry lists every manual daily count. The route, the Blob overlay, the
store, the mirror, and the UI iterate it, so adding a count is one edit.

```text
before the split (no channel): reachouts ("touches"), replies, meetings, followUpsSent
email:    emailsSent, emailFollowUps, emailReplies, emailMeetings
linkedin: connectionRequests, connections ("accepted"), linkedinMessages,
          linkedinReplies, linkedinMeetings
```

- `connections` keeps its storage key and becomes LinkedIn "accepted"; the 26
  logged on Sep 16-18 were LinkedIn acceptances.
- `followUpsSent`, `replies`, `meetings`, and `reachouts` have no channel and
  stay as history. They are never attributed to a channel.
- Counts are integers 0-1000; omitted fields keep their saved value; stored rows
  missing a key read as 0.

### Weekly goals (`lib/weekly-goal.ts`)

```text
legacy:  { weekStart, reachouts, hours }                       -> one touches bar
channel: { weekStart, reachouts, hours, emails, connectionRequests }
         invariant: reachouts === emails + connectionRequests (>= 1)
```

New saves are channel goals. `reachouts` is kept on channel goals so the
Postgres `NOT NULL` column and older overlay readers stay valid. Legacy weeks
keep their single goal; touches without a channel do not count toward channel
bars.

### Pipeline (`lib/outreach-funnel.ts`)

```text
LinkedIn: requests -> accepted -> messaged -> replied -> meeting
          target    30-40%       90%         50%        50%
Email:    sent -> replied -> meeting           (no targets until the owner sets them)
```

- Window: the last 28 days, starting no earlier than the first day any
  per-channel count was logged ("the split"), so pre-split history cannot
  produce false alarms.
- A stage with fewer than 10 in its denominator reads "not enough yet".
- The headline names the first LinkedIn stage below target, in funnel order.
  "Messaged" comes before "replied" so a sending gap is never blamed on the
  message.

### Follow-ups due (`lib/outreach-funnel.ts`)

- Email follow-ups due on a weekday = emails sent three weekdays earlier
  (Mon -> Thu, Wed -> next Mon).
- LinkedIn first messages due = accepted (window through today) minus first
  messages (window before today), floored at 0.
- None on weekends or before the split. Due counts are a to-do, not a goal.

### Pace nudges (`lib/accountability.ts`)

The Telegram ladder reads today's bar and counts from the same assembled
ledger the board shows (the overlay on the deployed origin), and stays silent
on weekends.

## Consequences

- Rollback: an older deployment rejects overlay day keys it does not know, so
  after a per-channel count is saved on Vercel, rolling back requires a fix
  forward rather than a plain revert.
- The first month of the pipeline is thin by construction.
- The 28-day window understates acceptance for the newest requests, which
  have not had time to be accepted.
