#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const usage = `Restore an authenticated Cevrali archive into a new directory:
  node scripts/restore.mjs --archive /backups/snapshot.cevrali-backup --destination /data/recovered --key-file /secrets/backup.key

The destination must not exist. Existing patient data is never overwritten.
The key path may be supplied as CEVRALI_BACKUP_KEY_FILE. The key itself is never an argument.
The result contains database_path and accounts_path for the recovered environment.
All prior sessions, pending authentication challenges, recovery codes, intake links,
and pending staff invitations are revoked. Authenticator enrollment is preserved.
`;

try {
  const options = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--help") { process.stdout.write(usage); process.exit(0); }
    if (!["--archive", "--destination", "--key-file"].includes(name) || options.has(name))
      throw Object.assign(new Error("Invalid or duplicate restore option. Use --help for usage."), { code: "CEVRALI_BACKUP_ERROR" });
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw Object.assign(new Error("A restore option is missing its value. Use --help for usage."), { code: "CEVRALI_BACKUP_ERROR" });
    options.set(name, value);
  }
  const keyFile = options.get("--key-file") || process.env.CEVRALI_BACKUP_KEY_FILE;
  if (!keyFile || !options.has("--archive") || !options.has("--destination"))
    throw Object.assign(new Error("Supply the required restore paths. Use --help for usage."), { code: "CEVRALI_BACKUP_ERROR" });
  const moduleUrl = new URL("../dist-server/backup.js", import.meta.url);
  if (!existsSync(moduleUrl))
    throw Object.assign(new Error("Build the server with npm run build before running recovery tools."), { code: "CEVRALI_BACKUP_ERROR" });
  const { restoreEncryptedBackup } = await import(moduleUrl.href);
  const result = await restoreEncryptedBackup({ backupPath: resolve(options.get("--archive")), keyFile: resolve(keyFile), destinationPath: resolve(options.get("--destination")) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code === "CEVRALI_BACKUP_ERROR" ? error.message : "Restore operation failed. Verify the archive, key, destination parent, permissions, and available disk space, then retry."}\n`);
  process.exitCode = 1;
}
