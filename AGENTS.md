# Tally deployment guardrails

- Keep dashboard reads and owner edits on the deployed origin. Never infer Mac or capture availability from browser access to a private tunnel.
- Verify selected historical dates, their images, and persisted edits in the actual deployed browser before claiming a fix.
- Read Blob documents with identity encoding when using their ETags for compare-and-swap. Compression can return a weak ETag that cannot authorize an atomic write.
- Pull deployment secrets only into a private temporary directory, never over the capture server's `.env.local`.
