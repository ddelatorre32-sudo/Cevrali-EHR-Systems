#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const usage = `Create an encrypted offline Cevrali backup:
  node scripts/backup.mjs --output /backups/snapshot.cevrali-backup --key-file /secrets/backup.key
  Optional: --database /data/cevrali.sqlite --accounts /data/accounts

Authenticate and inspect an existing archive:
  node scripts/backup.mjs --verify --archive /backups/snapshot.cevrali-backup --key-file /secrets/backup.key

Database paths default to DATABASE_PATH and ACCOUNTS_PATH, then the application defaults.
The key path may be supplied as CEVRALI_BACKUP_KEY_FILE. The key itself is never an argument.
Stop the application before creating a backup. Existing archives are never overwritten.
`;

try {
  const options = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--help") { process.stdout.write(usage); process.exit(0); }
    if (!["--verify", "--archive", "--output", "--key-file", "--database", "--accounts"].includes(name) || options.has(name))
      throw Object.assign(new Error("Invalid or duplicate backup option. Use --help for usage."), { code: "CEVRALI_BACKUP_ERROR" });
    if (name === "--verify") { options.set(name, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw Object.assign(new Error("A backup option is missing its value. Use --help for usage."), { code: "CEVRALI_BACKUP_ERROR" });
    options.set(name, value);
  }
  const keyFile = options.get("--key-file") || process.env.CEVRALI_BACKUP_KEY_FILE;
  const verifying = options.has("--verify");
  if (!keyFile || (verifying ? !options.has("--archive") || options.has("--output") || options.has("--database") || options.has("--accounts") : !options.has("--output") || options.has("--archive")))
    throw Object.assign(new Error("Supply the required backup paths. Use --help for usage."), { code: "CEVRALI_BACKUP_ERROR" });
  const moduleUrl = new URL("../dist-server/backup.js", import.meta.url);
  if (!existsSync(moduleUrl))
    throw Object.assign(new Error("Build the server with npm run build before running backup tools."), { code: "CEVRALI_BACKUP_ERROR" });
  const { createEncryptedBackup, verifyEncryptedBackup } = await import(moduleUrl.href);
  let result;
  if (verifying) result = await verifyEncryptedBackup({ backupPath: resolve(options.get("--archive")), keyFile: resolve(keyFile) });
  else {
    const databasePath = resolve(options.get("--database") || process.env.DATABASE_PATH || ".data/cevrali.sqlite");
    const accountsPath = resolve(options.get("--accounts") || process.env.ACCOUNTS_PATH || `${databasePath}.accounts`);
    result = await createEncryptedBackup({ databasePath, accountsPath, outputPath: resolve(options.get("--output")), keyFile: resolve(keyFile) });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code === "CEVRALI_BACKUP_ERROR" ? error.message : "Backup operation failed. Verify the paths, permissions, available disk space, and stopped service, then retry."}\n`);
  process.exitCode = 1;
}
