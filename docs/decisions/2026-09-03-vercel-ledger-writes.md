# Vercel Ledger Writes

## Decision

The public deployment owns small, private dashboard and ledger-edit overlays in
the existing Vercel Blob store. It does not write to the deployment filesystem
and it does not redirect saved-copy mutations to the Mac.

```text
Mac capture data ──publish──> mirror/dashboard.json
Vercel home correction ──────> mirror/dashboard-overrides.json
Vercel Ledger edit ──────────> mirror/ledger-overrides.json
Vercel reads ────────────────> latest snapshot + overlays
Mac live read ───────────────> local source of capture data
```

The overlay contains only owner-entered day fields and effective-dated weekly
goals. Each deployed read applies those fields to the newest published snapshot
and rebuilds the derived ledger values through the canonical ledger assembler.
This keeps a later Mac publish from erasing an edit made while the Mac route is
unreachable. The Mac's live route remains the source-backed view; the public
overlay is the explicit recovery surface for when that route is unavailable.

## Why

Vercel's filesystem is not a durable application database, and a redirect to a
loopback or tailnet origin makes Safari's edit path depend on the Mac being
reachable. The project already has a private Blob store and a signed owner
session, so the smallest durable extension is a server-only overlay beside the
existing mirror.

The deployed home and Ledger pages use same-origin routes for authentication and
mutations. Other live-only API routes retain their existing private-origin
behavior.

## Invariants

- Blob data stays private and is accessed only from server code.
- The browser never receives or stores `OWNER_SECRET` after authentication.
- Capture-derived fields (`hours`, `commits`, and `merges`) remain server-owned.
- Ledger derivations are rebuilt by `assembleLedger`; the overlay never stores
  duplicated scores or totals.
- A missing or unreadable overlay leaves the published snapshot usable.
