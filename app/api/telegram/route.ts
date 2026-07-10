import { currentNudgeState, interpretSnooze, localClock } from "@/lib/accountability";
import { jsonError } from "@/lib/auth";
import { requireEnv } from "@/lib/env";
import { appendNudgeMessage, getSettings, setNudgeState, setSnoozeUntil } from "@/lib/store";
import { sendTelegram } from "@/lib/telegram";

// Node runtime: interpretSnooze uses the OpenAI SDK and this touches Postgres.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Telegram reply webhook. Telegram POSTs owner replies here; a granted snooze
 * mutes all nudges until it expires, a challenge pushes back without muting, and
 * both the reply and the bot's response are logged to the ledger conversation.
 *
 * Auth: the mandatory `x-telegram-bot-api-secret-token` header must equal
 * TELEGRAM_WEBHOOK_SECRET (missing env throws -> fails closed). Always returns
 * 200 on the happy path AND on internal errors so Telegram does not retry-storm.
 */
export async function POST(request: Request) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== requireEnv("TELEGRAM_WEBHOOK_SECRET")) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const body = (await request.json().catch(() => null)) as { message?: { chat?: { id?: unknown }; text?: unknown } } | null;
    const chatId = String(body?.message?.chat?.id ?? "");
    const text = String(body?.message?.text ?? "");
    // Ignore anything not a text message from the owner's chat.
    if (chatId !== requireEnv("TELEGRAM_CHAT_ID") || !text) {
      return Response.json({ ok: true });
    }

    await appendNudgeMessage({ direction: "in", kind: "reply", text });

    const settings = await getSettings();
    const state = currentNudgeState(settings.nudgeState);
    const verdict = await interpretSnooze(text, { localTime: localClock(), snoozeMinutesToday: state.snoozeMinutesToday });

    if (verdict.action === "grant") {
      await setSnoozeUntil(new Date(Date.now() + verdict.minutes * 60000).toISOString());
      state.snoozeMinutesToday += verdict.minutes;
      await setNudgeState(state);
    }

    await sendTelegram(verdict.message);
    await appendNudgeMessage({ direction: "out", kind: verdict.action, text: verdict.message });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[work-live] telegram webhook failed:", (error as Error).message);
    return Response.json({ ok: true });
  }
}
