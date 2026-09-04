import { after } from "next/server";
import { receiveCodeWebhook } from "@/lib/code-persistence";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return receiveCodeWebhook(request, (work) => after(work));
}
