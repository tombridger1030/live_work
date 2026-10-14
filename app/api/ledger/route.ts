import { isOwnerMutationAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { getDisplayedLedger, getLedgerData } from "@/lib/ledger-server";
import {
  saveLedgerDayOverride,
  saveLedgerWeekOverride,
} from "@/lib/ledger-overrides";
import { isMirrorHost, readLatestMirror } from "@/lib/mirror";
import { setLedgerEntry, setWeeklyGoal } from "@/lib/store";
import { getOptionalEnv } from "@/lib/env";
import {
  MANUAL_COUNT_FIELDS,
  MAX_DAILY_COUNT,
  isDailyCount,
} from "@/lib/ledger-fields";
import type { LedgerDayPatch } from "@/lib/ledger";
import { connectionRequestGoal, validateWeeklyGoal } from "@/lib/weekly-goal";
import { isValidDayKey, localDayKey, weekStartForDay } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isMirrorHost()) {
    const snapshot = await readLatestMirror();
    if (snapshot?.ledger) {
      return Response.json(snapshot.ledger);
    }
    return jsonError("Ledger mirror is not available", 503);
  }
  const data = await getLedgerData(new Date());
  return Response.json(data);
}

/**
 * Applies one owner-authenticated ledger edit and refreshes both live reads and
 * the always-on mirror. Tailscale Serve identity is the normal browser path;
 * the signed owner cookie remains a fallback. Inputs are runtime-validated and
 * goal edits cannot be combined with day edits.
 */
export async function POST(request: Request) {
  if (!isOwnerMutationAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("Invalid JSON", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  try {
    // Goal edits use a Monday key and are intentionally separate from day logging
    // so a request cannot partially update both contracts.
    if (body.weekStart !== undefined) {
      const weekStart = body.weekStart;
      const weeklyConnectionRequests = body.weeklyConnectionRequests;
      const weeklyHours = body.weeklyHours;
      // Emails are bonus, never a goal; an old page still sending one is
      // refused rather than silently dropped.
      if (body.weeklyEmails !== undefined) {
        return Response.json(
          { error: "weeklyEmails is not a goal; emails are bonus" },
          { status: 400 },
        );
      }
      const currentMonday = weekStartForDay(localDayKey(new Date()));
      const validation = validateWeeklyGoal(
        weekStart,
        weeklyConnectionRequests,
        weeklyHours,
      );
      if (
        body.day !== undefined ||
        !validation.ok ||
        typeof weekStart !== "string" ||
        weekStart > currentMonday
      ) {
        return Response.json(
          {
            error: !validation.ok
              ? validation.error
              : "weekStart must be a displayed Monday week",
          },
          { status: 400 },
        );
      }
      const displayedLedger = await getDisplayedLedger();
      const displayed =
        displayedLedger?.weeks.some((week) => week.weekStart === weekStart) ??
        false;
      if (!displayed) {
        return Response.json(
          { error: "weekStart must be a displayed Monday week" },
          { status: 400 },
        );
      }
      const connectionRequests = weeklyConnectionRequests as number;
      const hours = weeklyHours as number;
      if (isMirrorHost()) {
        const { weekStart: _key, ...stored } = connectionRequestGoal(
          weekStart,
          connectionRequests,
          hours,
        );
        await saveLedgerWeekOverride(weekStart, stored);
        revalidateCaptures();
        return Response.json({ goal: { weekStart, ...stored } });
      }
      const goal = await setWeeklyGoal(weekStart, connectionRequests, hours);
      revalidateCaptures();
      return Response.json({ goal });
    }

    const day = body.day as string;

    if (typeof day !== "string" || !isValidDayKey(day)) {
      return Response.json(
        { error: "day must be YYYY-MM-DD" },
        { status: 400 },
      );
    }

    if (day > localDayKey(new Date())) {
      return Response.json(
        { error: "cannot log a future day" },
        { status: 400 },
      );
    }

    const featureDone = body.featureDone;
    if (featureDone !== undefined && typeof featureDone !== "boolean") {
      return Response.json(
        { error: "featureDone must be a boolean" },
        { status: 400 },
      );
    }

    // commits/merges are written by the accountability engine from GitHub, never
    // by a browser client. Reject an attempt to set them so a stray field is
    // surfaced, not silently dropped.
    if (body.commits !== undefined || body.merges !== undefined) {
      return Response.json(
        {
          error: "commits and merges are server-written and cannot be set here",
        },
        { status: 400 },
      );
    }

    const fields: LedgerDayPatch = {};
    if (featureDone !== undefined) fields.featureDone = featureDone;
    for (const field of MANUAL_COUNT_FIELDS) {
      const value = body[field];
      if (value === undefined) continue;
      if (!isDailyCount(value)) {
        return Response.json(
          { error: `${field} must be an integer from 0 to ${MAX_DAILY_COUNT}` },
          { status: 400 },
        );
      }
      fields[field] = value;
    }

    if (Object.keys(fields).length === 0) {
      return Response.json({ error: "nothing to update" }, { status: 400 });
    }

    if (isMirrorHost()) {
      await saveLedgerDayOverride(day, fields);
      revalidateCaptures();
      return Response.json({ entry: { day, ...fields } });
    }

    const entry = await setLedgerEntry(day, fields);
    revalidateCaptures();
    return Response.json({ entry });
  } catch (error) {
    console.error("[ledger] mutation failed", error);
    return jsonError("Unable to save ledger change", 500);
  }
}
