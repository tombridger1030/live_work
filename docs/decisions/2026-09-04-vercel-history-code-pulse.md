# Vercel history and automatic coding metrics

The deployed page must show September 3 at 3 PM when selected, including its retained image, and owner edits must persist on that same origin. Coding metrics must update while the page is closed. The mixed dashboard keeps camera and outreach tracking; coding no longer depends on a Feature shipped checkbox.

## Design

Build in Modules. Write Comments First. Design for Reduced Complexity. Contract-First.

Keep the Mac capture source and publish compact, immutable image assets plus daily dashboard documents to the existing private Blob store. The Vercel reader selects an actual day document and applies owner corrections independently. Keep thirty local calendar days of images. Missing or failed reads show unavailable, never an unrelated day or fabricated zero.

The alternative, restoring automatic Tailscale navigation, still couples browsing to private DNS and Mac availability and does not meet the Vercel requirement. Embedding thirty days of data-URI images in the latest document also amplifies every capture upload. Separate retained assets and date documents make the common read small.

GitHub metrics live in their own durable module. Signed push/merge webhooks and a five-minute authenticated reconciliation update observed counts. The server computes velocity from the most recent seven elapsed days against the preceding twenty-eight days, with raw daily counts and freshness separately visible. A missing baseline is unavailable, not zero. No page load is required for collection.

## Work slices and proof

1. Select an hour and past date on Vercel: archive reader, publisher, asset route, calendar and correction request agree on the selected date. Proof: Safari shows the September 3 3 PM frame and different analytics for another date.
2. Receive GitHub activity with the page closed: authenticate, reconcile, persist and render the score with the raw counts. Proof: independently check GitHub totals against the deployed response and screen; duplicate webhook delivery cannot add counts.
3. Use the mixed Ledger without feature logging: remove feature input and visual scoring, retain historical source values, and label remaining outreach/presence aggregate as activity. Proof: browser day report contains no feature-shipped control and still saves manual outreach/replies.

## Security and rollout

Blob credentials and GitHub tokens stay server-side. Image routes preserve the existing public dashboard viewing boundary; private Blob storage alone is not user authentication. Owner writes require the signed same-origin session on Vercel, where caller-supplied Tailscale headers cannot authorize access. Capture-only APIs fail explicitly on Vercel.

Backfill retained dates from the existing capture store without rewriting the source. Dry-run cleanup before enabling scoped archive expiry. Keep old mirror data compatible through the rollout; rollback deploy routing and readers without deleting local snapshots, owner overrides, or code history. No permission change is justified by historical drive logs: the current local status request succeeds.

## Observed verification

Native Safari on the production origin displayed September 3 at 3 PM (3:55 PM image, frame 12 of 12). Selecting September 2 changed the image and analytics. A September 3 reply increment persisted to the deployed API and was restored to its original zero. Backfill retained 1,908 images across 21 available dates; an ensuing automatic capture reached the new archive. No source images were deleted.

The signed GitHub ping returned 200. Production reconciliation returned 200 updated and saved today's 1 commit/1 merge independently of the capture publisher. Its first deployment exposed a production-only failure: compressed Blob reads returned weak ETags unusable for compare-and-swap. All atomic document readers now request identity encoding and reject weak ETags. Tests cover this boundary, concurrent writes, webhook replay and large pagination. Retention deletion remains verified by dry-run and tests, not a destructive production trial.
