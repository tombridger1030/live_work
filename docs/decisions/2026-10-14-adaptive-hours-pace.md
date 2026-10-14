# Adaptive hours pace

At 12:45, 2.2 hours should be judged against the work normally completed by
that time toward today's 9.8-hour goal. Dividing by the finished-day goal makes
an on-track morning look like a failed day. Moving the start to today's first
capture would instead excuse a late start.

Build in Modules. Write Comments First. Design for Reduced Complexity.
Contract-First.

## Choice

Learn a cumulative desk-work curve from prior weekdays in the retained history.
Prefer days that met their historical hours goal when at least three are
available. Otherwise use the stronger half of observed workdays, selected by
their median desk-hours total. Require three reference days. Exclude today,
weekends, empty days, duplicate frames, and incomplete archived days whose
desk-hours total disagrees with the current ledger. No fixed start/end schedule
is introduced; the existing capture scoring window bounds what is observable.

For each reference, measure the share of its desk time completed by the current
local clock time. The median share times today's existing catch-up goal is the
expected hours now, capped by elapsed scoring time. The median resists an odd
day. Normalizing lets a changed goal use the learned rhythm without inheriting
the reference day's smaller volume. References are independent of today's late
start and today's performance. A fallback is explicitly labeled stronger days;
it is not described as a successful-days baseline.

    retained desk captures + historical goals
                      |
                      v
          prior-day reference selection
                      |
                      v
    learned share by now x today's catch-up goal
                      |
                      v
         hours points + ahead/behind report

The 30 hours points use actual credited hours / expected hours, capped at 30.
Away-from-desk work retains its existing half credit, but does not teach timing
because its timestamps are unknown. Before any work is expected, zero hours
earn zero points and show "Not due yet". Without three valid references, show
"Learning your pace" and retain the completion score. Past days and weekly
totals continue to use full goals. Today's provisional score is excluded from
the completed five-day average.

## Boundary and reversibility

`hours-pace` owns selection, fractions, and pace status. Server reads extract
compact minutes from existing retained captures, without images or new writes.
The page supplies a serializable live scoring context to ledger assembly.
Optimistic edits retain this context and recompute today's expected hours when
its goal changes. The clock is evaluated after cached history is read. Capture
and owner corrections invalidate the existing captures cache tag.

No database, capture-agent, Blob document, or authentication migration. Older
Mac publications remain readable. Removing the live context restores the
previous completion score. No stored facts or historical final scores change.

## Verification

One vertical slice: open today's ledger, inspect the learned expected hours and
deficit, compare the hours points in the report and chart, then open a past day
and confirm its full-goal score. Verify a late start cannot alter the reference
curve, goals scale expectations, empty/sparse history is honest, timezone and
midnight boundaries work, and optimistic away-hour edits preserve the pace.

The history is descriptive: it cannot infer an aspirational 4–5-hour lunchtime
standard from weaker days. Expose its reference count and basis instead of
claiming an expectation was learned when it was chosen.
