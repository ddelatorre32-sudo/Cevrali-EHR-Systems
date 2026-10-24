import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emptyWorkflowState,
  readWorkflowState,
  workflowRequest,
  type WorkflowContext,
} from "../server/workflow-engine.js";
import { createDatabase } from "../server/database.js";
import { loadWorkflow, saveWorkflow } from "../server/workflows.js";

function fixture() {
  const state = emptyWorkflowState();
  let serial = 0;
  const audit: [string, string][] = [];
  const ctx: WorkflowContext = {
    user: { id: "doc-one", name: "Provider One", email: "one@example.test", role: "clinician" },
    users: [], patients: [], appointments: [], encounters: [], tasks: [], labs: [],
    now: "2026-10-23T16:00:00Z", today: "2026-10-23", local_time: "09:00",
    id: (prefix) => `${prefix}-${++serial}`,
    audit: (action, resource) => audit.push([action, resource]),
  };
  const request = (method: string, path: string, body?: unknown, user = ctx.user): any =>
    workflowRequest(state, { ...ctx, user }, method, path, body);
  const second = { id: "doc-two", name: "Provider Two", email: "two@example.test", role: "clinician" };
  const admin = { ...second, is_admin: true };
  return { state, ctx, audit, request, second, admin };
}

const soap = {
  name: "Workers compensation follow-up",
  subjective: "Work injury history: [[document history]]",
  objective: "Accepted body parts: [[review claim and examination]]",
  assessment: "Work status: [[document assessment]]",
  plan: "Treatment requested: [[document rationale]]",
};

function status(code: number) {
  return (error: any) => error.status === code;
}

test("provider templates default to personal and remain private even from other administrators", () => {
  const { request, second, admin } = fixture();
  const created = request("POST", "/templates", soap);
  assert.equal(created.owner_id, "doc-one");
  assert.equal(created.visibility, "personal");
  assert.equal(created.revision, 1);
  assert.equal(created.can_edit, true);
  assert.ok(request("GET", "/templates").some((item: any) => item.id === created.id));
  for (const user of [second, admin]) {
    assert.equal(request("GET", "/templates?include_archived=true", undefined, user)
      .some((item: any) => item.id === created.id), false);
    assert.throws(() => request("PATCH", `/templates/${created.id}`, { revision: 1, name: "Take over" }, user), status(404));
  }
});

test("practice templates are reusable but only their author or clinical administrators may edit", () => {
  const { request, second, admin } = fixture();
  const created = request("POST", "/templates", { ...soap, visibility: "practice" });
  const seen = request("GET", "/templates", undefined, second).find((item: any) => item.id === created.id);
  assert.equal(seen.can_edit, false);
  assert.throws(() => request("PATCH", `/templates/${created.id}`, { revision: 1, name: "Unauthorized" }, second), status(403));
  const edited = request("PATCH", `/templates/${created.id}`, { revision: 1, name: "Shared follow-up" }, admin);
  assert.equal(edited.revision, 2);
  assert.equal(edited.owner_id, "doc-one");
  assert.throws(() => request("PATCH", `/templates/${created.id}`, { revision: 2, visibility: "personal" }, admin), status(403));
  const legacy = request("GET", "/templates").find((item: any) => item.id === "template-acute");
  assert.equal(legacy.visibility, "practice");
  assert.equal(legacy.can_edit, false);
  assert.throws(() => request("PATCH", "/templates/template-acute", { revision: 1, name: "Legacy" }), status(403));
  assert.equal(request("PATCH", "/templates/template-acute", { revision: 1, name: "Reviewed focused concern" }, admin).name,
    "Reviewed focused concern");
});

test("template edits require the current revision and return stable client snapshots", () => {
  const { request, state } = fixture();
  const created = request("POST", "/templates", soap);
  const edited = request("PATCH", `/templates/${created.id}`, { revision: 1, plan: "New future-visit prompt [[review]]" });
  assert.equal(edited.revision, 2);
  const before = structuredClone(state);
  assert.throws(() => request("PATCH", `/templates/${created.id}`, { revision: 1, plan: "Stale edit" }), status(409));
  assert.deepEqual(state, before);
  assert.equal(created.plan, soap.plan, "returned snapshots are independent of stored mutations");
});

test("archived templates leave note pickers, stay in the owner library, and can be restored", () => {
  const { request, audit } = fixture();
  const created = request("POST", "/templates", soap);
  const archived = request("PATCH", `/templates/${created.id}`, { revision: 1, archived: true });
  assert.equal(archived.archived, true);
  assert.equal(request("GET", "/templates").some((item: any) => item.id === created.id), false);
  assert.equal(request("GET", "/templates?include_archived=true")
    .find((item: any) => item.id === created.id).archived, true);
  const restored = request("PATCH", `/templates/${created.id}`, { revision: 2, archived: false });
  assert.equal(restored.revision, 3);
  assert.equal(restored.archived, false);
  assert.equal(audit.at(-1)?.[0], "Restored note template");
});

test("personal phrase shortcuts are owner scoped and shared shortcuts cannot collide on publish or restore", () => {
  const { request, second, state } = fixture();
  const first = request("POST", "/phrases", { shortcut: ".wcplan", text: "First [[prompt]]" });
  const other = request("POST", "/phrases", { shortcut: ".wcplan", text: "Second [[prompt]]" }, second);
  assert.notEqual(first.id, other.id);
  assert.equal(request("GET", "/phrases").filter((item: any) => item.shortcut === ".wcplan").length, 1);
  assert.throws(() => request("POST", "/phrases", { shortcut: ".followup", text: "Duplicate baseline" }), status(409));
  assert.throws(() => request("PATCH", `/phrases/${first.id}`, { revision: 1, visibility: "practice" }), status(409));
  request("PATCH", `/phrases/${first.id}`, { revision: 1, archived: true });
  const replacement = request("POST", "/phrases", { shortcut: ".wcplan", text: "Replacement" });
  const before = structuredClone(state);
  assert.throws(() => request("PATCH", `/phrases/${first.id}`, { revision: 2, archived: false }), status(409));
  assert.deepEqual(state, before);
  assert.equal(request("GET", "/phrases").find((item: any) => item.shortcut === ".wcplan").id, replacement.id);
});

test("template and phrase validation rejects ownership injection and invalid changes without partial mutation", () => {
  const { request, state } = fixture();
  const created = request("POST", "/templates", soap);
  const invalid: [string, string, unknown][] = [
    ["POST", "/templates", { ...soap, owner_id: "doc-two" }],
    ["PATCH", `/templates/${created.id}`, { revision: 1, owner_id: "doc-two" }],
    ["PATCH", `/templates/${created.id}`, { name: "Missing revision" }],
    ["PATCH", `/templates/${created.id}`, { revision: 1, subjective: "x".repeat(10001) }],
    ["PATCH", `/templates/${created.id}`, { revision: 1 }],
    ["POST", "/phrases", { shortcut: "no-dot", text: "Valid text" }],
    ["POST", "/phrases", { shortcut: ".valid", text: " " }],
  ];
  for (const [method, path, body] of invalid) {
    const before = structuredClone(state);
    assert.throws(() => request(method, path, body));
    assert.deepEqual(state, before);
  }
  assert.throws(() => request("DELETE", `/templates/${created.id}`), status(405));
});

test("front desk access never exposes note template contents even when the staff member is an administrator", () => {
  const { request } = fixture();
  const front = { id: "front", name: "Front Desk", email: "front@example.test", role: "receptionist", is_admin: true };
  for (const resource of ["templates", "phrases"]) {
    assert.throws(() => request("GET", `/${resource}?include_archived=true`, undefined, front), status(403));
    assert.throws(() => request("POST", `/${resource}`, resource === "templates" ? soap : { shortcut: ".desk", text: "Desk" }, front), status(403));
  }
});

test("template ownership, revisions and archive state survive persistence without entering another practice", () => {
  const directory = mkdtempSync(join(tmpdir(), "cevrali-template-library-"));
  const filename = join(directory, "practice.sqlite");
  let db = createDatabase(filename);
  try {
    const { state, request } = fixture();
    const created = request("POST", "/templates", soap);
    request("PATCH", `/templates/${created.id}`, { revision: 1, archived: true });
    saveWorkflow(db, state);
    db.close();
    db = createDatabase(filename);
    const saved = loadWorkflow(db).templates.find((item) => item.id === created.id)!;
    assert.equal(saved.owner_id, "doc-one");
    assert.equal(saved.visibility, "personal");
    assert.equal(saved.revision, 2);
    assert.equal(saved.archived, true);
    assert.equal(emptyWorkflowState().templates.some((item) => item.id === created.id), false);
    const legacy = readWorkflowState(JSON.stringify({ ...state, templates: [{ ...soap, id: "legacy" }] }));
    assert.equal(legacy.templates[0].name, soap.name);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
