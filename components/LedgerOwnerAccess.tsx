"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Restores owner editing through the server's existing session exchange.
 * The secret stays in this form until submission and is cleared on success.
 * Failed exchanges retain the draft and explain the next action inline.
 */
export function LedgerOwnerAccess({ onAuthenticate }: {
  onAuthenticate: (secret: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secret || saving) return;
    setSaving(true);
    setError("");
    try {
      await onAuthenticate(secret);
      setSecret("");
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "AUTH_RATE_LIMITED"
        ? "Too many attempts. Wait a few minutes, then try again."
        : "That owner secret was not accepted. Use the secret for this site.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-4">
      <p className="text-sm font-medium text-amber-100" role="status">Unlock editing to save your entries.</p>
      <p className="mt-1 text-xs leading-5 text-zinc-400">Your changes are still here. Unlock editing, then retry any unsaved entries.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input aria-label="Owner secret" type="password" autoComplete="current-password" placeholder="Owner secret" required value={secret} onChange={(event) => setSecret(event.target.value)} className="border-white/[0.1] bg-black/30 text-zinc-100" />
        <Button type="submit" size="sm" variant="outline" disabled={saving}>{saving ? "Unlocking…" : "Unlock editing"}</Button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-300" role="alert">{error}</p> : null}
    </form>
  );
}
