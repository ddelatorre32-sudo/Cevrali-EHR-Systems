import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { patientAddressFields } from "./patient-demographics.js";
import { defaultPatientAccountId, ensurePatientAccounts } from "./patient-accounts.js";
import { initializePatientProfile, patientProfileRequest } from "./patient-profile-engine.js";
import type { Intake, WorkflowContext, WorkflowState } from "./workflow-engine.js";
import type {
  CheckInBillingAccount, CheckInContact, CheckInFile, CheckInListItem,
  CheckInPacket, CheckInPacketView, ConsentForm, DigitalCheckInState,
} from "./digital-checkin-model.js";

const short = z.string().trim().min(1).max(200);
const clientId = z.string().trim().min(8).max(100);
const revision = z.number().int().positive();
const contactInput = z.object({
  phone: z.string().trim().min(1).max(40),
  email: z.union([z.string().trim().email().max(254), z.literal("")]),
  ...patientAddressFields.shape,
}).strict();
const contactKeys = ["phone", "email", "address", "address_unit", "city", "state", "zip_code"] as const;
const formFields = z.object({ title: short, text: z.string().trim().min(1).max(20000) });
const maxImageBytes = 2 * 1024 * 1024;
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const digest = (data: string | Uint8Array) => Array.from(
  sha256(typeof data === "string" ? new TextEncoder().encode(data) : data),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

export function emptyDigitalCheckInState(): DigitalCheckInState {
  return {
    forms: [{
      id: "consent-electronic-registration", title: "Electronic registration",
      text: "I agree to submit this registration electronically to the practice. I have reviewed the information I entered and understand that staff will review it before updating my record. Uploading an insurance card does not verify coverage or change the insurance selected for my visit. I may contact the practice to complete registration on paper instead. This form does not authorize a particular medical treatment.",
      version: 1, revision: 1, archived: false,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }],
    packets: [],
  };
}

function stateOf(state: WorkflowState): DigitalCheckInState {
  return state.digital_checkin ||= emptyDigitalCheckInState();
}
function appointment(state: WorkflowState, ctx: WorkflowContext, packet: CheckInPacket | Intake) {
  const row = ctx.appointments.find((item) => item.id === packet.appointment_id && item.patient_id === packet.patient_id);
  return row || fail(404, "Registration appointment not found");
}
function account(state: WorkflowState, ctx: WorkflowContext, packet: CheckInPacket | Intake): CheckInBillingAccount {
  ensurePatientAccounts(state.finance, ctx);
  const visit = appointment(state, ctx, packet);
  const id = visit.billing_account_id || defaultPatientAccountId(packet.patient_id);
  const selected = state.finance.billing_accounts.find((item) => item.id === id && item.patient_id === packet.patient_id);
  if (!selected) fail(409, "The visit billing account needs staff review");
  return { id: selected.id, name: selected.name, kind: selected.kind };
}
export function ensureCheckInPacket(state: WorkflowState, ctx: WorkflowContext, intake: Intake): CheckInPacket {
  const digital = stateOf(state);
  const existing = digital.packets.find((item) => item.id === intake.id);
  if (existing) return existing;
  const packet: CheckInPacket = {
    id: intake.id, patient_id: intake.patient_id, appointment_id: intake.appointment_id,
    status: "Requested", revision: 1, created_at: intake.created_at,
    practice_name: ctx.practice?.name || "Your practice",
    billing_account: account(state, ctx, intake), contact: null,
    files: [], consents: digital.forms.filter((form) => !form.archived).map((form) => ({
      id: `${intake.id}-${form.id}`, form_id: form.id,
      title: form.title, text: form.text, version: form.version,
      sha256: digest(JSON.stringify({ title: form.title, text: form.text, version: form.version })),
    })),
    no_card_reason: "", requests: [],
  };
  digital.packets.push(packet);
  return packet;
}
function intakeForPacket(state: WorkflowState, packet: CheckInPacket) {
  return state.intakes.find((item) => item.id === packet.id) || fail(404, "Registration link not found");
}
function requireStaff(ctx: WorkflowContext) {
  const member = ctx.users.find((user) => user.id === ctx.user.id);
  if (!["clinician", "receptionist"].includes(ctx.user.role) ||
    ctx.user.is_active === false || ctx.user.is_active === 0 || !member ||
    member.is_active === false || member.is_active === 0 || member.role !== ctx.user.role)
    fail(403, "Active practice staff access required");
}
function requireAdmin(ctx: WorkflowContext) {
  requireStaff(ctx);
  if (!ctx.user.is_admin) fail(403, "Practice administrator access required");
}
function checkRevision(packet: CheckInPacket, expected: number) {
  if (packet.revision !== expected)
    fail(409, "Registration changed. Reload it before saving.");
}
function requireDraft(state: WorkflowState, ctx: WorkflowContext, packet: CheckInPacket, expected: number) {
  checkRevision(packet, expected);
  if (packet.status !== "Requested") fail(409, "This registration has already been submitted");
  if (["Cancelled", "Completed", "No-show"].includes(appointment(state, ctx, packet).status))
    fail(409, "This appointment is closed; contact the practice about registration");
}
function fileMetadata(file: CheckInPacket["files"][number]): CheckInFile {
  const { data_base64: _bytes, client_id: _client, ...metadata } = file;
  return structuredClone(metadata);
}
function summary(state: WorkflowState, ctx: WorkflowContext, packet: CheckInPacket): CheckInListItem {
  const patient = ctx.patients.find((item) => item.id === packet.patient_id) || fail(404, "Patient not found");
  const visit = appointment(state, ctx, packet);
  const intake = intakeForPacket(state, packet);
  return {
    id: packet.id, patient_id: packet.patient_id, appointment_id: packet.appointment_id,
    patient_name: `${patient.first_name} ${patient.last_name}`, status: packet.status,
    created_at: packet.created_at, submitted_at: packet.submitted_at, reviewed_at: packet.reviewed_at,
    appointment: { date: visit.date, time: visit.time, status: visit.status },
    intake_status: intake.status,
    link_expired: intake.status === "Revoked" || intake.expires_at <= ctx.now,
    billing_account: structuredClone(packet.billing_account),
    account_mismatch: account(state, ctx, packet).id !== packet.billing_account.id,
    card_count: packet.files.filter((file) => !file.superseded_at).length,
    signed_consent_count: packet.consents.filter((consent) => consent.signature).length,
    consent_count: packet.consents.length,
  };
}
function contactOf(patient: Record<string, any>): CheckInContact {
  return Object.fromEntries(contactKeys.map((key) => [key, patient[key] || ""])) as CheckInContact;
}
function view(state: WorkflowState, ctx: WorkflowContext, packet: CheckInPacket, staff = false): CheckInPacketView {
  const result: CheckInPacketView = {
    ...summary(state, ctx, packet), revision: packet.revision,
    practice_name: packet.practice_name || ctx.practice?.name || "Your practice",
    contact: packet.contact ? structuredClone(packet.contact) : null,
    files: packet.files.filter((file) => staff || !file.superseded_at).map(fileMetadata),
    consents: structuredClone(packet.consents), no_card_reason: packet.no_card_reason,
    expires_at: intakeForPacket(state, packet).expires_at,
  };
  if (staff) {
    const patient = ctx.patients.find((item) => item.id === packet.patient_id) || fail(404, "Patient not found");
    result.current_contact = contactOf(patient);
    result.demographics_revision = initializePatientProfile(state, ctx, patient).demographics_revision;
    result.current_billing_account = account(state, ctx, packet);
    result.reviewed_by_name = packet.reviewed_by_name;
    result.review_reason = packet.review_reason;
    result.demographics_applied = packet.demographics_applied;
  }
  return result;
}

// The uploaded bytes remain attachments. This parser rejects malformed image
// containers before storing them; it never runs or interprets document text.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(bytes: Uint8Array) {
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!magic.every((byte, index) => bytes[index] === byte)) fail(400, "Attach a valid PNG image");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, sawHeader = false, sawData = false, sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset);
    if (offset + length + 12 > bytes.length) fail(400, "PNG image is incomplete");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) fail(400, "PNG image has an invalid chunk");
    if (crc32(bytes.subarray(offset + 4, offset + length + 8)) !== data.getUint32(offset + length + 8))
      fail(400, "PNG image is damaged");
    if (!sawHeader && type !== "IHDR") fail(400, "PNG image header is missing");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail(400, "PNG image header is invalid");
      const width = data.getUint32(offset + 8), height = data.getUint32(offset + 12);
      if (!width || !height || width > 12000 || height > 12000 || width * height > 25000000)
        fail(400, "Insurance card image dimensions exceed the limit");
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1)
        fail(400, "PNG image encoding is invalid");
      sawHeader = true;
    } else if (type === "IDAT") {
      if (length) sawData = true;
    } else if (type === "IEND") {
      if (length || !sawData || offset + 12 !== bytes.length) fail(400, "PNG image end is invalid");
      sawEnd = true;
      break;
    } else if (type[0] === type[0].toUpperCase() && type !== "PLTE") {
      fail(400, "Unsupported PNG image chunk");
    }
    offset += length + 12;
  }
  if (!sawHeader || !sawData || !sawEnd) fail(400, "PNG image is incomplete");
}
function validateJpeg(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) fail(400, "Attach a valid JPEG image");
  let offset = 2, sawFrame = false, sawScan = false, ended = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail(400, "JPEG image has an invalid marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (offset !== bytes.length || !sawFrame || !sawScan) fail(400, "JPEG image end is invalid");
      ended = true; break;
    }
    if (marker === 0xd8 || marker === 0 || marker === undefined || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      fail(400, "JPEG image marker is invalid");
    if (offset + 2 > bytes.length) fail(400, "JPEG image is incomplete");
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) fail(400, "JPEG image is incomplete");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || sawFrame) fail(400, "JPEG frame is invalid");
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const components = bytes[offset + 7];
      if (!width || !height || width > 12000 || height > 12000 || width * height > 25000000 ||
        ![1, 3, 4].includes(components) || length !== 8 + components * 3 || bytes[offset + 2] !== 8)
        fail(400, "JPEG image dimensions or encoding are unsupported");
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!sawFrame) fail(400, "JPEG frame is missing");
      sawScan = true;
      // Entropy data escapes 0xff as 0xff00; restart markers remain inside a scan.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) { offset = next + 1; continue; }
        break;
      }
    }
  }
  if (!ended) fail(400, "JPEG image is incomplete");
}
function imageBytes(base64: string, mime: string): Uint8Array {
  // Avoid a quantified group over multi-megabyte data, which can overflow the
  // regular-expression stack even for a valid image near the size limit.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const content = base64.slice(0, base64.length - padding);
  if (base64.length > Math.ceil(maxImageBytes / 3) * 4 || base64.length % 4 !== 0 ||
    !content.length || /[^A-Za-z0-9+/]/.test(content))
    fail(400, "Attach a PNG or JPEG insurance card image up to 2 MB");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)); }
  catch { fail(400, "Image encoding is invalid"); }
  if (!bytes.length || bytes.length > maxImageBytes) fail(400, "Attach an insurance card image up to 2 MB");
  if (mime === "image/png") validatePng(bytes);
  else validateJpeg(bytes);
  return bytes;
}
function repeated(packet: CheckInPacket, action: string, id: string, fingerprint: string) {
  const existing = packet.requests.find((request) => request.client_id === id);
  if (!existing) return false;
  if (existing.action !== action || existing.fingerprint !== fingerprint)
    fail(409, "This request identifier was already used for different registration information");
  return true;
}
function remember(packet: CheckInPacket, action: string, id: string, fingerprint: string) {
  packet.requests.push({ action, client_id: id, fingerprint });
  packet.revision++;
}
function readFile(packet: CheckInPacket, id: string) {
  const file = packet.files.find((item) => item.id === id) || fail(404, "Registration file not found");
  return { ...fileMetadata(file), data_base64: file.data_base64 };
}

function publicRequest(state: WorkflowState, ctx: WorkflowContext, method: string, parts: string[], body: unknown) {
  const intake = state.intakes.find((item) => item.token_hash === ctx.tokenHash) || fail(404, "This intake link is invalid");
  if (intake.status === "Revoked" || intake.expires_at <= ctx.now)
    fail(410, "This intake link has expired. Please contact the practice.");
  const packet = ensureCheckInPacket(state, ctx, intake);
  const action = parts[3], id = parts[4];
  if (parts.length > 5 || parts[0] !== "public-intake" || parts[1] !== "link" || parts[2] !== "registration")
    fail(404, "Registration route not found");
  if (method === "GET" && !action) return view(state, ctx, packet);
  if (method === "GET" && action === "files" && id) return readFile(packet, id);
  if (method === "POST" && !action) {
    const input = z.object({ revision, contact: contactInput, client_id: clientId.optional() }).strict().parse(body);
    const fingerprint = digest(JSON.stringify(input.contact));
    if (input.client_id && repeated(packet, "contact", input.client_id, fingerprint)) return view(state, ctx, packet);
    requireDraft(state, ctx, packet, input.revision);
    packet.contact = input.contact;
    if (input.client_id) remember(packet, "contact", input.client_id, fingerprint);
    else packet.revision++;
    ctx.audit("Patient self-service: saved registration contact details", packet.id);
    return view(state, ctx, packet);
  }
  if (method === "POST" && action === "files" && !id) {
    const input = z.object({ revision, side: z.enum(["Front", "Back"]),
      name: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f<>/\\]+$/, "Use a plain image filename"),
      mime_type: z.enum(["image/png", "image/jpeg"]), data_base64: z.string().max(2800000), client_id: clientId,
    }).strict().parse(body);
    const bytes = imageBytes(input.data_base64, input.mime_type);
    const hash = digest(bytes);
    const fingerprint = digest(JSON.stringify({ side: input.side, name: input.name, mime_type: input.mime_type, sha256: hash }));
    if (repeated(packet, "file", input.client_id, fingerprint)) return view(state, ctx, packet);
    requireDraft(state, ctx, packet, input.revision);
    if (packet.files.length >= 10) fail(400, "Contact the practice if more insurance card replacements are needed");
    for (const file of packet.files) if (file.side === input.side && !file.superseded_at) file.superseded_at = ctx.now;
    // A valid image may contain arbitrary text in metadata. Always retain an
    // image extension so opening a downloaded attachment cannot invoke an HTML
    // handler merely because the submitted filename ended in .html.
    const safeName = `${input.name.replace(/\.[^.\s]+$/, "").slice(0, 150) || "insurance-card"}.${input.mime_type === "image/png" ? "png" : "jpg"}`;
    packet.files.push({ id: ctx.id("registration-file"), side: input.side,
      name: safeName, mime_type: input.mime_type, size: bytes.length, sha256: hash,
      data_base64: input.data_base64, uploaded_at: ctx.now, client_id: input.client_id });
    remember(packet, "file", input.client_id, fingerprint);
    ctx.audit(`Patient self-service: uploaded insurance card ${input.side.toLowerCase()}`, packet.id);
    return view(state, ctx, packet);
  }
  if (method === "POST" && action === "consents" && id) {
    const input = z.object({ revision, client_id: clientId, signer_name: short,
      signer_role: z.enum(["Patient", "Representative"]), relationship: z.string().trim().max(200), agree: z.literal(true),
    }).strict().parse(body);
    if (input.signer_role === "Representative" && !input.relationship) fail(400, "Describe your relationship to the patient");
    const consent = packet.consents.find((item) => item.id === id) || fail(404, "Registration consent not found");
    const fingerprint = digest(JSON.stringify({ id, signer_name: input.signer_name, signer_role: input.signer_role,
      relationship: input.relationship, agree: input.agree }));
    if (repeated(packet, "consent", input.client_id, fingerprint)) return view(state, ctx, packet);
    requireDraft(state, ctx, packet, input.revision);
    if (consent.signature) fail(409, "This consent is already signed and cannot be changed");
    consent.signature = { signer_name: input.signer_name, signer_role: input.signer_role,
      relationship: input.relationship, signed_at: ctx.now, client_id: input.client_id };
    remember(packet, "consent", input.client_id, fingerprint);
    ctx.audit("Patient self-service: signed electronic registration consent", `${packet.id}:${consent.form_id}:v${consent.version}`);
    return view(state, ctx, packet);
  }
  if (method === "POST" && action === "submit" && !id) {
    const input = z.object({ revision, client_id: clientId, no_card_reason: z.string().trim().max(500).default("") }).strict().parse(body);
    const fingerprint = digest(JSON.stringify({ no_card_reason: input.no_card_reason }));
    if (repeated(packet, "submit", input.client_id, fingerprint)) return view(state, ctx, packet);
    requireDraft(state, ctx, packet, input.revision);
    if (!packet.contact) fail(400, "Save your contact details before submitting registration");
    if (packet.consents.some((consent) => !consent.signature)) fail(400, "Review and sign each consent before submitting registration");
    if (!packet.files.some((file) => file.side === "Front" && !file.superseded_at) && !input.no_card_reason)
      fail(400, "Upload the front of your insurance card or explain why a card is unavailable");
    packet.no_card_reason = input.no_card_reason;
    packet.status = "Submitted"; packet.submitted_at = ctx.now;
    remember(packet, "submit", input.client_id, fingerprint);
    ctx.audit("Patient self-service: submitted digital registration for staff review", packet.id);
    return view(state, ctx, packet);
  }
  fail(404, "Registration route not found");
}

function formsRequest(state: WorkflowState, ctx: WorkflowContext, method: string, parts: string[], body: unknown) {
  const forms = stateOf(state).forms;
  if (parts.length > 3) fail(404, "Consent form route not found");
  const id = parts[2];
  if (method === "GET" && !id) return structuredClone(forms);
  requireAdmin(ctx);
  if (method === "POST" && !id) {
    const input = formFields.extend({ client_id: clientId }).strict().parse(body);
    const existing = forms.find((form) => form.client_id === input.client_id && form.created_by === ctx.user.id);
    if (existing) {
      if (existing.title !== input.title || existing.text !== input.text) fail(409, "This form request identifier was already used");
      return structuredClone(existing);
    }
    if (forms.filter((form) => !form.archived).length >= 10) fail(400, "Keep at most 10 active registration consent forms");
    const form: ConsentForm = { id: ctx.id("consent-form"), title: input.title, text: input.text,
      version: 1, revision: 1, archived: false, created_at: ctx.now, updated_at: ctx.now,
      client_id: input.client_id, created_by: ctx.user.id };
    forms.push(form);
    ctx.audit("Created registration consent form", form.id);
    return structuredClone(form);
  }
  if (method === "PATCH" && id) {
    const input = formFields.partial().extend({ revision, archived: z.boolean().optional() }).strict().parse(body);
    const form = forms.find((item) => item.id === id) || fail(404, "Consent form not found");
    if (input.revision !== form.revision) fail(409, "This consent form changed. Reload it before saving.");
    if (input.title === undefined && input.text === undefined && input.archived === undefined) fail(400, "Choose a form change to save");
    if (input.archived === false && form.archived && forms.filter((item) => !item.archived).length >= 10)
      fail(400, "Keep at most 10 active registration consent forms");
    const contentChanged = (input.title !== undefined && input.title !== form.title) || (input.text !== undefined && input.text !== form.text);
    if (input.title !== undefined) form.title = input.title;
    if (input.text !== undefined) form.text = input.text;
    if (input.archived !== undefined) form.archived = input.archived;
    if (contentChanged) form.version++;
    form.revision++; form.updated_at = ctx.now;
    ctx.audit("Updated registration consent form; existing packet snapshots retained", form.id);
    return structuredClone(form);
  }
  fail(404, "Consent form route not found");
}

export function digitalCheckInRequest(state: WorkflowState, ctx: WorkflowContext,
  method: string, url: URL, body: unknown = {}): unknown {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "public-intake") return publicRequest(state, ctx, method, parts, body);
  if (parts[0] !== "digital-checkin") fail(404, "Digital check-in route not found");
  requireStaff(ctx);
  if (parts[1] === "forms") return formsRequest(state, ctx, method, parts, body);
  const digital = stateOf(state);
  if (method === "GET" && parts.length === 1) {
    for (const intake of state.intakes) if (intake.status !== "Revoked") ensureCheckInPacket(state, ctx, intake);
    const patientId = url.searchParams.get("patient_id");
    return digital.packets.filter((packet) => (!patientId || packet.patient_id === patientId) &&
      (packet.status !== "Requested" || intakeForPacket(state, packet).status !== "Revoked"))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((packet) => summary(state, ctx, packet));
  }
  const packet = digital.packets.find((item) => item.id === parts[1]) || fail(404, "Digital registration not found");
  if (method === "GET" && parts.length === 2) {
    ctx.audit("Viewed digital registration", packet.id);
    return view(state, ctx, packet, true);
  }
  if (method === "GET" && parts.length === 4 && parts[2] === "files") {
    const file = readFile(packet, parts[3]);
    ctx.audit("Downloaded registration insurance card", file.id);
    return file;
  }
  if (method === "POST" && parts.length === 3 && parts[2] === "review") {
    const input = z.object({ revision, demographics_revision: revision, apply_demographics: z.boolean(),
      reason: z.string().trim().min(1).max(500), account_mismatch_acknowledged: z.boolean().optional() }).strict().parse(body);
    checkRevision(packet, input.revision);
    if (packet.status !== "Submitted") fail(409, "Only submitted registration can be reviewed");
    const patient = ctx.patients.find((item) => item.id === packet.patient_id) || fail(404, "Patient not found");
    const profile = initializePatientProfile(state, ctx, patient);
    if (profile.demographics_revision !== input.demographics_revision)
      fail(409, "Patient details changed. Reload registration before reviewing.");
    const currentAccount = account(state, ctx, packet);
    if (currentAccount.id !== packet.billing_account.id && !input.account_mismatch_acknowledged)
      fail(409, "The visit insurance account changed. Review the original card account and acknowledge the difference.");
    if (input.apply_demographics) {
      if (!packet.contact) fail(409, "No patient contact details are available to apply");
      patientProfileRequest(state, ctx, "PATCH", new URL(`/patient-profiles/${encodeURIComponent(patient.id)}/demographics`, url), {
        revision: input.demographics_revision, reason: `Digital registration ${packet.id}: ${input.reason}`.slice(0, 500), ...packet.contact,
      });
    }
    packet.status = "Reviewed"; packet.reviewed_at = ctx.now;
    packet.reviewed_by = ctx.user.id; packet.reviewed_by_name = ctx.user.name;
    packet.review_reason = input.reason; packet.demographics_applied = input.apply_demographics;
    packet.account_mismatch_acknowledged = Boolean(input.account_mismatch_acknowledged);
    packet.reviewed_billing_account = structuredClone(currentAccount); packet.revision++;
    ctx.audit("Reviewed digital registration and insurance card attachments", packet.id);
    return view(state, ctx, packet, true);
  }
  fail(404, "Digital check-in route not found");
}
