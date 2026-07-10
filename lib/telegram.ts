import { requireEnv } from "@/lib/env";

/**
 * Sends one plain-text message to the owner's Telegram chat via the Bot API.
 *
 * Preconditions: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set (missing env
 * throws, so a misconfigured deploy fails loudly instead of silently dropping a
 * nudge). Postcondition: the message was accepted by Telegram (2xx) or this throws.
 * The caller decides whether a send failure is fatal — the cron evaluator logs
 * and continues so one bad send never aborts the whole sweep.
 */
export async function sendTelegram(text: string): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv("TELEGRAM_CHAT_ID");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${response.status} ${detail}`.trim());
  }
}
