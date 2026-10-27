# Local audit integrity

Protected staff-pilot databases sign audit entries with an HMAC chain derived from the authentication encryption key. Each audit insert updates its signature and the chain head in the same SQLite transaction. Ordinary updates and deletes of audit records or signatures are rejected. Reopening a protected database verifies its existing chain before enabling writers; a missing key, altered guard, changed entry, or broken link keeps the service offline.

Normal startup creates a baseline only for an empty audit log. A nonempty log with missing integrity metadata is rejected, so removing the chain cannot silently cause existing entries to be re-signed. An operator-reviewed legacy migration can explicitly call `initializeAuditIntegrity(db, key, { allowLegacyBaseline: true })`; the application does not enable this option during startup or expose it through an API. That migration establishes a baseline of the entries present at that moment and cannot establish that earlier history was complete or accurate. Independently retained anchors are still required to detect replacement with an empty database or a complete older snapshot.

Keep the authentication key separately from database backups. Replacing that key without a planned migration prevents both authenticator decryption and audit verification.

With the server stopped and the same database paths and key configured:

```sh
npm run audit:verify
npm run audit:verify -- --anchor-out /secure-export/anchors-2026-10-27.json
npm run audit:verify -- --anchors /trusted-archive/anchors-2026-10-27.json
```

The verifier opens the main database and every registered practice database read-only and holds the same service locks used by startup and backups. It prints only an aggregate result and exits with a failure code if verification fails. `--anchor-out` creates a new file with private permissions and refuses to overwrite an existing file. The anchor file contains technical database names, chain identifiers, record counts, and signatures; it contains no audit entry fields or signing key.

Copy anchors to independently controlled, access-protected storage with retention and monitoring. Supplying a trusted anchor detects a valid-looking database that was rolled back to before that anchor. Creating an anchor beside the database does not supply independent protection. Automated delivery to immutable external storage, retention policy, alerting, and operational review remain launch requirements.

These local controls detect many changes and prevent routine application mutations. They do not make SQLite tamper-proof: a privileged process with the signing key can produce new signatures, and replacing an entire database with an older valid snapshot is undetectable without an independently stored anchor. Protect operating-system access, keys, backups, and the application process as well.
