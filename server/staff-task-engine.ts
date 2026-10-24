import { z } from "zod";
import type { WorkflowContext, WorkflowUser } from "./workflow-engine.js";
import type {
  StaffCommunicationState,
  StaffConversation,
  StaffMessage,
  StaffPerson,
} from "./staff-communication-model.js";
import type {
  StaffActionTask,
  StaffTaskAssignment,
  StaffTaskHistory,
  StaffTaskView,
} from "./staff-task-model.js";

const text = z.string().trim().min(1).max(200);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date");
const assignment = z.object({
  title: text,
  owner_id: text,
  due_date: day,
  priority: z.enum(["High", "Normal"]).default("Normal"),
});
const createInput = assignment.extend({
  conversation_id: text,
  message_id: text,
  client_id: z.string().trim().min(8).max(100),
}).strict();
const patchInput = z.object({
  revision: z.number().int().positive(),
  title: text.optional(),
  owner_id: text.optional(),
  due_date: day.optional(),
  priority: z.enum(["High", "Normal"]).optional(),
  done: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "revision"),
  "Include a task change");

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function activeStaff(user: WorkflowUser | undefined): user is WorkflowUser {
  return Boolean(user && ["clinician", "receptionist"].includes(user.role) &&
    user.is_active !== false && user.is_active !== 0);
}

function requireStaff(ctx: WorkflowContext) {
  const member = ctx.users.find((user) => user.id === ctx.user.id);
  if (!activeStaff(member) || !activeStaff(ctx.user) || member.role !== ctx.user.role)
    fail(403, "Active practice staff access required");
}

function person(ctx: WorkflowContext, id: string): StaffPerson {
  const member = ctx.users.find((user) => user.id === id);
  return {
    id,
    name: member?.name || "Former team member",
    role: member?.role || "Staff",
    is_active: activeStaff(member),
  };
}

function visible(conversation: StaffConversation, ctx: WorkflowContext) {
  return conversation.kind === "channel" || conversation.member_ids.includes(ctx.user.id);
}

function source(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  conversationId: string,
  messageId: string,
): { conversation: StaffConversation; message: StaffMessage } {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation || !visible(conversation, ctx)) fail(404, "Staff task source not found");
  const message = state.messages.find((item) =>
    item.id === messageId && item.conversation_id === conversation.id);
  if (!message) fail(404, "Staff task source not found");
  return { conversation, message };
}

function allowedAssignees(ctx: WorkflowContext, conversation: StaffConversation): StaffPerson[] {
  return ctx.users.filter((member) => activeStaff(member) &&
    (conversation.kind === "channel" || conversation.member_ids.includes(member.id)))
    .map((member) => person(ctx, member.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function validateAssignee(ctx: WorkflowContext, conversation: StaffConversation, ownerId: string) {
  if (!allowedAssignees(ctx, conversation).some((member) => member.id === ownerId))
    fail(400, conversation.kind === "direct"
      ? "Choose an active participant in this direct conversation"
      : "Choose an active staff member in this practice");
}

function taskAssignment(task: StaffTaskAssignment): StaffTaskAssignment {
  return {
    title: task.title,
    owner_id: task.owner_id,
    due_date: task.due_date,
    priority: task.priority,
  };
}

function snapshot(task: StaffTaskAssignment & { done: number }) {
  return { ...taskAssignment(task), done: Number(Boolean(task.done)) };
}

function canEdit(task: StaffActionTask, ctx: WorkflowContext) {
  return task.created_by === ctx.user.id || task.owner_id === ctx.user.id || Boolean(ctx.user.is_admin);
}

function getTask(state: StaffCommunicationState, ctx: WorkflowContext, id: string) {
  const task = (state.action_tasks || []).find((item) => item.id === id);
  if (!task) fail(404, "Staff task not found");
  source(state, ctx, task.conversation_id, task.message_id);
  return task;
}

/** Every task response rechecks the original conversation, including for admins. */
export function staffTaskView(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  task: StaffActionTask,
): StaffTaskView {
  requireStaff(ctx);
  const { conversation, message } = source(state, ctx, task.conversation_id, task.message_id);
  const { client_id: _clientId, initial_assignment: _initial, ...details } = task;
  return {
    ...details,
    history: structuredClone(task.history),
    owner: person(ctx, task.owner_id),
    creator: person(ctx, task.created_by),
    conversation: {
      id: conversation.id,
      name: conversation.kind === "channel" ? conversation.name :
        person(ctx, conversation.member_ids.find((id) => id !== ctx.user.id) || "").name,
      kind: conversation.kind,
      archived: conversation.archived,
    },
    source_message: {
      id: message.id,
      conversation_id: message.conversation_id,
      text: message.text,
      sequence: message.sequence,
      created_at: message.created_at,
      author: person(ctx, message.author_id),
    },
    can_edit: canEdit(task, ctx),
    allowed_assignees: allowedAssignees(ctx, conversation),
  };
}

export function staffTaskRequest(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown = {},
): StaffTaskView | StaffTaskView[] {
  requireStaff(ctx);
  const [resource, id, extra] = url.pathname.split("/").filter(Boolean);
  if (resource !== "staff-tasks" || extra) fail(404, "Staff task route not found");

  if (method === "GET" && !id) {
    const query = z.object({
      scope: z.enum(["mine", "all"]).default("mine"),
      status: z.enum(["open", "completed", "all"]).default("all"),
      conversation_id: text.optional(),
    }).strict().parse(Object.fromEntries(url.searchParams));
    return (state.action_tasks || []).filter((task) => {
      const conversation = state.conversations.find((item) => item.id === task.conversation_id);
      return conversation && visible(conversation, ctx) &&
        state.messages.some((message) => message.id === task.message_id && message.conversation_id === conversation.id) &&
        (query.scope === "all" || task.owner_id === ctx.user.id) &&
        (!query.conversation_id || task.conversation_id === query.conversation_id) &&
        (query.status === "all" || Boolean(task.done) === (query.status === "completed"));
    }).sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)) ||
      Number(b.priority === "High") - Number(a.priority === "High") ||
      a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id))
      .map((task) => staffTaskView(state, ctx, task));
  }

  if (method === "POST" && !id) {
    const input = createInput.parse(body);
    const { conversation } = source(state, ctx, input.conversation_id, input.message_id);
    const requested = taskAssignment(input);
    const previous = (state.action_tasks || []).find((task) =>
      task.created_by === ctx.user.id && task.client_id === input.client_id);
    if (previous) {
      if (previous.conversation_id !== input.conversation_id || previous.message_id !== input.message_id ||
        JSON.stringify(previous.initial_assignment) !== JSON.stringify(requested))
        fail(409, "This task request was already used with different details");
      return staffTaskView(state, ctx, previous);
    }
    if ((state.action_tasks || []).some((task) => task.conversation_id === conversation.id &&
      task.message_id === input.message_id))
      fail(409, "A task already exists for this message. Refresh and open that task.");
    if (conversation.archived || (conversation.kind === "direct" &&
      !conversation.member_ids.every((memberId) => activeStaff(ctx.users.find((member) => member.id === memberId)))))
      fail(409, "Create tasks from an active conversation. Existing follow-ups can still be maintained.");
    validateAssignee(ctx, conversation, input.owner_id);
    const task: StaffActionTask = {
      ...requested,
      id: ctx.id("staff-task"),
      conversation_id: conversation.id,
      message_id: input.message_id,
      created_by: ctx.user.id,
      created_at: ctx.now,
      updated_at: ctx.now,
      completed_at: null,
      done: 0,
      revision: 1,
      client_id: input.client_id,
      initial_assignment: { ...requested },
      history: [{
        revision: 1,
        at: ctx.now,
        actor_id: ctx.user.id,
        actor_name: ctx.user.name,
        action: "Created",
        before: null,
        after: { ...requested, done: 0 },
      }],
    };
    (state.action_tasks ||= []).push(task);
    ctx.audit("Created staff task", task.id);
    return staffTaskView(state, ctx, task);
  }

  if (id && method === "GET") {
    z.object({}).strict().parse(Object.fromEntries(url.searchParams));
    return staffTaskView(state, ctx, getTask(state, ctx, id));
  }

  if (id && method === "PATCH") {
    const task = getTask(state, ctx, id);
    if (!canEdit(task, ctx)) fail(403, "Only the task creator, assignee, or a practice administrator can update this task");
    const input = patchInput.parse(body);
    if (input.revision !== task.revision) fail(409, "This task changed. Refresh and review the latest version.");
    const { conversation } = source(state, ctx, task.conversation_id, task.message_id);
    const before = snapshot(task);
    const after = {
      title: input.title ?? task.title,
      owner_id: input.owner_id ?? task.owner_id,
      due_date: input.due_date ?? task.due_date,
      priority: input.priority ?? task.priority,
      done: input.done === undefined ? Number(Boolean(task.done)) : Number(input.done),
    };
    const metadataChanged = JSON.stringify(taskAssignment(before)) !== JSON.stringify(taskAssignment(after));
    if (task.done && metadataChanged && input.done !== false)
      fail(409, "Reopen a completed task before changing its assignment or details");
    if (after.owner_id !== task.owner_id) validateAssignee(ctx, conversation, after.owner_id);
    if (JSON.stringify(before) === JSON.stringify(after)) return staffTaskView(state, ctx, task);
    const action: StaffTaskHistory["action"] = before.done !== after.done
      ? after.done ? "Completed" : "Reopened"
      : "Updated";
    Object.assign(task, after, {
      revision: task.revision + 1,
      updated_at: ctx.now,
      completed_at: before.done === after.done ? task.completed_at : after.done ? ctx.now : null,
    });
    task.history.push({
      revision: task.revision,
      at: ctx.now,
      actor_id: ctx.user.id,
      actor_name: ctx.user.name,
      action,
      before,
      after,
    });
    ctx.audit(`${action} staff task`, task.id);
    return staffTaskView(state, ctx, task);
  }
  return fail(404, "Staff task route not found");
}
