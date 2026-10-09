# Capture outage on October 7

## Observed failure

The deployed mirror's last real image was October 6 at 8:35 p.m. Vancouver
time (`2026-10-07T03:35:17.359Z`). October 7 has no published captures.
macOS lists no external physical disk and `/Volumes/Expansion` is absent.
The configured NexiGo N60 FHD Webcam is also absent from the camera inventory.
The capture agent still runs every five minutes; its away-fallback uploads
failed with 500, and the server logged permission errors creating the missing
external-drive path. Reconnecting a shared dock may restore both devices,
but the physical connection has not yet been verified.

The previous readiness endpoint incorrectly returned `store: ok` and an empty
history when the drive was missing. A missing `store.json` silently selected
first-run defaults before any storage availability check.

## Fix and boundaries

```text
Mac capture tick -> configured external volume -> snapshot + health documents
                             |
                         unavailable
                             |
                     reject empty-store fallback
                             |
                      readiness reports 503
```

Local snapshot reads/writes and health documents now verify that a path under
`/Volumes` belongs to an actual mounted filesystem. A leftover boot-disk
directory cannot masquerade as the external volume. Ordinary local development
roots still support first-run initialization. Checks are uncached so an actual
mount can restore access without restarting the server.

The watchdog keeps the matching running build alive during storage failures;
restarting a process cannot reconnect a drive. Build mismatch or failure to
answer still triggers its existing restart behavior.

No history, configuration, camera selection, or filesystem permissions changed.
No replacement empty store was created. Missed images cannot be reconstructed
from failed away-fallback requests.

## Verification

Lint, typechecking, the local production build, and 268 tests passed. New tests
cover absent mounts, leftover directories, non-directory mount points, reconnect
without cached state, and ordinary local roots. The watchdog passed shell syntax
validation. Production capture recovery remains blocked until the drive and
configured webcam are available; a new capture is not yet verified.
