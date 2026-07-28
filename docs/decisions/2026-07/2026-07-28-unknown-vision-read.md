> **AMENDMENT 2026-07-28 — the approved scoring rule was wrong; safe fallback shipped, decision reopened.**
>
> The accepted decision below was "exclude unknown frames from BOTH the hour's
> average score and its headphone percentage", with an accepted consequence of the
> public average moving 62 -> 70.
>
> Implementing it produced a NEW falsehood. In an hour with 11 unexamined present
> frames plus 1 genuinely-away frame, excluding the unknowns left only the away
> frame, so the hour printed **average focus 0 while 92% present** — below the
> hour's true lower bound of ~28. Measured across real history: **59 hours printed
> below their own floor.**
>
> Shipped instead (safe fallback, because leaving the approved rule live was worse
> than the original bug): an unexamined present frame KEEPS its stored
> presence-floor score in `avgScore`, while `headphonesPct` still excludes it
> entirely. The focus bar therefore reads as a LOWER BOUND — never an over-claim,
> never below what was observed — and the amber "?" marker says it can rise.
>
> Delivered result, which differs from what was promised:
> - headphones **45% -> 57%** (the unknown-as-no lie is gone)
> - avg focus **stays 62**, NOT 70. The 62 was always the floor; excluding
>   unknowns is what would have moved it, and that is the option that broke.
> - 0 hours now claim 0 focus while majority-present (was 59).
>
> Still open for Tom: keep this floor rule, or adopt option C — use examined frames
> when an hour has any, and fall back to the floor only when none were examined.
> C is more accurate on mixed hours but claims the observed frames represent the
> unobserved ones, which over-claims in the other direction.

# Record "didn't see" instead of "no headphones" when vision fails

- Date: 2026-07-28
- Status: accepted
- Flight: tally's stored numbers only claim what was actually observed

## END STATE

When no vision model reads a frame, tally records that it **didn't see** rather
than asserting **no headphones**. Hours containing unseen frames are flagged in
the hourly graph so Tom knows which ones still need his attention.

## CURRENT REALITY (measured, not assumed)

Three different situations currently collapse into the single value
`headphones: false`:

1. a model looked and saw no headphones;
2. a model looked and was not sure;
3. **nothing ever looked** — every provider failed.

The scorer cannot tell them apart, so case 3 is charged the full 70-point penalty
(present-without-headphones is 30/100) and counted as an explicit "no" in the
denominator of `headphonesPct`.

Measured on the live store (2026-07-28):

- **415 of 2,022 present frames (21%)** were never examined by any model and sit
  at score 30 with `headphones: false`.
- A further **85** carry the same outage note but were corrected by hand — that
  manual labour is part of the cost.
- Sampling 38 of the 415 and re-asking a now-working model, **12 provably show
  over-ear headphones** (visually confirmed). Extrapolated: **~131 frames are
  factually wrong**.
- Public numbers are understated by **8 focus points and 12 headphone points**
  (62 -> 70 average, 45% -> 57% headphones).
- **5 days have no honest number at all** — every present frame was unknown.
  2026-07-17 reads `30/100, 0% headphones` on zero observations.
- Worst distortions: 2026-07-10 reads 42/100 and 17% headphones where 87 of 105
  frames were unseen; every frame a model *did* read that day showed headphones.

## WHY THIS MATTERS

The whole product is a public accountability record. A number that asserts
something nobody observed is not conservative — it is false in the direction that
looks like Tom slacking, and it silently poisons the corrections corpus used to
choose vision models.

## DECISION — how an unknown frame scores

Chosen: **exclude unknown frames from both the hour's average score and its
headphone percentage.** An hour reports only what was actually observed; an hour
where everything was unseen has no score rather than a fabricated one.

Rejected alternatives:

- *Keep the 30, exclude only from headphone %* — still charges 70 points for a
  frame nothing looked at, which is the bug.
- *Assume headphones* — inflates the record; equally dishonest, opposite sign.

Consequence accepted: **Tom's public average moves 62 -> 70** and five days will
read "not measured". This is a retroactive change to displayed history, taken
deliberately because leaving 415 rows asserting a falsehood is worse.

Presence is unaffected: local detection genuinely verified he was at the desk, so
`present` stays true and hours-present does not change.

## NOT DOING

- Changing how a genuine "no headphones" read scores.
- Auto-correcting unknown frames by re-running the model over stored thumbnails.
  (Tempting — the data exists — but it would write model output as though it were
  observed at capture time. A separate decision if ever wanted.)
- Touching presence detection or its thresholds.
- Rewriting the eval corpus. Unknown frames must simply stop entering it as
  ground truth.

## DONE WHEN

1. A frame captured while every vision provider is failing shows as unknown on
   the public page, not as "no headphones".
2. That frame does not drag the hour's score or headphone percentage down.
3. The hourly graph visibly marks hours containing unknown frames, so Tom can see
   which need updating.
4. The 415 existing unknown frames are recognised as unknown, and the affected
   hours are flagged.
5. A correction Tom makes on an unknown frame still lands as human truth.

## SHAPE

**Rough.** Add an explicit `visionRead: "ok" | "unknown"` to the snapshot,
written by capture when the whole provider chain fails. The scorer and the hourly
rollup skip unknown frames instead of counting them as a "no". The dashboard
renders unknown distinctly and the hourly bars carry an "incomplete" marker.

**Solved.** The failure path is already isolated in one place
(`analyzeFrameWithProvider`'s catch) and already distinguishes credits from
generic outage. `visionHealthFrom` already classifies live health from notes.
Legacy rows default to `"ok"`, so nothing needs migrating in place — the 415
existing rows are identifiable by outage note + `headphones: false` + no human
correction, and can be marked by a one-off backfill.

**Rabbit holes.**
- Scoring contract: `scoreFrom` currently *requires* a boolean headphones and
  throws otherwise. Unknown must not be smuggled through as a third boolean-ish
  value. Resolve by keeping `headphones` boolean and adding `visionRead`
  alongside, so the contract stays strict.
- An hour where every frame is unknown has no honest average. The rollup and
  every display of `avgScore` must tolerate "no score" rather than rendering 0,
  which would look like a terrible hour.
- The corrections/eval export must treat unknown as "not a model answer" so it
  cannot become a false negative in the gold set.

**Boundaries.** No changes to presence, capture cadence, the tunnel, or the
provider chain. No new UI beyond the unknown state and the hourly marker.

## FIRST INTEGRATED SCOPE

Outcome: an unknown frame is stored, scored, rolled up, and displayed as "didn't
see" — end to end, for one frame.
Demo: force the whole provider chain to fail, capture a frame, and see it on the
public page as unknown with the hour's percentage unchanged.
Status: UPHILL — the scoring contract and the "hour with no score" display are
the untested parts.
