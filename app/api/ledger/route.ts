import { getLedgerData } from "@/lib/ledger-server";
import { setLedgerEntry } from "@/lib/store";
import { localDayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getLedgerData(new Date());
  return Response.json(data);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const day = body.day as string;

    if (!day || typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
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
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
}
