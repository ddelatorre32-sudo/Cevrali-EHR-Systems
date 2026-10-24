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
import { emptyWorkflowState, readWorkflowState } from "../server/workflow-engine.js";

const directory = mkdtempSync(join(tmpdir(), "cevrali-staff-communication-"));
const filename = join(directory, "demo.sqlite");
const accounts = join(directory, "accounts");
const password = "SyntheticStaff2026!";
let db = createDatabase(filename);
let platform = createPlatformApp(db, accounts);
let server: Server;
let base: string;
let ownerCookie: string, clinicianCookie: string, deskCookie: string;
let outsiderCookie: string, otherCookie: string;
let ownerId: string, clinicianId: string, deskId: string, outsiderId: string;
let practiceId: string, otherId: string;
const staffPath = "/workflow/staff";
const requestId = () => randomUUID();

async function listen() {
  server = platform.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api";
}
const stop = () => new Promise<void>((resolve, reject) =>
  server.close((error) => error ? reject(error) : resolve()));
async function call(path: string, method = "GET", body?: unknown, cookie = ownerCookie) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function invite(email: string, name: string, role: "clinician" | "receptionist") {
  const invitation = await call("/account/invitations", "POST", { email, role });
  assert.equal(invitation.status, 200);
  const joined = await call("/accounts/invitations/" + invitation.data.token + "/accept",
    "POST", { name, password }, "");
  assert.equal(joined.status, 201);
  return joined;
}
async function channel(name: string) {
  const response = await call(staffPath + "/conversations", "POST", {
    kind: "channel", name, description: "Synthetic internal staff test", client_id: requestId(),
  });
  assert.equal(response.status, 200);
  return response.data;
}
const messagesPath = (id: string) => staffPath + "/conversations/" + id + "/messages";
async function send(id: string, text: string, cookie = ownerCookie, clientId = requestId()) {
  return call(messagesPath(id), "POST", { text, client_id: clientId }, cookie);
}
const workspace = async (cookie = ownerCookie) => (await call(staffPath, "GET", undefined, cookie)).data;
const unread = async (cookie = ownerCookie) => (await call(staffPath + "/unread", "GET", undefined, cookie)).data;
const announcementInput = (title: string) => ({
  title, body: "Synthetic staff instructions. Please review before the next shift.",
  priority: "Urgent", requires_acknowledgement: true, client_id: requestId(),
});
const announcementView = async (id: string, cookie = ownerCookie) =>
  (await workspace(cookie)).announcements.find((entry: any) => entry.id === id);

before(async () => {
  await listen();
  const signup = (email: string, name: string) => call("/accounts/signup", "POST", {
    owner_name: name + " Owner", email, password, clinical_access: false,
    practice: { name },
  }, "");
  const owner = await signup("staff-owner@example.test", "Synthetic Staff Practice");
  assert.equal(owner.status, 201);
  assert.equal(owner.data.role, "receptionist");
  ownerCookie = owner.cookie;
  ownerId = owner.data.id;
  practiceId = owner.data.practice.id;
  const other = await signup("other-staff-owner@example.test", "Other Staff Practice");
  assert.equal(other.status, 201);
  otherCookie = other.cookie;
  otherId = other.data.id;
  const clinician = await invite("staff-clinician@example.test", "Synthetic Staff Clinician", "clinician");
  clinicianCookie = clinician.cookie;
  clinicianId = clinician.data.id;
  const desk = await invite("staff-desk@example.test", "Synthetic Staff Receptionist", "receptionist");
  deskCookie = desk.cookie;
  deskId = desk.data.id;
  const outsider = await invite("staff-outsider@example.test", "Synthetic Third Staff", "receptionist");
  outsiderCookie = outsider.cookie;
  outsiderId = outsider.data.id;
});
after(async () => {
  await stop();
  platform.store.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("older workflows gain staff communication without replacing existing state; directory is practice-scoped", async () => {
  const old = emptyWorkflowState();
  delete (old as Partial<typeof old>).staff_communication;
  old.preferences[ownerId] = { favorites: ["existing-patient"], recent: [], filters: [] };
  const upgraded = readWorkflowState(JSON.stringify(old));
  assert.deepEqual(upgraded.staff_communication.messages, []);
  assert.deepEqual(upgraded.preferences, old.preferences);
  assert.equal((await call(staffPath, "GET", undefined, "")).status, 401);
  const own = await workspace();
  assert.equal(own.viewer_id, ownerId);
  assert.equal(own.can_manage, true);
  assert.deepEqual(own.directory.map((member: any) => member.id).sort(),
    [ownerId, clinicianId, deskId, outsiderId].sort());
  assert.ok(own.directory.every((member: any) => member.is_active === true));
  assert.ok(own.directory.every((member: any) => !("password" in member)));
  assert.equal(own.conversations.filter((conversation: any) => conversation.id === "staff-general").length, 1);
  assert.deepEqual((await workspace(otherCookie)).directory.map((member: any) => member.id), [otherId]);
  assert.equal((await workspace(deskCookie)).can_manage, false);
  assert.equal((await call("/workflow/user-settings", "PATCH", { start_page: "staff" }, deskCookie)).status, 200);
  assert.equal((await call("/workflow/user-settings", "GET", undefined, deskCookie)).data.start_page, "staff");
});

test("administrators manage channels while every active staff role can participate with validated identity", async () => {
  const input = { kind: "channel", name: "Morning coordination", description: "Daily handover", client_id: requestId() };
  assert.equal((await call(staffPath + "/conversations", "POST", input, deskCookie)).status, 403);
  const created = await call(staffPath + "/conversations", "POST", input);
  assert.equal(created.status, 200);
  const retried = await call(staffPath + "/conversations", "POST", input);
  assert.equal(retried.data.id, created.data.id);
  assert.equal((await call(staffPath + "/conversations", "POST", {
    ...input, name: "A different channel using the same key",
  })).status, 409);
  assert.equal((await workspace()).conversations.filter((c: any) => c.id === created.data.id).length, 1);
  for (const cookie of [clinicianCookie, deskCookie]) {
    const posted = await send(created.data.id, "Synthetic handover from an active staff member", cookie);
    assert.equal(posted.status, 200);
    assert.equal(posted.data.author.id, cookie === deskCookie ? deskId : clinicianId);
  }
  assert.equal((await call(messagesPath(created.data.id), "POST", {
    text: "Spoofed author must be rejected", client_id: requestId(), author_id: ownerId,
  }, deskCookie)).status, 400);
  for (const text of ["   ", "x".repeat(4001)]) {
    assert.equal((await send(created.data.id, text)).status, 400);
  }
  assert.equal((await call(messagesPath(created.data.id), "DELETE", {})).status, 404);
});

test("direct messages reuse a participant pair and remain invisible to other staff and practices", async () => {
  const created = await call(staffPath + "/conversations", "POST", { kind: "direct", member_id: deskId });
  assert.equal(created.status, 200);
  const id = created.data.id;
  const reverse = await call(staffPath + "/conversations", "POST",
    { kind: "direct", member_id: ownerId }, deskCookie);
  assert.equal(reverse.status, 200);
  assert.equal(reverse.data.id, id);
  const secretText = "Synthetic private shift handover 4391";
  assert.equal((await send(id, secretText)).status, 200);
  for (const cookie of [outsiderCookie, otherCookie]) {
    const view = await workspace(cookie);
    assert.ok(!view.conversations.some((conversation: any) => conversation.id === id));
    assert.ok(!JSON.stringify(view).includes(secretText));
    for (const path of [messagesPath(id), messagesPath(id) + "?q=4391"])
      assert.equal((await call(path, "GET", undefined, cookie)).status, 404);
    assert.equal((await send(id, "Unauthorized message", cookie)).status, 404);
    assert.equal((await call(staffPath + "/conversations/" + id + "/read",
      "PATCH", { sequence: 1 }, cookie)).status, 404);
  }
  assert.equal((await call(staffPath + "/conversations", "POST",
    { kind: "direct", member_id: otherId })).status, 404);
  assert.equal((await call(staffPath + "/conversations", "POST",
    { kind: "direct", member_id: ownerId })).status, 400);
  assert.equal((await call(staffPath + "/conversations", "POST",
    { kind: "direct", member_id: deskId, member_ids: [outsiderId] })).status, 400);
});

test("a message retry cannot duplicate content or audit history and the same key cannot overwrite a sent message", async () => {
  const conversation = await channel("Reliable delivery");
  const clientId = requestId();
  const first = await send(conversation.id, "Synthetic delivery preserved after a lost response", ownerCookie, clientId);
  assert.equal(first.status, 200);
  const practiceDb = platform.store.db(practiceId);
  const countAudit = () => Number(practiceDb.prepare("SELECT count(*) AS count FROM audit WHERE resource=?")
    .get(first.data.id)?.count);
  const auditCount = countAudit();
  assert.equal((await send(conversation.id, first.data.text, ownerCookie, clientId)).data.id, first.data.id);
  assert.equal(countAudit(), auditCount);
  assert.equal((await send(conversation.id, "Changed text cannot replace the original", ownerCookie, clientId)).status, 409);
  assert.equal((await send(conversation.id, "A different staff member has a separate key scope", deskCookie, clientId)).status, 200);
  const page = await call(messagesPath(conversation.id));
  assert.equal(page.data.messages.length, 2);
  assert.equal(page.data.messages[0].text, first.data.text);
  assert.equal(page.data.messages[0].author.id, ownerId);
  const audit = practiceDb.prepare("SELECT action FROM audit WHERE resource=?").all(first.data.id);
  assert.ok(!JSON.stringify(audit).includes(first.data.text));
});

test("read cursors advance only through the fetched sequence so a later arrival remains unread", async () => {
  const conversation = await channel("Read cursor coordination");
  const first = await send(conversation.id, "First visible message");
  const second = await send(conversation.id, "Second visible message");
  assert.equal((await unread()).unread_messages >= 0, true);
  const before = await unread(deskCookie);
  const fetched = await call(messagesPath(conversation.id), "GET", undefined, deskCookie);
  assert.equal(fetched.data.messages.length, 2);
  assert.equal((await unread(deskCookie)).unread_messages, before.unread_messages);
  const third = await send(conversation.id, "This arrives while the first two are being read");
  assert.equal(third.status, 200);
  assert.equal((await call(staffPath + "/conversations/" + conversation.id + "/read", "PATCH",
    { sequence: fetched.data.latest_sequence }, deskCookie)).status, 200);
  const summary = (await workspace(deskCookie)).conversations.find((c: any) => c.id === conversation.id);
  assert.equal(summary.unread_count, 1);
  assert.equal((await call(staffPath + "/conversations/" + conversation.id + "/read", "PATCH",
    { sequence: first.data.sequence }, deskCookie)).status, 200);
  assert.equal((await workspace(deskCookie)).conversations.find((c: any) => c.id === conversation.id).unread_count, 1);
  assert.equal((await call(staffPath + "/conversations/" + conversation.id + "/read", "PATCH",
    { sequence: third.data.sequence + 10 }, deskCookie)).status, 400);
  assert.equal((await call(staffPath + "/conversations/" + conversation.id + "/read", "PATCH",
    { sequence: second.data.sequence, user_id: ownerId }, deskCookie)).status, 400);
  assert.equal((await workspace()).conversations.find((c: any) => c.id === conversation.id).unread_count, 0);
});

test("conversation history is bounded and searchable without dropping chronological pagination", async () => {
  const conversation = await channel("Searchable handover archive");
  for (let index = 1; index <= 55; index++) {
    const sent = await send(conversation.id, (index === 12 ? "Needle " : "Routine ") + "handover " + index);
    assert.equal(sent.status, 200);
  }
  const latest = await call(messagesPath(conversation.id), "GET", undefined, deskCookie);
  assert.equal(latest.data.messages.length, 50);
  assert.equal(latest.data.messages[0].sequence, 6);
  assert.equal(latest.data.messages.at(-1).sequence, 55);
  assert.equal(latest.data.has_more, true);
  const older = await call(messagesPath(conversation.id) + "?before=" + latest.data.oldest_sequence,
    "GET", undefined, deskCookie);
  assert.deepEqual(older.data.messages.map((message: any) => message.sequence), [1, 2, 3, 4, 5]);
  assert.equal(older.data.has_more, false);
  const found = await call(messagesPath(conversation.id) + "?q=nEeDlE", "GET", undefined, deskCookie);
  assert.equal(found.data.messages.length, 1);
  assert.equal(found.data.messages[0].sequence, 12);
  const focused = await call(messagesPath(conversation.id) + "?focus=" + found.data.messages[0].id,
    "GET", undefined, deskCookie);
  assert.equal(focused.status, 200);
  assert.equal(focused.data.messages.at(-1).sequence, 12);
  assert.equal(focused.data.latest_sequence, 12);
  assert.equal(focused.data.has_later, true);
  assert.equal((await call(messagesPath(conversation.id) + "?focus=missing-source-message")).status, 404);
  assert.equal((await call(messagesPath(conversation.id) + "?focus=" + found.data.messages[0].id + "&q=Needle")).status, 400);
  assert.equal((await workspace(deskCookie)).conversations.find((c: any) => c.id === conversation.id).unread_count, 55);
  for (const query of ["?limit=0", "?limit=101", "?before=-1"])
    assert.equal((await call(messagesPath(conversation.id) + query)).status, 400);
});

test("announcements require administrators, explicit personal acknowledgement, and preserve the original audience", async () => {
  const input = announcementInput("Review the synthetic practice handover");
  assert.equal((await call(staffPath + "/announcements", "POST", input, clinicianCookie)).status, 403);
  const posted = await call(staffPath + "/announcements", "POST", input);
  assert.equal(posted.status, 200);
  const id = posted.data.id;
  assert.equal((await call(staffPath + "/announcements", "POST", input)).data.id, id);
  assert.equal((await call(staffPath + "/announcements", "POST",
    { ...input, title: "A conflicting retry" })).status, 409);
  const own = await announcementView(id);
  assert.equal(own.author.id, ownerId);
  assert.equal(own.needs_acknowledgement, false);
  assert.equal(own.recipient_count, 3);
  assert.equal(own.acknowledged_count, 0);
  assert.equal(own.acknowledgements.length, 3);
  const pending = await announcementView(id, deskCookie);
  assert.equal(pending.needs_acknowledgement, true);
  assert.equal(pending.acknowledgements, undefined);
  const before = await unread(deskCookie);
  await workspace(deskCookie);
  assert.equal((await unread(deskCookie)).unacknowledged_announcements, before.unacknowledged_announcements);
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST",
    { user_id: clinicianId }, deskCookie)).status, 400);
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST", {}, deskCookie)).status, 200);
  const acknowledged = await announcementView(id, deskCookie);
  assert.equal(acknowledged.needs_acknowledgement, false);
  assert.ok(acknowledged.acknowledged_at);
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST", {}, deskCookie)).status, 200);
  assert.equal((await announcementView(id, deskCookie)).acknowledged_at, acknowledged.acknowledged_at);
  assert.equal((await announcementView(id)).acknowledged_count, 1);
  const newcomer = await invite("staff-newcomer@example.test", "Synthetic New Staff", "receptionist");
  assert.equal((await announcementView(id, newcomer.cookie)).needs_acknowledgement, false);
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST",
    {}, newcomer.cookie)).status, 403);
  assert.equal((await call("/account/members/" + outsiderId, "PATCH", {
    role: "receptionist", is_admin: false, is_active: false,
  })).status, 200);
  assert.ok(!(await workspace()).directory.some((member: any) => member.id === outsiderId));
  const historical = await announcementView(id);
  assert.equal(historical.recipient_count, 3);
  assert.equal(historical.acknowledgements.find((ack: any) => ack.member.id === outsiderId).member.is_active, false);
  assert.equal((await call(staffPath, "GET", undefined, outsiderCookie)).status, 401);
  assert.equal((await call(staffPath + "/conversations", "POST",
    { kind: "direct", member_id: outsiderId })).status, 404);
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST",
    {}, otherCookie)).status, 404);
});

test("archiving protects messages, uses revisions, and does not erase announcement acknowledgements", async () => {
  const conversation = await channel("Archived coordination");
  const posted = await send(conversation.id, "Retain the historical staff message");
  const archivePath = staffPath + "/conversations/" + conversation.id;
  assert.equal((await call(archivePath, "PATCH", { archived: true, revision: conversation.revision }, deskCookie)).status, 403);
  const archived = await call(archivePath, "PATCH", { archived: true, revision: conversation.revision });
  assert.equal(archived.status, 200);
  assert.equal((await send(conversation.id, "Cannot append to an archived channel")).status, 409);
  assert.equal((await call(messagesPath(conversation.id))).data.messages[0].id, posted.data.id);
  assert.equal((await call(archivePath, "PATCH", { archived: false, revision: conversation.revision })).status, 409);
  assert.equal((await call(staffPath + "/conversations/staff-general", "PATCH",
    { archived: true, revision: 1 })).status, 409);
  const published = await call(staffPath + "/announcements", "POST", announcementInput("Archive acknowledgement history"));
  const id = published.data.id;
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST", {}, deskCookie)).status, 200);
  const path = staffPath + "/announcements/" + id;
  const announcement = await announcementView(id);
  assert.equal((await call(path, "PATCH", { archived: true, revision: announcement.revision }, deskCookie)).status, 403);
  const saved = await call(path, "PATCH", { archived: true, revision: announcement.revision });
  assert.equal(saved.status, 200);
  assert.equal(await announcementView(id, deskCookie), undefined);
  assert.equal((await call(staffPath + "/announcements/" + id + "/acknowledge", "POST", {}, clinicianCookie)).status, 404);
  assert.equal((await call(path, "PATCH", { archived: false, revision: announcement.revision })).status, 409);
  const restored = await call(path, "PATCH", { archived: false, revision: saved.data.revision });
  assert.equal(restored.status, 200);
  assert.equal((await announcementView(id)).acknowledged_count, 1);
  assert.equal((await announcementView(id, deskCookie)).needs_acknowledgement, false);
});

test("messages, direct membership, read positions and acknowledgements survive server restart", async () => {
  const direct = await call(staffPath + "/conversations", "POST", { kind: "direct", member_id: deskId });
  assert.equal(direct.status, 200);
  const sent = await send(direct.data.id, "Persistent synthetic private staff handover");
  assert.equal(sent.status, 200);
  assert.equal((await call(staffPath + "/conversations/" + direct.data.id + "/read", "PATCH",
    { sequence: sent.data.sequence }, deskCookie)).status, 200);
  const announcement = await call(staffPath + "/announcements", "POST", announcementInput("Persistent synthetic announcement"));
  assert.equal(announcement.status, 200);
  await call(staffPath + "/announcements/" + announcement.data.id + "/acknowledge", "POST", {}, deskCookie);
  const beforeOwner = await workspace();
  const beforeDesk = await workspace(deskCookie);
  await stop();
  platform.store.close();
  db.close();
  db = createDatabase(filename);
  platform = createPlatformApp(db, accounts);
  await listen();
  assert.deepEqual(await workspace(), beforeOwner);
  assert.deepEqual(await workspace(deskCookie), beforeDesk);
  assert.equal((await call(messagesPath(direct.data.id), "GET", undefined, deskCookie)).data.messages.at(-1).id, sent.data.id);
  assert.equal((await call(messagesPath(direct.data.id), "GET", undefined, otherCookie)).status, 404);
});
