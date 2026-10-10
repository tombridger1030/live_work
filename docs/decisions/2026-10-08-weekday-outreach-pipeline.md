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
- Amended 2026-10-09 (decision A, "weekdays are the plan"): weekends carry
  no goals and no score, and unsent email follow-ups stay due until sent. The
  weekly hours goal stays 55 and, per the owner, spans all seven days: hours
  catch up over every day left through Sunday, so weekend hours count toward
  it.

## Contracts

### Weekday catch-up bar (`lib/outreach-pace.ts`)

```text
bar(day) = ceil(max(0, weeklyGoal - loggedEarlierThisWeek) / weekdaysLeft(day))
weekdaysLeft(Mon..Fri) = 5, 4, 3, 2, 1        bar(Sat|Sun) = none
```

Hours use the same rule spread over every day left through Sunday, since the
weekly hours goal includes the weekend, rounded up to a tenth of an hour
(55 h: 7.9 on a fresh Monday; Friday shares what is left with the weekend).

- Depends only on earlier days of the same week, so it never moves while the
  owner logs the day itself. Editing an earlier day re-derives later bars.
- Whole numbers: the shown number is the number that clears the bar.
- Ahead of pace gives a bar of 0, which counts as met. Behind on Friday gives
  whatever is left; no cap.
- Touches logged on a weekend still count toward the week.
- A channel goal runs this rule once per channel.

### Activity score (`lib/ledger.ts`)

Amended 2026-10-09 by the owner: "if I complete all the goals ... I should
get a 70%. Then the 30% is dependent on how many hours I work that day."

- Weekday, goals (70 points): every send the day requires counts once: new
  outreach against its catch-up bar (touches, or emails and requests per
  channel) plus answers owed to prospects who replied on email or LinkedIn
  (owner, 2026-10-09: "replying to people who have responded"). Each kind is
  capped at its own number, so extra emails never cover unanswered replies.
  Follow-ups stay a to-do and never touch the score. Nothing required counts
  as done.
- Weekday, hours (30 points): hours against the day's hours bar, capped.
- The two parts are whole numbers that add up to the score, and the day report
  shows them ("Goals 54 of 70 · Hours 30 of 30").
- Week: 70 for new outreach against the weekly goal, 30 for hours. Follow-ups
  are judged day by day, where their due counts exist.
- Weekend: no targets and no score (`targets`, `dailyValue`, `scoreParts` are
  null). The board shows the hours worked; an idle weekend stays neutral and
  never breaks the active-day streak. Weekend hours, follow-ups, and touches
  still count toward the week's totals.
- Weekday averages and the daily trend cover Monday to Friday only.
- Outputs (accepts, replies received, meetings) never touch the score.

### Stored counts (`lib/ledger-fields.ts`)

One registry lists every manual daily count. The route, the Blob overlay, the
store, the mirror, and the UI iterate it, so adding a count is one edit.

```text
before the split (no channel): reachouts ("touches"), replies, meetings, followUpsSent
email:    emailsSent, emailFollowUps, emailReplies, emailRepliesAnswered,
          emailMeetings
linkedin: connectionRequests, connections ("accepted"), linkedinMessages,
          linkedinReplies, linkedinRepliesAnswered, linkedinMeetings
```

- `...Replies` are replies received from prospects; `...RepliesAnswered` are
  the owner's answers to them (added 2026-10-09).
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

### What a day owes (`lib/outreach-funnel.ts`, `dueToday`)

Every count is a running backlog over the pipeline window, so anything skipped
stays due until it is done, and weekends show the backlog for catch-up:

- Email: emails whose follow-up day (three weekdays after sending: Mon -> Thu,
  Wed -> Mon) has arrived, minus email follow-ups sent before today.
- LinkedIn: accepted (through today) minus first messages sent before today.
- Replies to answer, per channel: replies received (through today) minus
  replies answered before today. These count toward the goals score.
- Floored at 0; none before the split. Today's own sends count as done, never
  as less due. The email backlog cannot see replies, so it can over-ask.

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
