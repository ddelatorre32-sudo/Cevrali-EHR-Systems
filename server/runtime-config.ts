import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RuntimeMode = "demo" | "pilot" | "production";
export type RuntimeConfig = Readonly<{
  mode: RuntimeMode;
  demoEnabled: boolean;
  publicSignupEnabled: boolean;
  requireMfa: boolean;
  secureCookies: boolean;
  publicBaseUrl: string | null;
  authEncryptionKeyFile: string | null;
  backupKeyFile: string | null;
  productionReleaseFile: string | null;
  releaseCommit: string | null;
  databasePath: string;
  accountsPath: string;
}>;

type Environment = Record<string, string | undefined>;
function configurationError(message: string): never {
  throw Object.assign(new Error(message), { code: "CEVRALI_RUNTIME_CONFIG" });
}
function booleanSetting(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  configurationError(`${name} must be exactly true or false.`);
}
function optionalPath(env: Environment, name: string): string | null {
  const value = env[name]?.trim();
  if (!value) return null;
  if (value.includes("\0")) configurationError(`${name} must be a filesystem path.`);
  return resolve(value);
}

/** Parsing is deliberately separate from file inspection. No secret values are
 * accepted as configuration fields or included in validation errors. */
export function loadRuntimeConfig(env: Environment = process.env): RuntimeConfig {
  const mode = env.CEVRALI_MODE || "demo";
  if (!["demo", "pilot", "production"].includes(mode))
    configurationError("CEVRALI_MODE must be demo, pilot, or production.");
  const protectedMode = mode !== "demo";
  const secureCookies = booleanSetting(env, "COOKIE_SECURE", false);
  const publicSignupEnabled = booleanSetting(env, "CEVRALI_PUBLIC_SIGNUP", !protectedMode);
  if (protectedMode && !secureCookies)
    configurationError("COOKIE_SECURE=true is required outside demo mode.");
  if (protectedMode && publicSignupEnabled)
    configurationError("Public practice signup is disabled outside demo mode. Use operator provisioning.");
  let publicBaseUrl: string | null = null;
  const configuredUrl = env.PUBLIC_BASE_URL?.trim();
  if (configuredUrl) {
    let url: URL;
    try { url = new URL(configuredUrl); }
    catch { configurationError("PUBLIC_BASE_URL must be a valid website origin."); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !["", "/"].includes(url.pathname))
      configurationError("PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.");
    if (protectedMode && url.protocol !== "https:")
      configurationError("PUBLIC_BASE_URL must use HTTPS outside demo mode.");
    publicBaseUrl = url.origin;
  } else if (protectedMode) {
    configurationError("PUBLIC_BASE_URL is required outside demo mode.");
  }
  const releaseCommit = env.CEVRALI_RELEASE_COMMIT?.trim() || null;
  if (releaseCommit && !/^[a-f0-9]{40}$/i.test(releaseCommit))
    configurationError("CEVRALI_RELEASE_COMMIT must be a full 40-character Git commit identifier.");
  const databasePath = optionalPath(env, "DATABASE_PATH") || resolve(".data/cevrali.sqlite");
  return Object.freeze({
    mode: mode as RuntimeMode,
    demoEnabled: !protectedMode,
    publicSignupEnabled,
    requireMfa: protectedMode,
    secureCookies,
    publicBaseUrl,
    authEncryptionKeyFile: optionalPath(env, "CEVRALI_AUTH_ENCRYPTION_KEY_FILE"),
    backupKeyFile: optionalPath(env, "CEVRALI_BACKUP_KEY_FILE"),
    productionReleaseFile: optionalPath(env, "CEVRALI_PRODUCTION_RELEASE_FILE"),
    releaseCommit,
    databasePath,
    accountsPath: optionalPath(env, "ACCOUNTS_PATH") || `${databasePath}.accounts`,
  });
}

/** Read a mounted key, never an environment value. The caller owns the returned
 * buffer and must not serialize it. Obvious repeated-byte material is rejected;
 * this check cannot prove that a key was generated using a secure random source. */
export function readRuntimeKeyFile(path: string | null, label: "authentication" | "backup"): Buffer {
  const message = `A private ${label} key file containing 32 random bytes encoded as Base64 is required.`;
  if (!path) configurationError(message);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 256 || info.size < 44 || (info.mode & 0o077) !== 0)
      configurationError(message);
    const encoded = readFileSync(descriptor, "utf8").trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) configurationError(message);
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded || new Set(key).size < 16)
      configurationError(message);
    return key;
  } catch {
    return configurationError(message);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
