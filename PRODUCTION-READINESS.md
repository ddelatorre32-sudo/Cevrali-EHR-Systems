# Cevrali readiness and staff pilot

This build supports a synthetic demo and a restricted staff pilot. **It is not approved for real patient information or clinical care.** `CEVRALI_MODE=production` refuses startup even if an operator supplies completed release attestations: live clinical transports and a reviewed clinical release are not implemented. Configuration checks do not certify HIPAA compliance, clinical safety, or EPCS certification.

For the requested full clinical launch, [LIVE-SERVICES-SETUP.md](LIVE-SERVICES-SETUP.md) records the missing service connections. Hosting and reviews have been reported ready; the deployed HTTPS address and approval references still need verification. No live service providers are arranged. Use [DEPLOYMENT-VERIFICATION.md](DEPLOYMENT-VERIFICATION.md) to inspect the actual site once its address is supplied.

## Controls in this release

- `demo` keeps the existing synthetic practice and published demonstration accounts. It remains the default for local development and demo hosting.
- `pilot` disables demo seeding and public practice signup, requires an HTTPS origin, Secure cookies, separate private authentication and backup keys, and staff authenticator MFA. Existing demo databases cannot be adopted by changing the mode.
- Accounts are provisioned offline by an operator or invited within an existing practice. Password verification leads to a short-lived MFA challenge; it does not grant a full pilot session. Initial enrollment requires a valid authenticator code. Recovery codes are shown once and can be regenerated with password and MFA verification.
- Encrypted offline backups cover the main database, account registry, and practice databases. Restore validates the archive and database relationships, uses a new destination, and clears sessions and pending challenges. See [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md).
- Protected database audit entries have a signed append-only chain verified on reopen. The [audit verifier](AUDIT-INTEGRITY.md) can check independently stored anchors; immutable external retention and monitoring remain operational requirements.

Authenticator MFA protects Cevrali account access. It does not implement certified controlled-substance prescribing or establish prescriber identity, licensure, or DEA authority. Existing pharmacy, fax, payer, laboratory, and eligibility connections remain demonstrations. No clinical data should be sent through them.

## Prepare an isolated synthetic pilot

An operator with access to the eventual hosting environment runs these steps. They are a reproducible setup procedure; they do not mean a hosting account, domain, HTTPS service, or live integration has been provisioned by this repository.

1. Build with Node 24 or later: `npm ci` and `npm run build`.
2. Choose a new data directory and a separate new key directory on protected storage. Do not point pilot configuration at `.data/` or any existing demo database. The service account must have exclusive filesystem access; protect the volume and disk snapshots with hosting-level encryption. Pilot startup and provisioning create files with a private `077` umask. For any pre-existing pilot directories and SQLite files, the operator must verify owner-only directory (`700`) and file (`600`) permissions before starting the service.
3. Generate keys without printing their contents:

   ```sh
   node scripts/init-pilot.mjs --directory /private/cevrali-keys
   ```

   The parent `/private` must already exist and be writable. The command creates the requested directory with mode `700` and two distinct random Base64 key files with mode `600`. It refuses existing directories and linked paths. Back up both keys independently in protected storage. The authentication key is needed to decrypt enrolled authenticator secrets after disaster recovery; the backup key alone is insufficient.

4. Supply these settings through the deployment's protected configuration. The HTTPS URL is an example; replace it with the actual pilot origin once hosting and TLS have been configured.

   ```dotenv
   CEVRALI_MODE=pilot
   COOKIE_SECURE=true
   CEVRALI_PUBLIC_SIGNUP=false
   PUBLIC_BASE_URL=https://pilot.example.test
   DATABASE_PATH=/private/cevrali-pilot/cevrali.sqlite
   ACCOUNTS_PATH=/private/cevrali-pilot/accounts
   CEVRALI_AUTH_ENCRYPTION_KEY_FILE=/private/cevrali-keys/authentication.key
   CEVRALI_BACKUP_KEY_FILE=/private/cevrali-keys/backup.key
   ```

   Mount key files read-only for the service. Keep secrets outside the database/accounts directory, outside Git, and separate from encrypted backup archives. Never set public signup to `true` in pilot mode.

5. Check startup configuration with `node scripts/readiness.mjs`. A successful pilot report means only that the checked configuration permits synthetic staff testing. Its `clinical_use_allowed` field remains `false`.
6. Before the service starts, prepare a mode-`600` JSON profile owned by the operator, for example `/private/pilot-practice.json`:

   ```json
   {
     "owner_name": "Pilot administrator",
     "email": "operator@example.test",
     "clinical_access": false,
     "practice": { "name": "Synthetic staff pilot" }
   }
   ```

   Use an independently verified staff identity for the actual pilot owner. The example address is not a working account. This procedure does not verify ownership of an email address. Do not include a password in the JSON profile.

7. Place a unique 12–200 character initial password in a separate operator-owned mode-`600` file, for example `/private/pilot-password`. Avoid putting passwords in shell arguments, shell history, logs, or Git. One trailing newline is removed; other password characters are preserved.
8. Provision the practice while the service is stopped:

   ```sh
   node scripts/bootstrap-practice.mjs --profile-file /private/pilot-practice.json --password-file /private/pilot-password
   ```

   The command uses the configured pilot database paths, refuses known demo data and active service locks, and creates no signed-in session. It does not overwrite existing membership. Delete the temporary password file after securely delivering the credential to the verified owner; retain no unnecessary copies.

9. Start the built service behind the configured HTTPS origin. Sign in as the provisioned owner, enroll an authenticator, and store recovery codes outside the browser and application. Invite verified staff through practice account settings. Limit the pilot to synthetic patients and document results of the workflows below.

The scripts run in the same working directory as the built application and use `dist-server/`. They never print key contents or initial passwords. All commands must use the same canonical `DATABASE_PATH` and `ACCOUNTS_PATH`; these paths also define service locks. A stale lock after a crash requires operator investigation and removal only after verifying that no service, backup, provisioning, or restore process is using the data.

## Required pilot acceptance checks

- Verify owner enrollment, a later authenticator sign-in, recovery-code use, code replay rejection, bad-code lockout, sign-out, password change, and staff deactivation. Confirm unauthenticated users cannot read patient or practice data and practice isolation remains intact.
- Run staff workflows for registration, multiple insurance accounts, scheduling, notes/addenda, medication orders, communication, results review, fax matching, prior authorization, and billing using synthetic records. Review permissions and attribution at each handoff.
- Perform an encrypted backup and a restore rehearsal into a separate directory; confirm patient and practice data, MFA recovery, and the absence of old sessions. Record measured recovery time and acceptable data loss before setting an operational schedule.
- Confirm HTTPS, private data/key mounts, network restrictions, log redaction, restart behavior, disk capacity, monitoring, and alert ownership in the actual hosting environment. The repository test suite does not establish these operational facts.

## Still required before a clinical release

| Area | Evidence that is still needed |
| --- | --- |
| Security and identity | Independent security review and penetration testing; identity/email verification and account recovery procedures; access review and staff offboarding; protected external audit retention and alerting; threat modeling and vulnerability operations. |
| Clinical safety | Clinician validation of charting, units, allergies, medication reconciliation, ordering, result provenance, abnormal-result escalation, signature/addendum behavior, downtime workflows, and error handling. |
| Live services | Contracted and tested pharmacy/e-prescribing and certified EPCS where applicable; payer eligibility/claims/remittance, laboratories/results, fax, messaging, and referral services. Test delivery acknowledgments, failures, reconciliation, duplicates, and vendor downtime. |
| Privacy and legal | Applicable privacy/security risk assessment, required agreements including BAAs with relevant processors, retention/deletion policy, consent/authorization handling, minimum-necessary access, and incident/breach procedures reviewed by appropriate owners. |
| Hosting and recovery | Production hosting account, domain/TLS, encrypted storage, backup scheduling and retention, separate key custody, monitored restore drills, capacity planning, and service alerts with responsible operators. |
| Release and operations | Independently verified release evidence tied to the exact commit, clinician and privacy/security signoff, staff training, support and incident escalation, deployment/rollback rehearsal, and an approved clinical go-live decision. |

`deploy/production-release.pending.json` is an intentionally incomplete record template. The readiness checker validates attestation structure and release revision; it cannot verify the truth or sufficiency of external evidence. Never change pending decisions to approved without the named owner's actual review and retained evidence. This build remains blocked for production even with a completed record.
