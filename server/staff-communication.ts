import { z } from "zod";
import type { WorkflowContext, WorkflowUser } from "./workflow-engine.js";
import type {
  StaffAnnouncement,
  StaffAnnouncementView,
  StaffCommunicationState,
  StaffConversation,
  StaffConversationView,
  StaffMessage,
  StaffMessagePage,
  StaffMessageView,
  StaffPerson,
  StaffUnread,
  StaffWorkspace,
} from "./staff-communication-model.js";

const generalId = "staff-general";
const clientId = z.string().trim().min(8).max(100);
const revisionInput = z.object({
  archived: z.boolean(),
  revision: z.number().int().positive(),
}).strict();
const channelInput = z.object({
  kind: z.literal("channel"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(240).default(""),
  client_id: clientId,
}).strict();
const directInput = z.object({
  kind: z.literal("direct"),
  member_id: z.string().trim().min(1).max(160),
}).strict();
const announcementInput = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  priority: z.enum(["Normal", "Urgent"]).default("Normal"),
  requires_acknowledgement: z.boolean().default(true),
  client_id: clientId,
}).strict();

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function isActive(user: WorkflowUser): boolean {
  return user.is_active !== false && user.is_active !== 0;
}

function isStaff(user: WorkflowUser): boolean {
  return ["clinician", "receptionist"].includes(user.role);
}

function person(ctx: WorkflowContext, id: string): StaffPerson {
  const user = ctx.users.find((candidate) => candidate.id === id);
  return {
    id,
    name: user?.name || "Former team member",
    role: user?.role || "Staff",
    is_active: Boolean(user && isActive(user) && isStaff(user)),
  };
}

function requireStaff(ctx: WorkflowContext) {
  const user = ctx.users.find((candidate) => candidate.id === ctx.user.id);
  if (!user || !isActive(user) || !isStaff(user) || !isStaff(ctx.user))
    fail(403, "Active practice staff access required");
}

function requireAdmin(ctx: WorkflowContext) {
  if (!ctx.user.is_admin) fail(403, "Practice administrator access required");
}

function canView(conversation: StaffConversation, ctx: WorkflowContext): boolean {
  return conversation.kind === "channel" || conversation.member_ids.includes(ctx.user.id);
}

function canPost(conversation: StaffConversation, ctx: WorkflowContext): boolean {
  return !conversation.archived && canView(conversation, ctx) &&
    (conversation.kind === "channel" ||
      conversation.member_ids.every((id) => person(ctx, id).is_active));
}

function getConversation(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  id: string,
): StaffConversation {
  const conversation = state.conversations.find((candidate) => candidate.id === id);
  if (!conversation || !canView(conversation, ctx))
    fail(404, "Staff conversation not found");
  return conversation;
}

function messageView(message: StaffMessage, ctx: WorkflowContext): StaffMessageView {
  const { author_id, client_id: _clientId, ...visible } = message;
  return { ...visible, author: person(ctx, author_id) };
}

function conversationMessages(state: StaffCommunicationState, id: string) {
  return state.messages.filter((message) => message.conversation_id === id);
}

function unreadCount(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  conversation: StaffConversation,
): number {
  if (conversation.archived) return 0;
  const cursor = state.read_cursors[ctx.user.id]?.[conversation.id] || 0;
  return conversationMessages(state, conversation.id)
    .filter((message) => message.author_id !== ctx.user.id && message.sequence > cursor).length;
}

function conversationView(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  conversation: StaffConversation,
): StaffConversationView {
  const messages = conversationMessages(state, conversation.id);
  const last = messages.reduce<StaffMessage | null>(
    (latest, message) => !latest || latest.sequence < message.sequence ? message : latest,
    null,
  );
  const { client_id: _clientId, ...visible } = conversation;
  return {
    ...visible,
    name: conversation.kind === "direct"
      ? person(ctx, conversation.member_ids.find((id) => id !== ctx.user.id) || "").name
      : conversation.name,
    unread_count: unreadCount(state, ctx, conversation),
    last_message: last ? messageView(last, ctx) : null,
    can_post: canPost(conversation, ctx),
  };
}

function needsAcknowledgement(announcement: StaffAnnouncement, userId: string): boolean {
  return !announcement.archived && announcement.requires_acknowledgement &&
    announcement.recipient_ids.includes(userId) && !announcement.acknowledgements[userId];
}

function announcementView(
  announcement: StaffAnnouncement,
  ctx: WorkflowContext,
): StaffAnnouncementView {
  const { author_id, recipient_ids, acknowledgements, client_id: _clientId, ...visible } = announcement;
  return {
    ...visible,
    author: person(ctx, author_id),
    needs_acknowledgement: needsAcknowledgement(announcement, ctx.user.id),
    acknowledged_at: acknowledgements[ctx.user.id] || null,
    acknowledged_count: recipient_ids.filter((id) => Boolean(acknowledgements[id])).length,
    recipient_count: recipient_ids.length,
    ...(ctx.user.is_admin ? {
      acknowledgements: recipient_ids.map((id) => ({
        member: person(ctx, id),
        acknowledged_at: acknowledgements[id] || null,
      })),
    } : {}),
  };
}

function unread(state: StaffCommunicationState, ctx: WorkflowContext): StaffUnread {
  const unread_messages = state.conversations
    .filter((conversation) => canView(conversation, ctx))
    .reduce((total, conversation) => total + unreadCount(state, ctx, conversation), 0);
  const unacknowledged_announcements = state.announcements
    .filter((announcement) => needsAcknowledgement(announcement, ctx.user.id)).length;
  return {
    unread_messages,
    unacknowledged_announcements,
    total: unread_messages + unacknowledged_announcements,
  };
}

function ensureGeneral(state: StaffCommunicationState, ctx: WorkflowContext) {
  if (!state.conversations.some((conversation) => conversation.id === generalId))
    state.conversations.unshift({
      id: generalId,
      kind: "channel",
      name: "General",
      description: "Practice-wide updates and everyday teamwork.",
      member_ids: [],
      created_by: ctx.user.id,
      created_at: ctx.now,
      archived: false,
      revision: 1,
    });
}

function ensureUniqueChannelName(
  state: StaffCommunicationState,
  name: string,
  exceptId?: string,
) {
  if (state.conversations.some((conversation) =>
    conversation.kind === "channel" && !conversation.archived &&
    conversation.id !== exceptId && conversation.name.toLowerCase() === name.toLowerCase()))
    fail(409, "An active channel with this name already exists");
}

export function emptyStaffCommunicationState(): StaffCommunicationState {
  return { conversations: [], messages: [], read_cursors: {}, announcements: [] };
}

export function staffCommunicationRequest(
  state: StaffCommunicationState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
): unknown {
  requireStaff(ctx);
  const [resource, collection, id, action, extra] = url.pathname.split("/").filter(Boolean);
  if (resource !== "staff" || extra) fail(404, "Staff communication route not found");
  ensureGeneral(state, ctx);

  if (method === "GET" && !collection) {
    const workspace: StaffWorkspace = {
      ...unread(state, ctx),
      viewer_id: ctx.user.id,
      can_manage: Boolean(ctx.user.is_admin),
      directory: ctx.users.filter((user) => isActive(user) && isStaff(user))
        .map((user) => person(ctx, user.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
      conversations: state.conversations.filter((conversation) => canView(conversation, ctx))
        .map((conversation) => conversationView(state, ctx, conversation)),
      announcements: state.announcements
        .filter((announcement) => !announcement.archived || Boolean(ctx.user.is_admin))
        .sort((a, b) => Number(a.archived) - Number(b.archived) ||
          Number(b.priority === "Urgent") - Number(a.priority === "Urgent") ||
          b.created_at.localeCompare(a.created_at))
        .map((announcement) => announcementView(announcement, ctx)),
    };
    return workspace;
  }
  if (method === "GET" && collection === "unread" && !id)
    return unread(state, ctx);

  if (collection === "conversations") {
    if (method === "POST" && !id) {
      const input = z.discriminatedUnion("kind", [channelInput, directInput]).parse(body);
      if (input.kind === "channel") {
        requireAdmin(ctx);
        const previous = state.conversations.find((conversation) =>
          conversation.kind === "channel" && conversation.created_by === ctx.user.id &&
          conversation.client_id === input.client_id);
        if (previous) {
          if (previous.name !== input.name || previous.description !== input.description)
            fail(409, "This channel request was already used with different details");
          return conversationView(state, ctx, previous);
        }
        ensureUniqueChannelName(state, input.name);
        const conversation: StaffConversation = {
          id: ctx.id("staff-channel"),
          kind: "channel",
          name: input.name,
          description: input.description,
          client_id: input.client_id,
          member_ids: [],
          created_by: ctx.user.id,
          created_at: ctx.now,
          archived: false,
          revision: 1,
        };
        state.conversations.push(conversation);
        ctx.audit("Created staff channel", conversation.id);
        return conversationView(state, ctx, conversation);
      }
      const member = ctx.users.find((candidate) => candidate.id === input.member_id);
      if (!member || !isActive(member) || !isStaff(member))
        fail(404, "Active staff member not found");
      if (member.id === ctx.user.id) fail(400, "Choose another staff member to message");
      const memberIds = [ctx.user.id, member.id].sort();
      const previous = state.conversations.find((conversation) =>
        conversation.kind === "direct" && conversation.member_ids.length === 2 &&
        memberIds.every((memberId) => conversation.member_ids.includes(memberId)));
      if (previous) return conversationView(state, ctx, previous);
      const conversation: StaffConversation = {
        id: ctx.id("staff-direct"),
        kind: "direct",
        name: "",
        description: "Private conversation between two staff members.",
        member_ids: memberIds,
        created_by: ctx.user.id,
        created_at: ctx.now,
        archived: false,
        revision: 1,
      };
      state.conversations.push(conversation);
      ctx.audit("Opened direct staff conversation", conversation.id);
      return conversationView(state, ctx, conversation);
    }
    if (!id) fail(404, "Staff communication route not found");
    const conversation = getConversation(state, ctx, id);
    if (method === "PATCH" && !action) {
      requireAdmin(ctx);
      if (conversation.kind !== "channel") fail(400, "Direct conversations cannot be archived");
      const input = revisionInput.parse(body);
      if (conversation.id === generalId) fail(409, "The General channel must remain available");
      if (conversation.revision !== input.revision)
        fail(409, "This channel changed. Refresh and try again.");
      if (conversation.archived !== input.archived) {
        if (!input.archived) ensureUniqueChannelName(state, conversation.name, conversation.id);
        conversation.archived = input.archived;
        conversation.revision++;
        ctx.audit(input.archived ? "Archived staff channel" : "Restored staff channel", conversation.id);
      }
      return conversationView(state, ctx, conversation);
    }
    if (action === "messages" && method === "GET") {
      const query = z.object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        q: z.string().trim().max(100).default(""),
      }).parse({
        before: url.searchParams.get("before") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
      });
      const needle = query.q.toLowerCase();
      const matching = conversationMessages(state, conversation.id)
        .filter((message) => (query.before === undefined || message.sequence < query.before) &&
          (!needle || message.text.toLowerCase().includes(needle)))
        .sort((a, b) => a.sequence - b.sequence);
      const selected = matching.slice(-query.limit);
      const page: StaffMessagePage = {
        conversation: conversationView(state, ctx, conversation),
        messages: selected.map((message) => messageView(message, ctx)),
        has_more: matching.length > selected.length,
        oldest_sequence: selected[0]?.sequence ?? null,
        latest_sequence: selected.at(-1)?.sequence ?? 0,
      };
      return page;
    }
    if (action === "messages" && method === "POST") {
      const input = z.object({
        text: z.string().trim().min(1).max(4000),
        client_id: clientId,
      }).strict().parse(body);
      const previous = state.messages.find((message) =>
        message.conversation_id === conversation.id && message.author_id === ctx.user.id &&
        message.client_id === input.client_id);
      if (previous) {
        if (previous.text !== input.text)
          fail(409, "This message request was already used with different text");
        return messageView(previous, ctx);
      }
      if (!canPost(conversation, ctx))
        fail(409, conversation.archived
          ? "This channel is archived. Its message history is read-only."
          : "This conversation includes an inactive staff member and is read-only.");
      const sequence = conversationMessages(state, conversation.id)
        .reduce((latest, message) => Math.max(latest, message.sequence), 0) + 1;
      const message: StaffMessage = {
        id: ctx.id("staff-message"),
        conversation_id: conversation.id,
        author_id: ctx.user.id,
        text: input.text,
        client_id: input.client_id,
        sequence,
        created_at: ctx.now,
      };
      state.messages.push(message);
      ctx.audit("Sent staff message", message.id);
      return messageView(message, ctx);
    }
    if (action === "read" && method === "PATCH") {
      const input = z.object({ sequence: z.number().int().nonnegative() }).strict().parse(body);
      if (input.sequence !== 0 && !state.messages.some((message) =>
        message.conversation_id === conversation.id && message.sequence === input.sequence))
        fail(400, "Read position must identify a message in this conversation");
      const cursors = state.read_cursors[ctx.user.id] ||= {};
      cursors[conversation.id] = Math.max(cursors[conversation.id] || 0, input.sequence);
      return { ok: true, ...unread(state, ctx) };
    }
  }

  if (collection === "announcements") {
    if (method === "POST" && !id) {
      requireAdmin(ctx);
      const input = announcementInput.parse(body);
      const previous = state.announcements.find((announcement) =>
        announcement.author_id === ctx.user.id && announcement.client_id === input.client_id);
      if (previous) {
        if (previous.title !== input.title || previous.body !== input.body ||
          previous.priority !== input.priority ||
          previous.requires_acknowledgement !== input.requires_acknowledgement)
          fail(409, "This announcement request was already used with different details");
        return announcementView(previous, ctx);
      }
      const announcement: StaffAnnouncement = {
        ...input,
        id: ctx.id("staff-announcement"),
        author_id: ctx.user.id,
        created_at: ctx.now,
        recipient_ids: ctx.users.filter((user) =>
          user.id !== ctx.user.id && isActive(user) && isStaff(user)).map((user) => user.id),
        acknowledgements: {},
        archived: false,
        revision: 1,
      };
      state.announcements.push(announcement);
      ctx.audit("Published staff announcement", announcement.id);
      return announcementView(announcement, ctx);
    }
    const announcement = state.announcements.find((candidate) => candidate.id === id);
    if (!announcement || (announcement.archived && !ctx.user.is_admin))
      fail(404, "Staff announcement not found");
    if (method === "PATCH" && !action) {
      requireAdmin(ctx);
      const input = revisionInput.parse(body);
      if (announcement.revision !== input.revision)
        fail(409, "This announcement changed. Refresh and try again.");
      if (announcement.archived !== input.archived) {
        announcement.archived = input.archived;
        announcement.revision++;
        ctx.audit(input.archived ? "Archived staff announcement" : "Restored staff announcement", announcement.id);
      }
      return announcementView(announcement, ctx);
    }
    if (method === "POST" && action === "acknowledge") {
      z.object({}).strict().parse(body);
      if (announcement.archived) fail(409, "Archived announcements cannot be acknowledged");
      if (!announcement.requires_acknowledgement)
        fail(409, "This announcement does not request acknowledgement");
      if (!announcement.recipient_ids.includes(ctx.user.id))
        fail(403, "This announcement did not request acknowledgement from your account");
      if (!announcement.acknowledgements[ctx.user.id]) {
        announcement.acknowledgements[ctx.user.id] = ctx.now;
        ctx.audit("Acknowledged staff announcement", announcement.id);
      }
      return announcementView(announcement, ctx);
    }
  }
  return fail(404, "Staff communication route not found");
}
