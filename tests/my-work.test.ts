import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../server/database.js";
import { createPlatformApp } from "../server/platform.js";
import {
  emptyWorkflowState, readWorkflowState, workflowRequest,
  type CareTask, type WorkflowContext, type WorkflowUser,
} from "../server/workflow-engine.js";
import type { StaffActionTask } from "../server/staff-task-model.js";

const directory = mkdtempSync(join(tmpdir(), "cevrali-my-work-"));
const filename = join(directory, "demo.sqlite");
const accounts = join(directory, "accounts");
const password = "SyntheticMyWork2026!";
let db = createDatabase(filename);
let platform = createPlatformApp(db, accounts);
let server: Server;
let base: string;
let ownerCookie: string, clinicianCookie: string, deskCookie: string;
let thirdCookie: string, adminCookie: string, otherCookie: string;
let ownerId: string, clinicianId: string, deskId: string, thirdId: string;
let adminId: string, otherId: string, practiceId: string;
const staffBase = "/workflow/staff";
const tasksBase = "/workflow/staff-tasks";

async function listen() {
  server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
const stop = () => new Promise<void>((resolve, reject) =>
  server.close((error) => error ? reject(error) : resolve()));
async function call(path: string, method = "GET", body?: unknown, cookie = ownerCookie) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
}
async function invite(email: string, name: string, role: "clinician" | "receptionist", is_admin = false) {
  const invitation = await call("/account/invitations", "POST", { email, role, is_admin });
  assert.equal(invitation.status, 200);
  const joined = await call(`/accounts/invitations/${invitation.data.token}/accept`, "POST", { name, password }, "");
  assert.equal(joined.status, 201);
  return joined;
}
async function channel(name: string) {
  const created = await call(`${staffBase}/conversations`, "POST", {
    kind: "channel", name, description: "Synthetic task coordination", client_id: randomUUID(),
  });
  assert.equal(created.status, 200);
  return created.data;
}
async function message(conversationId: string, text: string, cookie = ownerCookie) {
  const sent = await call(`${staffBase}/conversations/${conversationId}/messages`, "POST", {
    text, client_id: randomUUID(),
  }, cookie);
  assert.equal(sent.status, 200);
  return sent.data;
}
function taskInput(conversationId: string, messageId: string, owner = deskId) {
  return {
    conversation_id: conversationId, message_id: messageId,
    title: "Confirm the synthetic opening checklist", owner_id: owner,
    due_date: "2026-10-24", priority: "Normal", client_id: randomUUID(),
  };
}
const dashboard = async (cookie = ownerCookie) => {
  const response = await call("/workflow/my-work", "GET", undefined, cookie);
  assert.equal(response.status, 200);
  return response.data;
};
const status = (expected: number) => (error: any) => error.status === expected;

before(async () => {
  await listen();
  const signup = (email: string, name: string) => call("/accounts/signup", "POST", {
    owner_name: name + " Owner", email, password, clinical_access: false,
    practice: { name },
  }, "");
  const owner = await signup("my-work-owner@example.test", "Synthetic My Work");
  assert.equal(owner.status, 201);
  ownerCookie = owner.cookie; ownerId = owner.data.id; practiceId = owner.data.practice.id;
  const other = await signup("other-my-work-owner@example.test", "Other My Work");
  assert.equal(other.status, 201);
  otherCookie = other.cookie; otherId = other.data.id;
  const clinician = await invite("my-work-clinician@example.test", "Synthetic Work Clinician", "clinician");
  clinicianCookie = clinician.cookie; clinicianId = clinician.data.id;
  const desk = await invite("my-work-desk@example.test", "Synthetic Work Receptionist", "receptionist");
  deskCookie = desk.cookie; deskId = desk.data.id;
  const third = await invite("my-work-third@example.test", "Synthetic Other Clinician", "clinician");
  thirdCookie = third.cookie; thirdId = third.data.id;
  const admin = await invite("my-work-admin@example.test", "Synthetic Other Administrator", "receptionist", true);
  adminCookie = admin.cookie; adminId = admin.data.id;
});
after(async () => {
  await stop(); platform.store.close(); db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("existing workflows gain staff action tasks without losing data and My work is an authenticated personal page", async () => {
  const old = emptyWorkflowState();
  delete (old.staff_communication as Partial<typeof old.staff_communication>).action_tasks;
  old.preferences["existing-user"] = { favorites: ["existing-patient"], recent: [], filters: [] };
  const upgraded = readWorkflowState(JSON.stringify(old));
  assert.deepEqual(upgraded.staff_communication.action_tasks, []);
  assert.deepEqual(upgraded.preferences, old.preferences);
  for (const path of [tasksBase, "/workflow/my-work"])
    assert.equal((await call(path, "GET", undefined, "")).status, 401);
  const view = await dashboard(deskCookie);
  assert.equal(view.viewer_id, deskId);
  assert.equal(view.clinical, false);
  assert.deepEqual(view.care_tasks, []);
  assert.deepEqual(view.reviews, []);
  assert.equal((await call("/workflow/user-settings", "PATCH", { start_page: "my-work" }, deskCookie)).status, 200);
  assert.equal((await call("/workflow/user-settings", "GET", undefined, deskCookie)).data.start_page, "my-work");
  const targeted = await call(`/workflow/my-work?user_id=${ownerId}`, "GET", undefined, deskCookie);
  assert.ok(targeted.status === 400 || targeted.status === 404 ||
    (targeted.status === 200 && targeted.data.viewer_id === deskId));
});

test("message conversion is idempotent, keeps the original source, and exposes one current task summary", async () => {
  const room = await channel("Message conversion");
  const original = await message(room.id, "Synthetic opening checklist request retained as the immutable source.");
  const input = taskInput(room.id, original.id);
  const created = await call(tasksBase, "POST", input);
  assert.equal(created.status, 200);
  assert.equal(created.data.created_by, ownerId);
  assert.equal(created.data.source_message.id, original.id);
  assert.equal(created.data.source_message.text, original.text);
  assert.equal(created.data.owner.id, deskId);
  assert.equal(created.data.history.length, 1);
  const auditBeforeRetry = platform.store.db(practiceId).prepare("SELECT count(*) count FROM audit").get() as { count: number };
  const retried = await call(tasksBase, "POST", input);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.id, created.data.id);
  assert.equal(retried.data.history.length, 1);
  const auditAfterRetry = platform.store.db(practiceId).prepare("SELECT count(*) count FROM audit").get() as { count: number };
  assert.equal(auditAfterRetry.count, auditBeforeRetry.count);
  assert.equal((await call(tasksBase, "POST", { ...input, title: "Conflicting retry" })).status, 409);
  assert.equal((await call(tasksBase, "POST", { ...input, client_id: randomUUID() })).status, 409);
  const changed = await call(`${tasksBase}/${created.data.id}`, "PATCH", {
    revision: created.data.revision, title: "An updated operational title", priority: "High",
  });
  assert.equal(changed.status, 200);
  const oldCreateRetry = await call(tasksBase, "POST", input);
  assert.equal(oldCreateRetry.status, 200);
  assert.equal(oldCreateRetry.data.title, changed.data.title);
  const loaded = await call(`${staffBase}/conversations/${room.id}/messages`);
  assert.equal(loaded.data.messages[0].task.id, created.data.id);
  assert.equal(loaded.data.messages[0].task.title, changed.data.title);
  assert.equal(loaded.data.messages[0].text, original.text);
});

test("DM-derived tasks cannot broaden conversation access through assignment, dashboard, or administrator privileges", async () => {
  const direct = await call(`${staffBase}/conversations`, "POST", { kind: "direct", member_id: deskId });
  assert.equal(direct.status, 200);
  const secret = "Synthetic private operational handoff 82631";
  const original = await message(direct.data.id, secret);
  const input = taskInput(direct.data.id, original.id);
  assert.equal((await call(tasksBase, "POST", { ...input, owner_id: thirdId })).status, 400);
  const created = await call(tasksBase, "POST", input);
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.allowed_assignees.map((person: any) => person.id).sort(), [ownerId, deskId].sort());
  for (const cookie of [adminCookie, thirdCookie, otherCookie]) {
    assert.equal((await call(`${tasksBase}/${created.data.id}`, "GET", undefined, cookie)).status, 404);
    assert.equal((await call(`${tasksBase}/${created.data.id}`, "PATCH", {
      revision: 1, done: true,
    }, cookie)).status, 404);
    const listed = await call(`${tasksBase}?scope=all&status=all`, "GET", undefined, cookie);
    assert.equal(listed.status, 200);
    assert.ok(!JSON.stringify(listed.data).includes(secret));
    assert.ok(!JSON.stringify(await dashboard(cookie)).includes(secret));
    assert.ok(!JSON.stringify(await dashboard(cookie)).includes(created.data.id));
  }
  const before = await call(`${tasksBase}/${created.data.id}`);
  assert.equal((await call(`${tasksBase}/${created.data.id}`, "PATCH", {
    revision: before.data.revision, owner_id: adminId,
  })).status, 400);
  assert.deepEqual((await call(`${tasksBase}/${created.data.id}`)).data, before.data);
});

test("task ownership, source identity, and dates are validated without partial changes", async () => {
  const room = await channel("Validated task ownership");
  const elsewhere = await channel("A separate task source");
  const original = await message(room.id, "Synthetic validation request");
  const input = taskInput(room.id, original.id);
  for (const invalid of [
    { ...input, owner_id: otherId }, { ...input, due_date: "2026-02-30" },
    { ...input, title: "   " }, { ...input, title: "x".repeat(201) },
    { ...input, created_by: adminId }, { ...input, done: true },
  ]) assert.equal((await call(tasksBase, "POST", invalid)).status, 400);
  assert.equal((await call(tasksBase, "POST", { ...input, conversation_id: elsewhere.id })).status, 404);
  const created = await call(tasksBase, "POST", input);
  assert.equal(created.status, 200);
  assert.equal((await call(`${tasksBase}/${created.data.id}`, "PATCH", {
    revision: 1, due_date: "2026-02-30",
  })).status, 400);
  assert.equal((await call(`${tasksBase}/${created.data.id}`, "PATCH", {
    revision: 1, done: true,
  }, thirdCookie)).status, 403);
  assert.equal((await call(`${tasksBase}/${created.data.id}`)).data.revision, 1);
});

test("task revisions preserve drafts and completion history instead of silently rewriting completed assignments", async () => {
  const room = await channel("Audited task progress");
  const original = await message(room.id, "Synthetic follow-up for revision checks");
  const created = await call(tasksBase, "POST", taskInput(room.id, original.id));
  assert.equal(created.status, 200);
  const path = `${tasksBase}/${created.data.id}`;
  const noop = await call(path, "PATCH", { revision: 1, title: created.data.title, owner_id: deskId });
  assert.equal(noop.status, 200);
  assert.equal(noop.data.revision, 1);
  assert.equal(noop.data.history.length, 1);
  const completed = await call(path, "PATCH", { revision: 1, done: true }, deskCookie);
  assert.equal(completed.status, 200);
  assert.equal(completed.data.done, 1);
  assert.ok(completed.data.completed_at);
  assert.equal(completed.data.history.at(-1).actor_id, deskId);
  const doneNoop = await call(path, "PATCH", { revision: completed.data.revision, done: true }, deskCookie);
  assert.equal(doneNoop.data.completed_at, completed.data.completed_at);
  assert.equal(doneNoop.data.revision, completed.data.revision);
  assert.equal((await call(path, "PATCH", { revision: 1, done: false })).status, 409);
  assert.equal((await call(path, "PATCH", {
    revision: completed.data.revision, title: "Do not quietly rewrite a completed task",
  })).status, 409);
  const reopened = await call(path, "PATCH", {
    revision: completed.data.revision, done: false, owner_id: clinicianId,
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.done, 0);
  assert.equal(reopened.data.completed_at, null);
  assert.equal(reopened.data.owner_id, clinicianId);
  assert.equal(reopened.data.history.at(-1).action, "Reopened");
  assert.equal(reopened.data.history.at(-1).before.done, 1);
  assert.equal(reopened.data.history.at(-1).after.owner_id, clinicianId);
});

test("archived channels and inactive peers do not strand already assigned follow-ups", async () => {
  const room = await channel("Archived follow-up continuity");
  const original = await message(room.id, "Synthetic task must remain completable after channel archival.");
  const created = await call(tasksBase, "POST", taskInput(room.id, original.id));
  const nextMessage = await message(room.id, "This message cannot gain a task after archival.");
  assert.equal((await call(`${staffBase}/conversations/${room.id}`, "PATCH", {
    revision: room.revision, archived: true,
  })).status, 200);
  assert.equal((await call(tasksBase, "POST", taskInput(room.id, nextMessage.id))).status, 409);
  assert.equal((await call(`${tasksBase}/${created.data.id}`, "PATCH", { revision: 1, done: true }, deskCookie)).status, 200);
  const peer = await invite("my-work-deactivated@example.test", "Synthetic Inactive Peer", "receptionist");
  const direct = await call(`${staffBase}/conversations`, "POST", { kind: "direct", member_id: peer.data.id });
  const peerOriginal = await message(direct.data.id, "Synthetic task before peer deactivation.");
  const peerTask = await call(tasksBase, "POST", taskInput(direct.data.id, peerOriginal.id, peer.data.id));
  assert.equal(peerTask.status, 200);
  assert.equal((await call(`/account/members/${peer.data.id}`, "PATCH", {
    role: "receptionist", is_admin: false, is_active: false,
  })).status, 200);
  const updated = await call(`${tasksBase}/${peerTask.data.id}`, "PATCH", { revision: 1, owner_id: ownerId });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.allowed_assignees.map((person: any) => person.id), [ownerId]);
  assert.equal((await call(`${tasksBase}/${peerTask.data.id}`, "PATCH", { revision: updated.data.revision, done: true })).status, 200);
});

test("My work separates assigned work from created work and does not implicitly read messages or acknowledge announcements", async () => {
  const room = await channel("Personal dashboard ownership");
  const original = await message(room.id, "Synthetic dashboard ownership follow-up");
  const created = await call(tasksBase, "POST", taskInput(room.id, original.id));
  const posted = await call(`${staffBase}/announcements`, "POST", {
    title: "Synthetic dashboard acknowledgement", body: "An explicit acknowledgement remains necessary.",
    priority: "Normal", requires_acknowledgement: true, client_id: randomUUID(),
  });
  assert.equal(posted.status, 200);
  const before = await call(`${staffBase}/unread`, "GET", undefined, deskCookie);
  const mine = await dashboard(deskCookie);
  assert.ok(mine.staff_tasks.some((task: any) => task.id === created.data.id));
  assert.ok((await dashboard()).staff_tasks.some((task: any) => task.id === created.data.id));
  assert.ok(!(await dashboard(thirdCookie)).staff_tasks.some((task: any) => task.id === created.data.id));
  assert.ok(mine.announcements.some((post: any) => post.id === posted.data.id));
  assert.deepEqual((await call(`${staffBase}/unread`, "GET", undefined, deskCookie)).data, before.data);
  assert.equal((await call(`${tasksBase}?scope=mine`, "GET", undefined, deskCookie)).data
    .filter((task: any) => task.id === created.data.id).length, 1);
});

function pureFixture() {
  const clinician: WorkflowUser = { id: "pure-clinician", name: "Synthetic Pure Clinician", email: "pure-clinician@example.test", role: "clinician", is_active: true };
  const other: WorkflowUser = { id: "pure-other", name: "Synthetic Other Clinician", email: "pure-other@example.test", role: "clinician", is_active: true };
  const desk: WorkflowUser = { id: "pure-desk", name: "Synthetic Pure Administrator", email: "pure-desk@example.test", role: "receptionist", is_admin: true, is_active: true };
  const state = emptyWorkflowState();
  let serial = 0;
  const audit: [string, string][] = [];
  const ctx: WorkflowContext = {
    user: clinician, users: [clinician, other, desk],
    patients: [{ id: "pure-patient", first_name: "Synthetic", last_name: "Review Patient", dob: "1980-01-02", allergies: [], medications: [], conditions: [] }],
    appointments: [], encounters: [], tasks: [], labs: [{ id: "seeded-lab-no-review-state", name: "A seeded historical lab", patient_id: "pure-patient", value: "SEEDED-SECRET" }],
    now: "2026-03-09T00:30:00Z", today: "2026-03-08", local_time: "17:30",
    id: prefix => `${prefix}-${++serial}`, audit: (action, resource) => audit.push([action, resource]),
  };
  const task = (overrides: Partial<CareTask>): CareTask => ({
    id: `pure-task-${++serial}`, patient_id: "pure-patient", title: "Synthetic owned clinical follow-up",
    category: "Follow-up", priority: "Normal", done: 0, owner_id: clinician.id,
    due_date: ctx.today, created_at: ctx.now, completed_at: null, ...overrides,
  });
  const request = (method: string, path: string, body: unknown = {}, user = clinician): any =>
    workflowRequest(state, { ...ctx, user }, method, path, body);
  return { state, ctx, clinician, other, desk, task, request, audit };
}

test("My work uses authoritative result and report review state, follows reassignment, and counts each source once", () => {
  const f = pureFixture();
  f.state.orders.push({ id: "pure-order", patient_id: "pure-patient", encounter_id: null, kind: "Lab", name: "Synthetic potassium", details: "CLINICAL-SECRET-ORDER", status: "Result received", created_at: f.ctx.now, author_id: f.clinician.id, external_id: "pure-external" });
  f.state.results.push({ id: "pure-result", order_id: "pure-order", patient_id: "pure-patient", name: "Synthetic potassium", value: "CLINICAL-SECRET-VALUE", flag: "High", date: f.ctx.today, recorded_at: f.ctx.now, reviewed_at: null, reviewed_by: null });
  const resultTask = f.task({ id: "pure-result-task", title: "Review result: Synthetic potassium", category: "Lab review", priority: "High", source_key: "result:pure-result" });
  const documentTask = f.task({ id: "pure-document-task", title: "Review outside document", category: "Documentation", source_key: "incoming-fax:pure-fax:1" });
  const normalTask = f.task({ id: "pure-ordinary-task" });
  f.state.tasks.push(resultTask, documentTask, normalTask);
  f.state.operations.incoming_faxes.push({
    id: "pure-fax", external_id: "pure-fax-external", sender: "Synthetic Radiology", filename: "Synthetic radiology report.txt", format: "text",
    original_base64: "", extracted_text: "CLINICAL-SECRET-RADIOLOGY", digest: "synthetic-digest", pages: 1, extraction_issue: "",
    received_at: f.ctx.now, revision: 1, content_revision: 1, status: "Filed", patient_id: "pure-patient", billing_account_id: "",
    match_reason: "Synthetic exact match", kind: "Radiology report", reviewed_at: null, reviewed_by: "", clinical_task_id: documentTask.id, history: [],
  });
  const initial = f.request("GET", "/my-work");
  assert.equal(initial.counts.awaiting_review, 2);
  assert.deepEqual(initial.reviews.map((review: any) => review.id).sort(), ["pure-fax", "pure-result"].sort());
  assert.deepEqual(initial.care_tasks.map((entry: any) => entry.id), [normalTask.id]);
  assert.ok(!JSON.stringify(initial).includes("seeded-lab-no-review-state"));
  assert.ok(!JSON.stringify(initial).includes("CLINICAL-SECRET-VALUE"));
  f.request("PATCH", `/tasks/${resultTask.id}`, { done: true });
  assert.equal(f.request("GET", "/my-work").reviews.some((entry: any) => entry.id === "pure-result"), true,
    "checking off a generic task is not authoritative result review");
  f.request("PATCH", `/tasks/${resultTask.id}`, { owner_id: f.other.id });
  assert.equal(f.request("GET", "/my-work").reviews.some((entry: any) => entry.id === "pure-result"), false);
  assert.equal(f.request("GET", "/my-work", {}, f.other).reviews.some((entry: any) => entry.id === "pure-result"), true);
  f.request("PATCH", "/results/pure-result/review", {}, f.other);
  assert.equal(f.request("GET", "/my-work", {}, f.other).reviews.length, 0);
  assert.equal(f.request("GET", "/my-work", {}, f.other).care_tasks.some((entry: any) => entry.id === resultTask.id), false);
  const frontDesk = f.request("GET", "/my-work", {}, f.desk);
  assert.deepEqual(frontDesk.reviews, []);
  assert.deepEqual(frontDesk.care_tasks, []);
  for (const secret of ["pure-result", "pure-fax", "pure-ordinary-task", "CLINICAL-SECRET", "SEEDED-SECRET"])
    assert.ok(!JSON.stringify(frontDesk).includes(secret));
});

test("authorization follow-ups use the current owner, pending statuses, and clinic date without exposing narratives", () => {
  const f = pureFixture();
  f.state.finance.policies.push({ id: "pure-policy", patient_id: "pure-patient", payer: "Synthetic Payer", plan: "Synthetic", member_id: "synthetic-member", group_number: "", priority: "Primary", subscriber_name: "Synthetic", subscriber_dob: "1980-01-02", relationship: "Self", effective_date: "2026-01-01", end_date: "", revision: 1, updated_at: f.ctx.now });
  const auth = (id: string, due_date: string, status: "Draft" | "Demo submitted" | "Demo approved" | "Cancelled", owner_id = f.desk.id) => ({
    id, patient_id: "pure-patient", policy_id: "pure-policy", policy_revision: 1, procedure_codes: ["SECRET-CODE"], description: "CLINICAL-SECRET-AUTH", requested_visits: 3,
    valid_from: "2026-03-01", valid_to: "2026-03-31", due_date, owner_id, revision: 1, status, approval_number: "", approved_visits: 0, decision_note: "CLINICAL-SECRET-DECISION", created_at: f.ctx.now, updated_at: f.ctx.now, history: [],
  });
  f.state.finance.authorizations.push(
    auth("due-yesterday", "2026-03-07", "Draft"), auth("due-today", "2026-03-08", "Demo submitted"),
    auth("due-tomorrow", "2026-03-09", "Draft"), auth("approved", "2026-03-07", "Demo approved"),
    auth("cancelled", "2026-03-07", "Cancelled"), auth("someone-else", "2026-03-07", "Draft", f.other.id),
  );
  const view = f.request("GET", "/my-work", {}, f.desk);
  assert.equal(view.today, "2026-03-08");
  assert.deepEqual(view.authorizations.map((entry: any) => entry.id).sort(), ["due-yesterday", "due-today"].sort());
  assert.equal(view.authorizations.find((entry: any) => entry.id === "due-yesterday").overdue, true);
  assert.equal(view.authorizations.find((entry: any) => entry.id === "due-today").overdue, false);
  assert.equal(view.counts.authorization_followups, 2);
  assert.equal(view.counts.overdue, 1);
  assert.equal(view.counts.due_today, 1);
  assert.ok(!JSON.stringify(view).includes("CLINICAL-SECRET"));
  assert.ok(!JSON.stringify(view).includes("SECRET-CODE"));
});

test("personal action totals distinguish overdue, due today, future, and completed tasks across a UTC/Pacific boundary", () => {
  const f = pureFixture();
  const sent = f.request("POST", "/staff/conversations/staff-general/messages", { text: "Synthetic date-boundary task source", client_id: randomUUID() });
  const created = f.request("POST", "/staff-tasks", {
    conversation_id: "staff-general", message_id: sent.id, title: "Synthetic date task", owner_id: f.clinician.id,
    due_date: "2026-03-08", priority: "Normal", client_id: randomUUID(),
  });
  const raw = f.state.staff_communication.action_tasks.find((task) => task.id === created.id)!;
  const dates = ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-07"];
  f.state.staff_communication.action_tasks = dates.map((due_date, index): StaffActionTask => ({
    ...structuredClone(raw), id: `date-task-${index}`, message_id: sent.id, due_date,
    done: index === 3 ? 1 : 0, completed_at: index === 3 ? f.ctx.now : null,
  }));
  const view = f.request("GET", "/my-work");
  assert.equal(view.today, "2026-03-08");
  assert.equal(view.counts.assigned_tasks, 3);
  assert.equal(view.counts.overdue, 1);
  assert.equal(view.counts.due_today, 1);
});

test("task assignments, revisions, completion history, and private source access persist after restart", async () => {
  const direct = await call(`${staffBase}/conversations`, "POST", { kind: "direct", member_id: deskId });
  const original = await message(direct.data.id, "Persistent synthetic task handoff source.");
  const created = await call(tasksBase, "POST", taskInput(direct.data.id, original.id));
  assert.equal(created.status, 200);
  const completed = await call(`${tasksBase}/${created.data.id}`, "PATCH", { revision: 1, done: true }, deskCookie);
  assert.equal(completed.status, 200);
  const before = await call(`${tasksBase}/${created.data.id}`, "GET", undefined, deskCookie);
  const beforeDashboard = await dashboard(deskCookie);
  await stop(); platform.store.close(); db.close();
  db = createDatabase(filename); platform = createPlatformApp(db, accounts); await listen();
  assert.deepEqual((await call(`${tasksBase}/${created.data.id}`, "GET", undefined, deskCookie)).data, before.data);
  assert.deepEqual(await dashboard(deskCookie), beforeDashboard);
  assert.equal((await call(`${tasksBase}/${created.data.id}`, "GET", undefined, adminCookie)).status, 404);
  assert.equal((await call(`${tasksBase}/${created.data.id}`, "GET", undefined, otherCookie)).status, 404);
});
