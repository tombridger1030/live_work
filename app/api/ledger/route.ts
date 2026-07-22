import { isOwnerSessionAuthorized, jsonError } from "@/lib/auth";
import { getLedgerData } from "@/lib/ledger-server";
import { setLedgerEntry, setWeeklyGoal } from "@/lib/store";
import { getOptionalEnv } from "@/lib/env";
import { validateWeeklyGoal } from "@/lib/weekly-goal";
import { isValidDayKey, localDayKey, weekStartForDay } from "@/lib/time";


export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getLedgerData(new Date());
  return Response.json(data);
}

export async function POST(request: Request) {
  if (!isOwnerSessionAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
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
      const weeklyReachouts = body.weeklyReachouts;
      const weeklyHours = body.weeklyHours;
      const currentMonday = weekStartForDay(localDayKey(new Date()));
      const validation = validateWeeklyGoal(weekStart, weeklyReachouts, weeklyHours);
      if (body.day !== undefined || !validation.ok || typeof weekStart !== "string" || weekStart > currentMonday) {
        return Response.json({ error: !validation.ok ? validation.error : "weekStart must be a displayed Monday week" }, { status: 400 });
      }
      const displayed = (await getLedgerData(new Date())).weeks.some((week) => week.weekStart === weekStart);
      if (!displayed) {
        return Response.json({ error: "weekStart must be a displayed Monday week" }, { status: 400 });
      }
      const goal = await setWeeklyGoal(weekStart, weeklyReachouts as number, weeklyHours as number);
      return Response.json({ goal });
    }

    const day = body.day as string;

    if (typeof day !== "string" || !isValidDayKey(day)) {
      return Response.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
    }

    if (day > localDayKey(new Date())) {
      return Response.json({ error: "cannot log a future day" }, { status: 400 });
    }

    const reachouts = body.reachouts;
    if (reachouts !== undefined) {
      if (typeof reachouts !== "number" || !Number.isInteger(reachouts) || reachouts < 0 || reachouts > 1000) {
        return Response.json({ error: "reachouts must be an integer from 0 to 1000" }, { status: 400 });
      }
    }

    const featureDone = body.featureDone;
    if (featureDone !== undefined) {
      if (typeof featureDone !== "boolean") {
        return Response.json({ error: "featureDone must be a boolean" }, { status: 400 });
      }
    }

    const replies = body.replies;
    if (replies !== undefined) {
      if (typeof replies !== "number" || !Number.isInteger(replies) || replies < 0 || replies > 1000) {
        return Response.json({ error: "replies must be an integer from 0 to 1000" }, { status: 400 });
      }
    }

    const meetings = body.meetings;
    if (meetings !== undefined) {
      if (typeof meetings !== "number" || !Number.isInteger(meetings) || meetings < 0 || meetings > 1000) {
        return Response.json({ error: "meetings must be an integer from 0 to 1000" }, { status: 400 });
      }
    }

    // commits/merges are written by the accountability engine from GitHub, never
    // by a browser client. Reject an attempt to set them so a stray field is
    // surfaced, not silently dropped.
    if (body.commits !== undefined || body.merges !== undefined) {
      return Response.json({ error: "commits and merges are server-written and cannot be set here" }, { status: 400 });
    }

    const fields: { reachouts?: number; featureDone?: boolean; replies?: number; meetings?: number } = {};
    if (reachouts !== undefined) fields.reachouts = reachouts;
    if (featureDone !== undefined) fields.featureDone = featureDone;
    if (replies !== undefined) fields.replies = replies;
    if (meetings !== undefined) fields.meetings = meetings;

    if (Object.keys(fields).length === 0) {
      return Response.json({ error: "nothing to update" }, { status: 400 });
    }

    const entry = await setLedgerEntry(day, fields);
    return Response.json({ entry });
  } catch (error) {
    console.error("[ledger] mutation failed", error);
    return jsonError("Unable to save ledger change", 500);
  }
}
