import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { loadRuntimeConfig, readRuntimeKeyFile, type RuntimeConfig } from "./runtime-config.js";

export type ReadinessCheck = {
  id: string;
  status: "passed" | "blocked" | "pending";
  detail: string;
};
export type ReadinessReport = {
  mode: RuntimeConfig["mode"];
  startup_allowed: boolean;
  clinical_use_allowed: false;
  scope: "synthetic-demo" | "synthetic-staff-pilot" | "clinical-production-blocked";
  release_commit: string | null;
  release_evidence_sha256: string | null;
  checks: ReadinessCheck[];
  note: string;
};

export const RELEASE_APPROVAL_AREAS = ["security", "clinical", "privacy", "restore", "hosting", "operations"] as const;
const evidenceNote = "Evidence references and owner attestations require independent review. Passing a configuration check does not certify clinical safety or compliance.";

function inspectRelease(config: RuntimeConfig, now: Date): { checks: ReadinessCheck[]; digest: string | null } {
  const blocked = (detail: string) => ({ checks: [{ id: "release-evidence", status: "blocked" as const, detail }], digest: null });
  if (!config.productionReleaseFile)
    return blocked("A reviewed production release evidence file has not been supplied.");
  let raw: Buffer, record: Record<string, any>;
  try {
    const info = lstatSync(config.productionReleaseFile);
    if (!info.isFile() || info.size > 65536 || info.size === 0) return blocked("The production release evidence file is invalid.");
    raw = readFileSync(config.productionReleaseFile);
    record = JSON.parse(raw.toString("utf8"));
    if (!record || Array.isArray(record) || record.schema_version !== 1 || record.environment !== "production")
      return blocked("The production release evidence must use schema version 1 and the production environment.");
  } catch { return blocked("The production release evidence file is missing, unreadable, or malformed."); }
  const checks: ReadinessCheck[] = [];
  checks.push({
    id: "release-revision",
    status: config.releaseCommit && record.release_commit === config.releaseCommit ? "passed" : "blocked",
    detail: config.releaseCommit && record.release_commit === config.releaseCommit
      ? "The evidence record identifies the configured release revision."
      : "The evidence must identify the same full commit as CEVRALI_RELEASE_COMMIT.",
  });
  for (const area of RELEASE_APPROVAL_AREAS) {
    const approval = record.approvals?.[area];
    const date = typeof approval?.reviewed_at === "string" ? Date.parse(approval.reviewed_at) : NaN;
    const owner = typeof approval?.owner === "string" ? approval.owner.trim() : "";
    const reference = typeof approval?.evidence_ref === "string" ? approval.evidence_ref.trim() : "";
    const valid = approval?.decision === "approved" && owner.length >= 2 && owner.length <= 200 &&
      reference.length >= 3 && reference.length <= 1000 && !/^(pending|todo|replace|example|none|n\/a)$/i.test(reference) &&
      Number.isFinite(date) && date <= now.getTime() &&
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(approval.reviewed_at) &&
      new Date(date).toISOString().slice(0, 10) === approval.reviewed_at.slice(0, 10);
    checks.push({ id: `approval-${area}`, status: valid ? "passed" : "blocked",
      detail: valid ? `${area} owner attestation and an evidence reference are recorded; independent verification remains required.`
        : `${area} requires an approved owner attestation, a non-future review date, and an evidence reference.` });
  }
  return { checks, digest: createHash("sha256").update(raw).digest("hex") };
}

/** Safe for operator output: file contents, keys, owner names, and arbitrary
 * evidence text are deliberately never copied into this report. */
export function readinessReport(config: RuntimeConfig = loadRuntimeConfig(), options: { now?: Date } = {}): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const protectedMode = config.mode !== "demo";
  const scopeConfigured = !protectedMode || (!config.demoEnabled && !config.publicSignupEnabled && config.requireMfa);
  checks.push({ id: "runtime-scope", status: scopeConfigured ? "passed" : "blocked", detail: config.mode === "demo"
    ? "Synthetic demo mode; public demo accounts and signup may be available."
    : scopeConfigured ? "Demo seeding and public signup are disabled; staff MFA is required."
      : "Protected modes must disable demo accounts and public signup and require staff MFA." });
  checks.push({ id: "https-session-policy", status: !protectedMode || (config.secureCookies && Boolean(config.publicBaseUrl?.startsWith("https://"))) ? "passed" : "blocked",
    detail: protectedMode ? "HTTPS origin and Secure session cookies are required." : "Demo mode permits local HTTP; no real patient information is permitted." });
  const keys: Partial<Record<"authentication" | "backup", Buffer>> = {};
  if (protectedMode) {
    for (const [label, path] of [["authentication", config.authEncryptionKeyFile], ["backup", config.backupKeyFile]] as const) {
      try {
        keys[label] = readRuntimeKeyFile(path, label);
        checks.push({ id: `${label}-key`, status: "passed", detail: `The mounted ${label} key file has valid format and private file permissions.` });
      } catch {
        checks.push({ id: `${label}-key`, status: "blocked", detail: `Supply a readable private ${label} key file containing 32 random bytes encoded as Base64.` });
      }
    }
    if (keys.authentication && keys.backup)
      checks.push({ id: "key-separation", status: timingSafeEqual(keys.authentication, keys.backup) ? "blocked" : "passed",
        detail: "Authentication and backup encryption must use different keys." });
  }
  for (const key of Object.values(keys)) key?.fill(0);
  let evidenceDigest: string | null = null;
  if (config.mode === "production") {
    const release = inspectRelease(config, options.now || new Date());
    checks.push(...release.checks); evidenceDigest = release.digest;
    // These capabilities are intentionally code-owned. Operator checkboxes or
    // environment variables cannot activate clinical transports that do not exist.
    checks.push({ id: "live-clinical-services", status: "blocked",
      detail: "This build has no live pharmacy/EPCS, laboratory, fax, or payer/claims transports. Completing a release file does not activate them." });
    checks.push({ id: "clinical-release", status: "blocked",
      detail: "Real patient use remains disabled in this build. Complete and independently verify the production release requirements before a clinical release is implemented." });
  } else {
    checks.push({ id: "clinical-release", status: "pending", detail: "This mode is restricted to synthetic patients. Clinical production approval and live integrations remain outstanding." });
  }
  return {
    mode: config.mode,
    startup_allowed: config.mode === "demo" || !checks.some(check => check.status === "blocked"),
    clinical_use_allowed: false,
    scope: config.mode === "demo" ? "synthetic-demo" : config.mode === "pilot" ? "synthetic-staff-pilot" : "clinical-production-blocked",
    release_commit: config.releaseCommit,
    release_evidence_sha256: evidenceDigest,
    checks,
    note: evidenceNote,
  };
}

export function validateStartup(config: RuntimeConfig = loadRuntimeConfig()): ReadinessReport {
  const report = readinessReport(config);
  if (!report.startup_allowed)
    throw Object.assign(new Error(`Cevrali startup blocked: ${report.checks.filter(check => check.status === "blocked").map(check => check.detail).join(" ")}`), { code: "CEVRALI_STARTUP_BLOCKED" });
  return report;
}
