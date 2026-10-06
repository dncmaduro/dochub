# Editor version policy

Each successful ONLYOFFICE status-2 finalization creates one logical
`FileVersion`, even when the resulting bytes have the same SHA-256 hash as the
current version. The previous version remains in history and the file's
`currentVersion` advances to the new version.

Future storage optimization may consider either logical-version deduplication
(choosing when identical edits should not add a history entry) or
content-addressable byte deduplication (sharing stored bytes while retaining
distinct logical versions). Neither optimization is part of the current policy.
