# One day between acceptance and first message

Eleven accepts on October 15 must not create eleven messages owed on October
15. Tom messages on a later day. This replaces the same-day assumption in
[touch definitions](2026-10-14-touch-definitions-linkedin-follow-ups.md).

Build in Modules. Write Comments First. Design for Reduced Complexity.
Contract-First.

The existing outreach module owns the eligibility rule. A first message is
due the next local calendar day after acceptance, including weekends; weekends
remain unscored. Date keys already use the app's timezone, so no elapsed-hour
timer or timezone conversion belongs in this calculation.

```text
Saved daily counts
       |
       v
dueToday: accepts before selected day - messages before selected day
       |
       v
Ledger score + chart + day report
```

One vertical slice: opening a day shows a first-message requirement that
excludes that day's accepts, with an explanation beside Accepted. The same
requirement feeds the score and charts, including historical reassembly and
the next day of a published mirror. Done means the live browser and deployed
data agree on today's count and score.

Preconditions remain ascending, contiguous day keys and validated daily
counts. All sums retain the existing 28-day pipeline window and split boundary.
Due is floored at zero. Today's messages count as completed against today's
requirement; they do not shrink its denominator. Tomorrow they clear backlog.
Previously unmessaged accepts stay due. Follow-ups and reply deadlines retain
their own rules. Stored counts and goals are unchanged; historical derived
scores are recalculated with the grace day.

The UI says "First messages due the next day" and "No first messages due"
when appropriate. "Everyone messaged" was inaccurate during the grace day.
The conversion funnel continues to report raw same-window counts; its rates
are descriptive and do not feed the activity score.

This is a change to the existing cutoff, with no new module, API, schema,
credential, external dependency, or timer. Keeping a second adjusted score
would create two competing definitions of what is owed.

Verification covers 11 and 1,000 accepts, old backlog, sends during the grace
day, weekends, month rollover, chart/weekly score consistency, historical
reassembly, and a mirror advancing to tomorrow. Existing numeric fixtures
change only where they asserted the superseded same-day requirement.

Local checks: 329 tests pass, lint/typecheck pass, and the production build
succeeds. Replaying the saved October 15 production data removes exactly its
11 accepts from the first-message requirement (53 -> 42) and raises the goals
share (47 -> 54). Requests, messages sent, follow-ups, replies, and hours retain
their stored values.

The separate capture evaluation could not run: the authenticated production
`/api/eval-cases` export returned HTTP 503. The previous release already records
17 capture mismatches. No capture, vision, storage, or authentication code is
changed here; this check is unavailable, not passing.
