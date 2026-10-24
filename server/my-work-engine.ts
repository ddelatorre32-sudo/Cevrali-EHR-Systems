import { allCareTasks, type WorkflowContext, type WorkflowState } from "./workflow-engine.js";
import { staffCommunicationRequest } from "./staff-communication.js";
import { staffTaskView } from "./staff-task-engine.js";
import type { StaffWorkspace } from "./staff-communication-model.js";
import type { MyWorkAuthorization, MyWorkCareTask, MyWorkDashboard, MyWorkReview } from "./my-work-model.js";

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function requireStaff(ctx: WorkflowContext) {
  const member = ctx.users.find((user) => user.id === ctx.user.id);
  if (
    !member || member.is_active === 0 || member.is_active === false ||
    ctx.user.is_active === 0 || ctx.user.is_active === false ||
    !["clinician", "receptionist"].includes(member.role) || member.role !== ctx.user.role
  ) fail(403, "Active practice staff access required");
}

function patientName(ctx: WorkflowContext, id: string) {
  const person = ctx.patients.find((patient) => patient.id === id);
  return person ? `${person.first_name || ""} ${person.last_name || ""}`.trim() || "Patient record" : "Patient record";
}

function chronological<T extends { id: string; due_date: string; priority?: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => Number(b.priority === "High") - Number(a.priority === "High") ||
    (a.due_date || "9999-12-31").localeCompare(b.due_date || "9999-12-31") || a.id.localeCompare(b.id));
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A read-only projection of authoritative source work. Opening this view never
 * acknowledges messages, reports, announcements, or clinical tasks. */
export function myWorkRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  _body: unknown = {},
): MyWorkDashboard {
  requireStaff(ctx);
  if (url.pathname.split("/").filter(Boolean).join("/") !== "my-work")
    fail(404, "My work route not found");
  if (method !== "GET") fail(405, "Use GET to open My work");
  if ([...url.searchParams.keys()].length)
    fail(400, "My work is scoped to the signed-in staff account");

  const communication = staffCommunicationRequest(
    state.staff_communication, ctx, "GET", new URL("/staff", url), {},
  ) as StaffWorkspace;
  const visibleConversations = new Set(communication.conversations.map((conversation) => conversation.id));
  const staff_tasks = (state.staff_communication.action_tasks || [])
    .filter((task) =>
      (task.owner_id === ctx.user.id || task.created_by === ctx.user.id) &&
      visibleConversations.has(task.conversation_id) &&
      state.staff_communication.messages.some((message) =>
        message.id === task.message_id && message.conversation_id === task.conversation_id))
    .map((task) => staffTaskView(state.staff_communication, ctx, task))
    .sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)) ||
      Number(b.priority === "High") - Number(a.priority === "High") ||
      a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));

  const clinical = ctx.user.role === "clinician";
  const care_tasks: MyWorkCareTask[] = [];
  const reviews: MyWorkReview[] = [];
  if (clinical) {
    const allTasks = allCareTasks(state, ctx);
    const reviewTaskIds = new Set(allTasks
      .filter((task) => task.source_key?.startsWith("result:") || task.source_key?.startsWith("incoming-fax:"))
      .map((task) => task.id));
    for (const fax of state.operations.incoming_faxes)
      if (fax.clinical_task_id) reviewTaskIds.add(fax.clinical_task_id);

    // A generic task's completed flag cannot replace actual report review.
    for (const result of state.results) {
      if (result.reviewed_at) continue;
      const task = allTasks.find((candidate) => candidate.source_key === `result:${result.id}`);
      const order = state.orders.find((candidate) => candidate.id === result.order_id);
      if ((task ? task.owner_id : order?.author_id) !== ctx.user.id) continue;
      reviews.push({
        id: String(result.id),
        kind: "result",
        title: `Review result: ${String(result.name || "Lab result")}`,
        patient_id: String(result.patient_id),
        patient_name: patientName(ctx, String(result.patient_id)),
        priority: task?.priority === "High" || (result.flag && result.flag !== "Normal") ? "High" : "Normal",
        due_date: task?.due_date || String(result.date || ""),
        recorded_at: String(result.recorded_at || result.date || ""),
        destination: "orders",
      });
    }
    for (const fax of state.operations.incoming_faxes) {
      if (fax.status !== "Filed" || fax.reviewed_at) continue;
      const task = allTasks.find((candidate) => candidate.id === fax.clinical_task_id) ||
        allTasks.find((candidate) => candidate.source_key === `incoming-fax:${fax.id}:${fax.revision}`);
      if (!task || task.owner_id !== ctx.user.id) continue;
      reviews.push({
        id: fax.id,
        kind: "document",
        title: `Review outside document: ${fax.kind || "Received report"}`,
        patient_id: fax.patient_id,
        patient_name: patientName(ctx, fax.patient_id),
        priority: task.priority === "High" ? "High" : "Normal",
        due_date: task.due_date,
        recorded_at: fax.received_at,
        destination: "fax-inbox",
      });
    }
    for (const task of allTasks) {
      if (task.owner_id !== ctx.user.id || task.done || reviewTaskIds.has(task.id)) continue;
      care_tasks.push({
        id: task.id,
        title: task.title,
        patient_id: task.patient_id,
        patient_name: task.patient_id ? patientName(ctx, task.patient_id) : "",
        category: task.category,
        priority: task.priority === "High" ? "High" : "Normal",
        due_date: task.due_date,
        done: Number(Boolean(task.done)),
        can_complete: !state.note_addenda.corrections.some((correction) =>
          correction.task_id === task.id && correction.status === "Needs addendum"),
      });
    }
    chronological(care_tasks);
    chronological(reviews);
  }

  const authorizations: MyWorkAuthorization[] = state.finance.authorizations
    .filter((authorization) => authorization.owner_id === ctx.user.id &&
      ["Draft", "Demo submitted"].includes(authorization.status) &&
      validDate(authorization.due_date) && authorization.due_date <= ctx.today)
    .map((authorization) => ({
      id: authorization.id,
      patient_id: authorization.patient_id,
      patient_name: patientName(ctx, authorization.patient_id),
      payer: state.finance.policies.find((policy) => policy.id === authorization.policy_id)?.payer || "Insurance payer",
      status: authorization.status,
      due_date: authorization.due_date,
      overdue: authorization.due_date < ctx.today,
    }));
  chronological(authorizations);

  const ownOpenStaff = staff_tasks.filter((task) => task.owner_id === ctx.user.id && !task.done);
  const datedWork = [
    ...ownOpenStaff.map((task) => ({ key: `staff:${task.id}`, due_date: task.due_date })),
    ...care_tasks.map((task) => ({ key: `care:${task.id}`, due_date: task.due_date })),
    ...reviews.map((review) => ({ key: `review:${review.kind}:${review.id}`, due_date: review.due_date })),
    ...authorizations.map((authorization) => ({ key: `authorization:${authorization.id}`, due_date: authorization.due_date })),
  ];
  const uniqueDatedWork = [...new Map(datedWork.map((item) => [item.key, item])).values()];
  return {
    viewer_id: ctx.user.id,
    today: ctx.today,
    clinical,
    counts: {
      assigned_tasks: ownOpenStaff.length + care_tasks.length,
      overdue: uniqueDatedWork.filter((item) => validDate(item.due_date) && item.due_date < ctx.today).length,
      due_today: uniqueDatedWork.filter((item) => item.due_date === ctx.today).length,
      awaiting_review: reviews.length,
      authorization_followups: authorizations.length,
      unread_messages: communication.unread_messages,
      announcements_to_acknowledge: communication.unacknowledged_announcements,
    },
    staff_tasks,
    care_tasks,
    reviews,
    authorizations,
    conversations: communication.conversations.filter((conversation) => conversation.unread_count > 0),
    announcements: communication.announcements.filter((announcement) => announcement.needs_acknowledgement),
  };
}
