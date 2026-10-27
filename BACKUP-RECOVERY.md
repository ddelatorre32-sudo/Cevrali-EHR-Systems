# Encrypted backup and recovery

These tools support a stopped-service recovery drill. They do not establish a production backup service, off-site retention, or a recovery time commitment. Keep the application restricted to synthetic data until the production release requirements are met.

## Protect the keys and storage

Use a private key file containing 32 random bytes encoded as canonical Base64, with mode `0600` or `0400`. Set `CEVRALI_BACKUP_KEY_FILE` to its path, or pass `--key-file`. Never put the key itself in a command argument, source control, logs, a support ticket, or the accounts directory. The pilot key initialization command creates separate authentication and backup keys.

Keep a recoverable copy of the backup key in a separately controlled secret store. An archive cannot be recovered without it. Also retain the **original authentication encryption key** separately: encrypted authenticator identities are in the databases, but the key needed to use them is deliberately excluded from the archive. Changing that key is not an account-recovery procedure.

The archive uses AES-256-GCM with a fresh random nonce. Its encrypted, authenticated manifest includes the expected database paths, sizes, and SHA-256 checksums. Output files are private and are never overwritten. Encryption keys and clinical records are not printed by these commands.

The tools create private temporary plaintext SQLite snapshots while checking and recovering data, and remove them when the operation finishes or a handled error occurs. Use an encrypted host volume for both the data directory and `TMPDIR`, restrict administrator access, and provision enough free space for the archive, decrypted payload, and snapshots. A forced process kill or host crash can leave private staging directories; an operator must inspect and remove abandoned `.cevrali-backup-*` directories after confirming no operation is running. File permissions alone do not encrypt live databases or temporary storage.

## Create and verify an archive

Build the server once with `npm run build`. Stop **all** processes that can write these databases, including the web application, automation, operator consoles, and any database tools. Do not copy only the main SQLite file while the application is running.

```sh
node scripts/backup.mjs \
  --database /data/pilot/cevrali.sqlite \
  --accounts /data/pilot/accounts \
  --key-file /secrets/backup.key \
  --output /backups/pilot-2026-10-27.cevrali-backup

node scripts/backup.mjs --verify \
  --archive /backups/pilot-2026-10-27.cevrali-backup \
  --key-file /secrets/backup.key
```

`DATABASE_PATH`, `ACCOUNTS_PATH`, and `CEVRALI_BACKUP_KEY_FILE` can supply these paths instead. Omitting both database path settings uses the application's demo defaults, so specify them explicitly for an operator drill.

The backup acquires the same deployment locks as service startup before opening the databases. It snapshots the main database, accounts registry, and every direct `*.sqlite` practice database using SQLite's backup API, including committed data held in WAL files. It checks SQLite integrity, foreign keys, and registry-to-practice membership references. Unexpected files in the accounts directory cause failure rather than being silently omitted. Files kept outside the SQLite layout require their own recovery plan.

Successful commands print an archive timestamp, database count, encrypted-format marker, and archive SHA-256. Save this output in the operational drill record. Verification authenticates the entire archive and checks each database; it does not write into the running application's data directory. It still requires secure temporary storage.

Both the service and backup must use the same canonical paths. Symlink aliases and hard-linked input files are rejected. A stale service lock intentionally blocks startup and backup after a crash. Check the deployment and prove every writer has stopped before an operator removes a stale `*.service.lock`; never remove a lock solely because a PID appears absent.

## Restore into an isolated directory

Restore into a **new, nonexistent** directory. The command refuses an existing directory and never overwrites the original environment.

```sh
node scripts/restore.mjs \
  --archive /backups/pilot-2026-10-27.cevrali-backup \
  --key-file /secrets/backup.key \
  --destination /data/recovery-drill-2026-10-27
```

The command authenticates and validates all files before publishing the recovered directory. The result contains:

- `database_path`: `/data/recovery-drill-2026-10-27/cevrali.sqlite`
- `accounts_path`: `/data/recovery-drill-2026-10-27/accounts`
- `sessions_revoked`: `true`

A sibling `*.restore.lock` prevents a service using the recovered layout from starting while recovery is in progress. Do not point a service at staging directories. Preserve the original deployment until a human has completed the recovery checks and an operator has deliberately changed both database path settings.

Recovery removes existing staff sessions and session indexes, verified-session markers, pending authenticator challenges, stored recovery codes, password-reset tokens if present, and public intake-link routing. Pending staff invitations are revoked. Intake links are expired and demo controlled-prescription authorization challenges are cleared. Staff must sign in again; administrators must issue fresh invitations/intake links as needed. An unused recovery code from an older snapshot is also invalidated so restoring a backup cannot revive a code consumed after the snapshot.

Enabled authenticator enrollment and its last accepted time step remain intact. Use the original authentication encryption key, confirm the server clock is synchronized, and allow at least 90 seconds after restore before enabling sign-in to avoid the recent TOTP acceptance window. After authenticator sign-in, staff should generate and securely store new recovery codes. Account identities, clinical records, and existing audit rows are preserved; they still require review for clinical and audit completeness.

## Record a recovery drill

Use synthetic data first. Confirm the expected practice memberships, patient demographics, signed note status and content, chart documents, workflows, and audit verification result in the isolated recovered service. Prove that old session cookies, pending authentication challenges, recovery codes, staff invitations, and intake links no longer grant access. Record the archive hash, operator, date, elapsed recovery time, results, and any gap without copying clinical content into the drill log.

The automated tests exercise encryption, a full registry/patient/signed-note/workflow restore, revoked transient access, preserved authenticator identity, damaged archives, wrong keys, authenticated malicious manifests, existing-destination protection, symlinks, corruption, and competing locks. These tests do not replace a scheduled restore drill on the actual host with its actual secret store.

Before production, assign owners for backup scheduling and downtime, encrypted off-site storage, retention and deletion, key escrow/rotation, monitoring and failure alerts, recovery point/time objectives, and repeated measured restore drills. Confirm the host's storage encryption and access controls. No remote backup destination or retention job is configured by these local tools.
