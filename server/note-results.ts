import { z } from "zod";
import type { WorkflowState, WorkflowContext } from "./workflow-engine.js";
import type { IncomingFax } from "./operations-engine.js";
import { flagSignedSourceCorrection } from "./note-addenda.js";
const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
export type NoteResult = {
  source_type?: "Fax" | "Lab result";
  id: string;
  encounter_id: string;
  patient_id: string;
  billing_account_id: string;
  document_id: string;
  source_digest: string;
  /** Revision of the clinical source content, separate from review metadata. */
  source_revision?: number;
  /** Exclusion must not erase the requirement to copy a corrected source. */
  source_invalidated?: boolean;
  source_sender: string;
  source_kind: string;
  received_at: string;
  text: string;
  status: "Pending review" | "Included" | "Excluded" | "Source changed";
  revision: number;
  reviewed_by: string;
  reviewed_at: string | null;
  review_note: string;
};
type ReportSource = Pick<
  IncomingFax,
  | "id"
  | "patient_id"
  | "billing_account_id"
  | "status"
  | "digest"
  | "sender"
  | "kind"
  | "received_at"
  | "extraction_issue"
  | "extracted_text"
> & { revision?: number; content_revision?: number } & Partial<
    Pick<IncomingFax, "reviewed_at" | "reviewed_by" | "clinical_task_id">
  >;
const account = (n: Record<string, any>) =>
  n.billing_account_id || `pba-private-${n.patient_id}`;
function fits(f: ReportSource, n: Record<string, any>) {
  return (
    f.status === "Filed" &&
    f.patient_id === n.patient_id &&
    (f.billing_account_id
      ? f.billing_account_id === account(n)
      : account(n) === `pba-private-${n.patient_id}`)
  );
}
function matchesCopiedSource(
  r: NoteResult,
  f: ReportSource | undefined,
  n: Record<string, any>,
) {
  return Boolean(
    f &&
    !r.source_invalidated &&
    r.status !== "Source changed" &&
    r.patient_id === n.patient_id &&
    r.billing_account_id === account(n) &&
    fits(f, n) &&
    !f.extraction_issue &&
    r.text.trim() &&
    f.extracted_text.trim() &&
    r.text === f.extracted_text &&
    r.source_digest === f.digest &&
    r.source_sender === f.sender &&
    r.source_kind === f.kind &&
    r.received_at === f.received_at &&
    // Older valid copies did not record a source revision. Their complete
    // content/provenance comparison above remains the migration fallback.
    (r.source_revision === undefined ||
      r.source_revision === (f.content_revision ?? f.revision)),
  );
}
function link(
  state: WorkflowState,
  ctx: WorkflowContext,
  f: ReportSource,
  n: Record<string, any>,
  sourceType: "Fax" | "Lab result" = "Fax",
) {
  if (!fits(f, n))
    fail(400, "Report must match the note patient and visit account");
  if (n.status !== "Draft")
    fail(409, "Only draft notes can receive outside results");
  const old = state.operations.note_results.find(
    (r) => r.document_id === f.id && r.encounter_id === n.id,
  );
  if (old && matchesCopiedSource(old, f, n)) return old;
  if (!f.extracted_text.trim() || f.extraction_issue)
    fail(
      409,
      "Review and transcribe unreadable scans manually; extracted text is unavailable or incomplete",
    );
  // Establish a stable content revision when first copying a legacy fax.
  // A later clinical-review acknowledgment may change its general revision.
  if (f.content_revision === undefined && f.revision !== undefined)
    f.content_revision = f.revision;
  const result: NoteResult = {
    source_type: sourceType,
    id: old?.id || ctx.id("note-result"),
    encounter_id: n.id,
    patient_id: n.patient_id,
    billing_account_id: account(n),
    document_id: f.id,
    source_digest: f.digest,
    source_revision: f.content_revision ?? f.revision,
    source_invalidated: false,
    source_sender: f.sender,
    source_kind: f.kind,
    received_at: f.received_at,
    text: f.extracted_text,
    status: "Pending review",
    revision: (old?.revision || 0) + 1,
    reviewed_by: "",
    reviewed_at: null,
    review_note: "",
  };
  if (old) Object.assign(old, result);
  else state.operations.note_results.push(result);
  ctx.audit("Populated draft note with source-linked outside results", n.id);
  return result;
}
function labSource(
  state: WorkflowState,
  ctx: WorkflowContext,
  id: string,
): ReportSource | undefined {
  const r = state.results.find((r) => r.id === id);
  if (!r) return;
  const order = state.orders.find((o) => o.id === r.order_id);
  const n = ctx.encounters.find(
    (n) => n.id === order?.encounter_id && n.patient_id === r.patient_id,
  );
  if (!n) return;
  return {
    id: r.id,
    content_revision: 1,
    patient_id: r.patient_id,
    billing_account_id: account(n),
    status: "Filed",
    digest: r.external_id,
    sender: "Recorded laboratory result",
    kind: "Lab report",
    received_at: r.recorded_at || `${r.date}T12:00:00Z`,
    extraction_issue: "",
    extracted_text: `${r.name}: ${r.value} ${r.unit}\nReference range: ${r.reference_range || "Not supplied"}\nReported flag: ${r.flag}\nResult date: ${r.date}\nExternal reference: ${r.external_id}\nOrder: ${order!.id}`,
  };
}
function resultSource(
  state: WorkflowState,
  ctx: WorkflowContext,
  r: NoteResult,
) {
  return r.source_type === "Lab result"
    ? labSource(state, ctx, r.document_id)
    : state.operations.incoming_faxes.find((f) => f.id === r.document_id);
}
export function syncStructuredNoteResults(
  state: WorkflowState,
  ctx: WorkflowContext,
) {
  for (const r of state.results) {
    const order = state.orders.find((o) => o.id === r.order_id);
    const n = ctx.encounters.find(
      (n) =>
        n.id === order?.encounter_id &&
        n.patient_id === r.patient_id &&
        n.status === "Draft",
    );
    if (!n) continue;
    const f = labSource(state, ctx, r.id);
    if (f) link(state, ctx, f, n, "Lab result");
  }
}
export function syncDocumentResults(
  state: WorkflowState,
  ctx: WorkflowContext,
) {
  const localDay = (value: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
    }).format(
      new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z"),
    );
  for (const f of state.operations.incoming_faxes.filter(
    (f) =>
      f.status === "Filed" &&
      ["Lab report", "Radiology report"].includes(f.kind) &&
      !f.extraction_issue,
  )) {
    if (
      localDay(f.received_at) !== ctx.today ||
      state.operations.note_results.some((r) => r.document_id === f.id)
    )
      continue;
    const candidates = ctx.encounters.filter(
      (n) =>
        n.status === "Draft" &&
        fits(f, n) &&
        localDay(n.updated_at || n.created_at) === ctx.today,
    );
    if (candidates.length === 1) link(state, ctx, f, candidates[0]);
  }
}
export function invalidateDocumentResults(
  state: WorkflowState,
  ctx: WorkflowContext,
  faxId: string,
  changeType: "Filing" | "Extracted report text" = "Filing",
) {
  for (const r of state.operations.note_results.filter(
    (r) => r.document_id === faxId,
  )) {
    const n = ctx.encounters.find((n) => n.id === r.encounter_id);
    if (n?.status === "Draft") {
      r.status = "Source changed";
      r.source_invalidated = true;
      r.text = "";
      r.revision++;
      r.reviewed_by = "";
      r.reviewed_at = null;
      r.review_note = `${changeType === "Filing" ? "Source patient / claim filing changed" : "Extracted source report text changed"}. Exclude or relink after review.`;
    } else if (n?.status === "Signed") {
      flagSignedSourceCorrection(state, ctx, r, changeType);
    }
  }
}
export function receivedResultsForNote(state: WorkflowState, id: string) {
  return state.operations.note_results
    .filter((r) => r.encounter_id === id && r.status === "Included")
    .map((r) => structuredClone(r));
}
export function validateNoteResultsForSignature(
  state: WorkflowState,
  ctx: WorkflowContext,
  n: Record<string, any>,
  input: unknown,
  nextAccount: string,
) {
  const rows = state.operations.note_results.filter(
    (r) => r.encounter_id === n.id,
  );
  const version = rows.reduce((n, r) => n + r.revision, 0);
  if (rows.length && (input as any)?.received_results_version !== version)
    fail(
      409,
      "Received results changed. Review the current results section before signing.",
    );
  for (const r of rows) {
    if (r.status === "Excluded") continue;
    const f = resultSource(state, ctx, r);
    if (
      r.status !== "Included" ||
      r.reviewed_by !== ctx.user.id ||
      !matchesCopiedSource(r, f, { ...n, billing_account_id: nextAccount })
    )
      fail(
        409,
        "Review and include or exclude every received result before signing; reports must match this visit account.",
      );
  }
}
export function noteResultsRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
  id?: string,
  action?: string,
) {
  if (ctx.user.role !== "clinician") fail(403, "Clinical access required");
  if (method === "GET") {
    const encounterId = url.searchParams.get("encounter_id") || "";
    const n =
      ctx.encounters.find((n) => n.id === encounterId) ||
      fail(404, "Encounter not found");
    const rows = state.operations.note_results.filter(
      (r) => r.encounter_id === encounterId,
    );
    return {
      results: rows,
      version: rows.reduce((n, r) => n + r.revision, 0),
      candidates:
        n.status === "Draft"
          ? state.operations.incoming_faxes
              .filter(
                (f) =>
                  fits(f, n) &&
                  ["Lab report", "Radiology report"].includes(f.kind) &&
                  !f.extraction_issue &&
                  !rows.some(
                    (r) =>
                      r.document_id === f.id && matchesCopiedSource(r, f, n),
                  ),
              )
              .map((f) => ({
                id: f.id,
                sender: f.sender,
                kind: f.kind,
                received_at: f.received_at,
              }))
          : [],
    };
  }
  if (method === "POST" && !id) {
    const v = z
      .object({ document_id: z.string(), encounter_id: z.string() })
      .parse(body);
    const n =
      ctx.encounters.find((n) => n.id === v.encounter_id) ||
      fail(404, "Encounter not found");
    if (n.author_id !== ctx.user.id)
      fail(403, "Only the note author can add received results");
    const f =
      state.operations.incoming_faxes.find((f) => f.id === v.document_id) ||
      fail(404, "Document not found");
    if (!["Lab report", "Radiology report"].includes(f.kind))
      fail(400, "Choose a lab or radiology report");
    return link(state, ctx, f, n);
  }
  const r =
    state.operations.note_results.find((r) => r.id === id) ||
    fail(404, "Received result not found");
  const n =
    ctx.encounters.find((n) => n.id === r.encounter_id) ||
    fail(404, "Encounter not found");
  if (n.author_id !== ctx.user.id)
    fail(403, "Only the note author can review these results");
  if (n.status !== "Draft") fail(409, "Signed note results are locked");
  if (method === "POST" && action === "review") {
    const v = z
      .object({
        revision: z.literal(r.revision),
        decision: z.enum(["Include", "Exclude"]),
        reason: z.string().trim().min(5).max(1000),
      })
      .parse(body);
    const f = resultSource(state, ctx, r);
    if (v.decision === "Include" && !matchesCopiedSource(r, f, n))
      fail(
        409,
        "Source report changed or is incomplete; relink the verified report before including it",
      );
    if (r.status === "Source changed") r.source_invalidated = true;
    r.status = v.decision === "Include" ? "Included" : "Excluded";
    r.reviewed_by = ctx.user.id;
    r.reviewed_at = ctx.now;
    r.review_note = v.reason;
    r.revision++;
    if (v.decision === "Include" && f) {
      if (r.source_type === "Lab result") {
        const result = state.results.find((x) => x.id === r.document_id)!;
        result.reviewed_at = ctx.now;
        result.reviewed_by = ctx.user.id;
        const order = state.orders.find((o) => o.id === result.order_id);
        if (order) order.status = "Reviewed";
        const task = state.tasks.find(
          (t) => t.source_key === `result:${result.id}`,
        );
        if (task) {
          task.done = 1;
          task.completed_at = ctx.now;
        }
      }
      f.reviewed_at = ctx.now;
      f.reviewed_by = ctx.user.name;
      const task = state.tasks.find((t) => t.id === f.clinical_task_id);
      if (task) {
        task.done = 1;
        task.completed_at = ctx.now;
      }
    }
    ctx.audit(
      `Provider ${r.status.toLowerCase()} received result in draft note`,
      n.id,
    );
    return r;
  }
  fail(404, "Note results action not found");
}
