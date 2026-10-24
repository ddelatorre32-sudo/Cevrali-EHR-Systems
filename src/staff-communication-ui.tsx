import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Archive, Check, CheckCheck, ClipboardCheck, Hash, Megaphone, MessageCircle, Plus, RefreshCw, Search, Send, UsersRound } from "lucide-react";
import { api, patch, post } from "./api";
import { Modal } from "./components";
import { CreateMessageTaskDialog, StaffTaskDialog } from "./staff-task-ui";
import type { StaffTaskSummary, StaffTaskView } from "../server/staff-task-model";
import type { User } from "./types";
import type {
  StaffAnnouncementView, StaffConversationView, StaffMessagePage,
  StaffMessageView, StaffPerson, StaffUnread, StaffWorkspace,
} from "../server/staff-communication-model";
import "./staff-communication.css";

const base = "/workflow/staff";
const updatedEvent = "cevrali:staff-updated";
type UpdatedDetail = { conversationId?: string; refreshMessages?: boolean };
const notifyUpdated = (detail: UpdatedDetail = {}) =>
  window.dispatchEvent(new CustomEvent(updatedEvent, { detail }));
const newClientId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
  Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join("");
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : "The request could not be completed. Please try again.";
const roleName = (role: string) => role === "clinician" ? "Clinician" : "Front desk";
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join("").toUpperCase();
const timestamp = (value: string) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(new Date(value));
const mergedMessages = (existing: StaffMessageView[], incoming: StaffMessageView[]) =>
  [...new Map([...existing, ...incoming].map(message => [message.id, message])).values()]
    .sort((a, b) => a.sequence - b.sequence);

export function StaffUnreadBadge() {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      const request = ++sequence;
      try {
        const counts = await api<StaffUnread>(`${base}/unread`);
        if (active && request === sequence) setTotal(counts.total);
      } catch { /* The communication page provides a visible connection retry. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    const update = () => void refresh();
    window.addEventListener("focus", update);
    window.addEventListener(updatedEvent, update);
    return () => {
      active = false; ++sequence;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener(updatedEvent, update);
    };
  }, []);
  return total ? <em className="staff-unread-badge" aria-hidden="true">{total > 99 ? "99+" : total}</em> : null;
}

type Draft = { text: string; clientId: string };
type Tab = "messages" | "announcements" | "directory";

export function StaffCommunicationPage({ user, initialConversationId, initialMessageId, initialAnnouncementId }: {
  user: User;
  initialConversationId?: string;
  initialMessageId?: string;
  initialAnnouncementId?: string;
}) {
  const [workspace, setWorkspace] = useState<StaffWorkspace | null>(null);
  const workspaceRef = useRef<StaffWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>(initialAnnouncementId ? "announcements" : "messages");
  const [selectedId, setSelectedId] = useState(initialConversationId || "");
  const [messageFocus, setMessageFocus] = useState({ conversationId: initialConversationId || "", messageId: initialMessageId || "" });
  const [taskSource, setTaskSource] = useState<{ message: StaffMessageView; conversation: StaffConversationView } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [messageTasks, setMessageTasks] = useState<Record<string, StaffTaskSummary>>({});
  const focusedAnnouncement = useRef("");
  const requestedConversation = useRef(initialConversationId || "");
  requestedConversation.current = initialConversationId || "";
  const [modal, setModal] = useState<"channel" | "announcement" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [announcementArchived, setAnnouncementArchived] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [announcementQuery, setAnnouncementQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef<Record<string, Draft>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const sendingRef = useRef(new Set<string>());
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [sentMessages, setSentMessages] = useState<Record<string, StaffMessageView[]>>({});
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const alive = useRef(true);
  const loadSequence = useRef(0);

  const rememberWorkspace = useCallback((next: StaffWorkspace) => {
    workspaceRef.current = next;
    setWorkspace(next);
    setSelectedId(selected => next.conversations.some(conversation => conversation.id === selected)
      ? selected : requestedConversation.current && !next.conversations.some(conversation => conversation.id === requestedConversation.current)
        ? "" : next.conversations.find(conversation => !conversation.archived)?.id || "");
  }, []);
  const reload = useCallback(async () => {
    const request = ++loadSequence.current;
    if (!workspaceRef.current) setLoading(true);
    try {
      const next = await api<StaffWorkspace>(base);
      if (!alive.current || request !== loadSequence.current) return;
      rememberWorkspace(next);
      setError(requestedConversation.current && !next.conversations.some(conversation => conversation.id === requestedConversation.current)
        ? "This source conversation is no longer available to your account." : "");
    } catch (cause) {
      if (alive.current && request === loadSequence.current) setError(errorMessage(cause));
    } finally {
      if (alive.current && request === loadSequence.current) setLoading(false);
    }
  }, [rememberWorkspace]);
  useEffect(() => {
    alive.current = true;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void reload();
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    window.addEventListener(updatedEvent, refresh);
    return () => {
      alive.current = false; ++loadSequence.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(updatedEvent, refresh);
    };
  }, [reload]);
  useEffect(() => {
    if (initialAnnouncementId) setTab("announcements");
    else if (initialConversationId) {
      setSelectedId(initialConversationId); setTab("messages");
      setMessageFocus({ conversationId: initialConversationId, messageId: initialMessageId || "" });
    }
  }, [initialConversationId, initialMessageId, initialAnnouncementId]);
  useEffect(() => {
    if (!initialAnnouncementId || tab !== "announcements" || !workspace || focusedAnnouncement.current === initialAnnouncementId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-staff-announcement-id]")]
        .find(element => element.dataset.staffAnnouncementId === initialAnnouncementId);
      if (target) { target.scrollIntoView({ block: "center" }); focusedAnnouncement.current = initialAnnouncementId; }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialAnnouncementId, tab, workspace]);

  function rememberTask(task: StaffTaskView) {
    setMessageTasks(current => ({ ...current, [task.message_id]: {
      id: task.id, title: task.title, owner_id: task.owner_id, owner_name: task.owner.name,
      due_date: task.due_date, priority: task.priority, done: task.done, revision: task.revision,
    } }));
  }
  function openTaskConversation(conversationId: string, messageId?: string) {
    setTaskId(null); setSelectedId(conversationId); setTab("messages");
    setMessageFocus({ conversationId, messageId: messageId || "" });
  }

  function rememberConversation(conversation: StaffConversationView) {
    const current = workspaceRef.current;
    if (!current) return;
    rememberWorkspace({ ...current, conversations: current.conversations.some(item => item.id === conversation.id)
      ? current.conversations.map(item => item.id === conversation.id ? conversation : item)
      : [...current.conversations, conversation] });
  }
  function rememberAnnouncement(announcement: StaffAnnouncementView) {
    const current = workspaceRef.current;
    if (!current) return;
    rememberWorkspace({ ...current, announcements: current.announcements.some(item => item.id === announcement.id)
      ? current.announcements.map(item => item.id === announcement.id ? announcement : item)
      : [announcement, ...current.announcements] });
  }
  function changeDraft(conversationId: string, text: string) {
    const previous = draftsRef.current[conversationId];
    if (previous?.text === text) return;
    const next = { ...draftsRef.current, [conversationId]: { text, clientId: newClientId() } };
    draftsRef.current = next;
    setDrafts(next);
    setSendErrors(current => ({ ...current, [conversationId]: "" }));
  }
  async function sendMessage(conversationId: string) {
    const draft = draftsRef.current[conversationId];
    if (!draft?.text.trim() || sendingRef.current.has(conversationId)) return;
    sendingRef.current.add(conversationId);
    setSending(current => ({ ...current, [conversationId]: true }));
    setSendErrors(current => ({ ...current, [conversationId]: "" }));
    try {
      const message = await post<StaffMessageView>(`${base}/conversations/${conversationId}/messages`, {
        text: draft.text.trim(), client_id: draft.clientId,
      });
      if (!alive.current) return;
      // Once the write has returned, a failed refresh must never offer to send it again.
      if (draftsRef.current[conversationId]?.clientId === draft.clientId) changeDraft(conversationId, "");
      setSentMessages(current => ({ ...current,
        [conversationId]: mergedMessages(current[conversationId] || [], [message]).slice(-100),
      }));
      setNotice("Message sent");
      notifyUpdated({ conversationId, refreshMessages: true });
    } catch (cause) {
      if (alive.current) setSendErrors(current => ({ ...current, [conversationId]: errorMessage(cause) }));
    } finally {
      sendingRef.current.delete(conversationId);
      if (alive.current) setSending(current => ({ ...current, [conversationId]: false }));
    }
  }
  async function action(run: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try { await run(); }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  async function directMessage(person: StaffPerson) {
    await action(async () => {
      const conversation = await post<StaffConversationView>(`${base}/conversations`, {
        kind: "direct", member_id: person.id,
      });
      if (!alive.current) return;
      rememberConversation(conversation); setSelectedId(conversation.id); setTab("messages");
      notifyUpdated();
    });
  }
  async function archiveConversation(conversation: StaffConversationView) {
    if (!window.confirm(`${conversation.archived ? "Restore" : "Archive"} ${conversation.name}? ${conversation.archived ? "Staff will be able to post again." : "Its message history will remain available."}`)) return;
    await action(async () => {
      const saved = await patch<StaffConversationView>(`${base}/conversations/${conversation.id}`, {
        archived: !conversation.archived, revision: conversation.revision,
      });
      if (!alive.current) return;
      rememberConversation(saved); setNotice(saved.archived ? "Channel archived" : "Channel restored"); notifyUpdated();
    });
  }
  async function acknowledge(announcement: StaffAnnouncementView) {
    await action(async () => {
      const saved = await post<StaffAnnouncementView>(`${base}/announcements/${announcement.id}/acknowledge`, {});
      if (!alive.current) return;
      rememberAnnouncement(saved); setNotice("Announcement acknowledged"); notifyUpdated();
    });
  }
  async function archiveAnnouncement(announcement: StaffAnnouncementView) {
    if (!window.confirm(`${announcement.archived ? "Restore" : "Archive"} this announcement?`)) return;
    await action(async () => {
      const saved = await patch<StaffAnnouncementView>(`${base}/announcements/${announcement.id}`, {
        archived: !announcement.archived, revision: announcement.revision,
      });
      if (!alive.current) return;
      rememberAnnouncement(saved); setNotice(saved.archived ? "Announcement archived" : "Announcement restored"); notifyUpdated();
    });
  }

  const selected = workspace?.conversations.find(conversation => conversation.id === selectedId);
  const conversations = workspace?.conversations.filter(conversation => showArchived || !conversation.archived) || [];
  const directory = workspace?.directory.filter(person => `${person.name} ${roleName(person.role)}`.toLowerCase().includes(directoryQuery.toLowerCase().trim())) || [];
  const announcements = (workspace?.announcements || []).filter(announcement =>
    (announcementArchived || !announcement.archived) &&
    `${announcement.title} ${announcement.body}`.toLowerCase().includes(announcementQuery.toLowerCase().trim()),
  ).sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.needs_acknowledgement) - Number(a.needs_acknowledgement) ||
    Number(b.priority === "Urgent") - Number(a.priority === "Urgent") || b.created_at.localeCompare(a.created_at));

  return <div className="staff-communication">
    <section className="staff-intro">
      <span className="staff-intro-icon"><MessageCircle size={25} /></span>
      <div><span className="eyebrow">KEEP YOUR TEAM CONNECTED</span><h2>A conversation away.</h2><p>Team channels, direct messages, and practice updates in one place.</p></div>
      <span className="staff-practice-scope"><UsersRound size={15} />Your practice team</span>
    </section>
    <div className="staff-toolbar">
      <div className="tabs staff-tabs" role="tablist" aria-label="Staff communication">
        <button role="tab" aria-selected={tab === "messages"} className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}><MessageCircle size={16} />Messages{Boolean(workspace?.unread_messages) && <span aria-hidden="true" className="staff-count">{workspace?.unread_messages}</span>}</button>
        <button role="tab" aria-selected={tab === "announcements"} className={tab === "announcements" ? "active" : ""} onClick={() => setTab("announcements")}><Megaphone size={16} />Announcements{Boolean(workspace?.unacknowledged_announcements) && <span aria-hidden="true" className="staff-count">{workspace?.unacknowledged_announcements}</span>}</button>
        <button role="tab" aria-selected={tab === "directory"} className={tab === "directory" ? "active" : ""} onClick={() => setTab("directory")}><UsersRound size={16} />Staff directory</button>
      </div>
      <button className="button secondary small" onClick={() => { void reload(); notifyUpdated({ conversationId: selectedId, refreshMessages: true }); }} disabled={loading}><RefreshCw size={14} />Refresh communication</button>
    </div>
    {error && <div className="staff-error" role="alert">{error}<button className="text-button" onClick={() => void reload()}>Retry loading communication</button></div>}
    {notice && <p className="staff-status" role="status"><Check size={15} />{notice}</p>}
    {loading && !workspace && <section className="panel staff-loading" role="status">Loading staff communication…</section>}
    {workspace && tab === "messages" && <div className="staff-message-layout" role="tabpanel" aria-label="Messages">
      <aside className="staff-conversation-sidebar">
        <div className="staff-conversation-list-heading"><h3>Conversations</h3>{workspace.can_manage && <button className="icon-button" aria-label="New channel" onClick={() => setModal("channel")}><Plus size={17} /></button>}</div>
        <label className="staff-mobile-picker">Open conversation<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setNotice(""); }}><option value="" disabled>Choose a conversation</option>{conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.kind === "channel" ? "# " : ""}{conversation.name}{conversation.unread_count ? ` (${conversation.unread_count} unread)` : ""}</option>)}</select></label>
        <nav className="staff-conversations" aria-label="Staff conversations">
          {(["channel", "direct"] as const).map(kind => <div key={kind}><p className="staff-list-label">{kind === "channel" ? "TEAM CHANNELS" : "DIRECT MESSAGES"}</p>{conversations.filter(conversation => conversation.kind === kind).map(conversation => <button key={conversation.id} aria-label={conversation.name} aria-current={selectedId === conversation.id ? "true" : undefined} className={selectedId === conversation.id ? "active" : ""} onClick={() => { setSelectedId(conversation.id); setNotice(""); }}><span className="staff-conversation-icon">{kind === "channel" ? <Hash size={17} /> : <MessageCircle size={17} />}</span><span className="staff-conversation-name"><strong>{conversation.name}</strong><small>{conversation.archived ? "Archived channel" : conversation.last_message?.text || (kind === "channel" ? "Start a team conversation" : "No messages yet")}</small></span>{conversation.unread_count > 0 && <span className="staff-count" aria-label={`${conversation.unread_count} unread messages`}>{conversation.unread_count > 99 ? "99+" : conversation.unread_count}</span>}</button>)}{kind === "direct" && !conversations.some(conversation => conversation.kind === "direct") && <p className="staff-list-empty">Find a teammate in the staff directory to start a conversation.</p>}</div>)}
        </nav>
        <button className="staff-directory-link" onClick={() => setTab("directory")}><UsersRound size={15} />Find a teammate</button>
        <label className="staff-checkbox"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived channels</label>
      </aside>
      {selected ? <Conversation key={`${selected.id}:${messageFocus.conversationId === selected.id ? messageFocus.messageId : ""}`} conversation={selected} user={user} canManage={workspace.can_manage}
        initialMessageId={messageFocus.conversationId === selected.id ? messageFocus.messageId : undefined}
        messageTasks={messageTasks} onCreateTask={(message, conversation) => setTaskSource({ message, conversation })} onViewTask={setTaskId}
        draft={drafts[selected.id]?.text || ""} onDraft={text => changeDraft(selected.id, text)}
        onSend={() => void sendMessage(selected.id)} sending={Boolean(sending[selected.id])}
        sendError={sendErrors[selected.id] || ""} confirmedMessages={sentMessages[selected.id] || []}
        onSynchronized={latest => setSentMessages(current => {
          const pending = current[selected.id];
          if (!pending?.some(message => message.sequence <= latest)) return current;
          return { ...current, [selected.id]: pending.filter(message => message.sequence > latest) };
        })}
        onArchive={() => void archiveConversation(selected)} actionBusy={busy} />
        : <section className="staff-conversation-empty"><MessageCircle size={32} /><h3>Choose a conversation</h3><p>Open a team channel or message someone from the staff directory.</p></section>}
    </div>}
    {workspace && tab === "announcements" && <section className="staff-announcements" role="tabpanel" aria-label="Announcements">
      <div className="staff-section-heading"><div><h2>Practice announcements</h2><p>Keep important updates visible and acknowledge the ones that need your attention.</p></div>{workspace.can_manage && <button className="button primary small" onClick={() => setModal("announcement")}><Plus size={15} />New announcement</button>}</div>
      <div className="staff-announcement-filters"><label className="staff-search"><Search size={16} /><input type="search" aria-label="Search announcements" placeholder="Search announcements" value={announcementQuery} onChange={event => setAnnouncementQuery(event.target.value)} /></label>{workspace.can_manage && <label className="staff-checkbox"><input type="checkbox" checked={announcementArchived} onChange={event => setAnnouncementArchived(event.target.checked)} />Show archived announcements</label>}</div>
      {!announcements.length && <div className="staff-empty-state"><Megaphone size={30} /><h3>{announcementQuery ? "No matching announcements" : "A clear place for important updates"}</h3><p>{announcementQuery ? "Try another search." : workspace.can_manage ? "Post your first practice announcement for the team." : "Practice announcements will appear here."}</p></div>}
      <div className="staff-announcement-list">{announcements.map(announcement => <article key={announcement.id} data-staff-announcement-id={announcement.id} className={`staff-announcement ${announcement.priority === "Urgent" ? "staff-announcement-urgent" : ""} ${announcement.id === initialAnnouncementId ? "staff-source-highlight" : ""}`} aria-label={`Announcement: ${announcement.title}`}>
        <div className="staff-announcement-top"><span className={`staff-priority ${announcement.priority.toLowerCase()}`}>{announcement.priority === "Urgent" ? "Urgent update" : "Practice update"}</span>{announcement.archived && <span className="staff-archived">Archived</span>}{announcement.needs_acknowledgement && !announcement.archived && <span className="staff-ack-needed">Acknowledgement needed</span>}</div>
        <h3>{announcement.title}</h3><p className="staff-announcement-byline">{announcement.author.name}<span>·</span><time dateTime={announcement.created_at}>{timestamp(announcement.created_at)} PT</time></p>
        <p className="staff-announcement-body">{announcement.body}</p>
        <div className="staff-announcement-actions"><div><span className="staff-ack-count"><CheckCheck size={16} />{announcement.requires_acknowledgement ? `${announcement.acknowledged_count} of ${announcement.recipient_count} staff acknowledged` : "Acknowledgement not requested"}</span>{announcement.acknowledged_at && <span className="staff-acknowledged"><Check size={14} />Acknowledged</span>}</div><div className="button-row">{announcement.needs_acknowledgement && !announcement.archived && <button className="button primary small" disabled={busy} onClick={() => void acknowledge(announcement)}>Acknowledge announcement</button>}{workspace.can_manage && <button className="button secondary small" disabled={busy} onClick={() => void archiveAnnouncement(announcement)}><Archive size={14} />{announcement.archived ? "Restore announcement" : "Archive announcement"}</button>}</div></div>
        {workspace.can_manage && announcement.requires_acknowledgement && announcement.acknowledgements && <details className="staff-receipts"><summary>View acknowledgements</summary><ul>{announcement.acknowledgements.map(receipt => <li key={receipt.member.id}><span>{receipt.member.name}{!receipt.member.is_active && <small>Inactive</small>}</span><span>{receipt.acknowledged_at ? `Acknowledged ${timestamp(receipt.acknowledged_at)} PT` : "Not yet acknowledged"}</span></li>)}</ul>{!announcement.acknowledgements.length && <p>No other staff were active when this announcement was posted.</p>}</details>}
      </article>)}</div>
    </section>}
    {workspace && tab === "directory" && <section role="tabpanel" aria-label="Staff directory" className="staff-directory">
      <div className="staff-section-heading"><div><h2>Your practice team</h2><p>Start a private conversation with an active teammate.</p></div><span className="staff-team-size">{workspace.directory.length} active staff</span></div>
      <label className="staff-search"><Search size={16} /><input type="search" aria-label="Search staff directory" placeholder="Search by name or role" value={directoryQuery} onChange={event => setDirectoryQuery(event.target.value)} /></label>
      <div className="staff-directory-grid">{directory.map(person => <article key={person.id} className="staff-person" aria-label={`Staff member: ${person.name}`}><span className={`staff-avatar ${person.role === "clinician" ? "clinical" : ""}`}>{initials(person.name)}</span><div><h3>{person.name}{person.id === user.id && <span> (you)</span>}</h3><p>{roleName(person.role)}</p></div>{person.id !== user.id && <button className="button secondary small" aria-label="Message staff member" disabled={busy} onClick={() => void directMessage(person)}><MessageCircle size={14} />Message</button>}</article>)}</div>
      {!directory.length && <div className="staff-empty-state"><UsersRound size={30} /><h3>No matching staff</h3><p>Try another name or role.</p></div>}
    </section>}
    {modal === "channel" && <ChannelComposer onClose={() => setModal(null)} onCreated={conversation => { rememberConversation(conversation); setSelectedId(conversation.id); setTab("messages"); setModal(null); setNotice("Channel created"); notifyUpdated(); }} />}
    {modal === "announcement" && <AnnouncementComposer onClose={() => setModal(null)} onCreated={announcement => { rememberAnnouncement(announcement); setModal(null); setTab("announcements"); setNotice("Announcement posted"); notifyUpdated(); }} />}
    {taskSource && <CreateMessageTaskDialog message={taskSource.message} conversation={taskSource.conversation} user={user} directory={workspace?.directory || []} onClose={() => setTaskSource(null)} onCreated={task => { rememberTask(task); setTaskSource(null); setNotice("Staff task created"); }} />}
    {taskId && <StaffTaskDialog key={taskId} taskId={taskId} onClose={() => setTaskId(null)} onChanged={rememberTask} onOpenConversation={openTaskConversation} />}
  </div>;
}

function Conversation({ conversation, user, canManage, draft, onDraft, onSend, sending, sendError, confirmedMessages, onSynchronized, onArchive, actionBusy, initialMessageId, messageTasks, onCreateTask, onViewTask }: {
  conversation: StaffConversationView; user: User; canManage: boolean;
  draft: string; onDraft: (text: string) => void; onSend: () => void; sending: boolean;
  sendError: string; confirmedMessages: StaffMessageView[]; onSynchronized: (latest: number) => void; onArchive: () => void; actionBusy: boolean;
  initialMessageId?: string;
  messageTasks: Record<string, StaffTaskSummary>;
  onCreateTask: (message: StaffMessageView, conversation: StaffConversationView) => void;
  onViewTask: (id: string) => void;
}) {
  const [messages, setMessages] = useState<StaffMessageView[]>([]);
  const messagesRef = useRef<StaffMessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [readUpTo, setReadUpTo] = useState(0);
  const [readRetry, setReadRetry] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [hasLatestGap, setHasLatestGap] = useState(false);
  const [details, setDetails] = useState(conversation);
  const [focusedMessageId, setFocusedMessageId] = useState(initialMessageId || "");
  const focusMessage = useRef(initialMessageId || "");
  const readCursor = useRef(0);
  const readPending = useRef(0);
  const active = useRef(true);
  const sequence = useRef(0);
  const fetching = useRef(false);
  const historyLoaded = useRef(false);
  const historyElement = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const latestGap = useRef(false);
  const scrollPlan = useRef<{ kind: "latest" | "top" | "preserve" | "focus"; height?: number; top?: number } | null>(null);
  const synchronized = useRef(onSynchronized);
  synchronized.current = onSynchronized;
  const { id } = conversation;

  const measureHistory = useCallback(() => {
    const element = historyElement.current;
    if (!element) return;
    const latestVisible = element.scrollHeight - element.scrollTop - element.clientHeight <= 16;
    nearBottom.current = latestVisible;
    setAtBottom(latestVisible);
    setReadRetry(value => value + 1);
  }, []);

  useEffect(() => setDetails(conversation), [conversation]);
  const load = useCallback(async (older = false, reset = false) => {
    if (fetching.current && !reset) return;
    const request = ++sequence.current;
    fetching.current = true; setLoading(true);
    const previousHeight = historyElement.current?.scrollHeight || 0;
    const previousTop = historyElement.current?.scrollTop || 0;
    const search = new URLSearchParams({ limit: "50" });
    if (query) search.set("q", query);
    if (older && messagesRef.current.length) search.set("before", String(messagesRef.current[0].sequence));
    else if (!query && focusMessage.current) search.set("focus", focusMessage.current);
    try {
      const page = await api<StaffMessagePage>(`${base}/conversations/${id}/messages?${search}`);
      if (!active.current || request !== sequence.current) return;
      setDetails(page.conversation);
      const previous = messagesRef.current;
      const hasGap = !query && previous.length > 0 && page.messages.length > 0 &&
        page.messages[0].sequence > previous[previous.length - 1].sequence + 1;
      // Leave older history in place if more than one page arrives while it is
      // being read. Only an explicit jump should replace that history.
      if (hasGap && !reset && (!nearBottom.current || latestGap.current)) {
        latestGap.current = true; setHasLatestGap(true); setError("");
        return;
      }
      if (reset || hasGap) { latestGap.current = false; setHasLatestGap(false); }
      if (!older && !query && focusMessage.current && page.has_later) {
        latestGap.current = true; setHasLatestGap(true);
      }
      const combined = reset || hasGap ? page.messages : mergedMessages(previous, page.messages);
      if (older) scrollPlan.current = { kind: "preserve", height: previousHeight, top: previousTop };
      else if (reset || hasGap) scrollPlan.current = { kind: query ? "top" : focusMessage.current ? "focus" : "latest" };
      else if (!query && nearBottom.current) scrollPlan.current = { kind: "latest" };
      messagesRef.current = combined; setMessages(combined);
      if (older) historyLoaded.current = true;
      if (reset || hasGap) historyLoaded.current = false;
      if (older || !historyLoaded.current) setHasMore(page.has_more);
      if (!older && !query) {
        setReadUpTo(page.latest_sequence);
        synchronized.current(page.latest_sequence);
      }
      setReadRetry(value => value + 1);
      setError("");
    } catch (cause) {
      if (active.current && request === sequence.current) setError(errorMessage(cause));
    } finally {
      if (active.current && request === sequence.current) { fetching.current = false; setLoading(false); }
    }
  }, [id, query]);
  useEffect(() => {
    active.current = true;
    messagesRef.current = []; setMessages([]); setReadUpTo(0); setHasMore(false);
    void load(false, true);
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      measureHistory();
      void load();
    };
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<UpdatedDetail>).detail;
      if (detail?.refreshMessages && (!detail.conversationId || detail.conversationId === id)) refresh();
    };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener(updatedEvent, updated);
    return () => {
      active.current = false; ++sequence.current; fetching.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener(updatedEvent, updated);
    };
  }, [id, load, measureHistory]);
  useEffect(() => {
    if (query || !readUpTo || readUpTo <= readCursor.current || readUpTo <= readPending.current ||
      !nearBottom.current || latestGap.current || document.visibilityState !== "visible" ||
      document.documentElement.hasAttribute("data-cevrali-session-checking")) return;
    readPending.current = readUpTo;
    void patch(`${base}/conversations/${id}/read`, { sequence: readUpTo }).then(() => {
      if (!active.current) return;
      readCursor.current = Math.max(readCursor.current, readUpTo);
      notifyUpdated();
    }).catch(() => { /* The next visible refresh can safely retry an unread cursor. */ })
      .finally(() => { if (readPending.current === readUpTo) readPending.current = 0; });
  }, [id, query, readUpTo, readRetry, atBottom]);
  const visibleMessages = useMemo(() => query ? messages : mergedMessages(messages,
    confirmedMessages.filter(message => message.sequence > (messages.at(-1)?.sequence || 0))),
  [query, messages, confirmedMessages]);
  useLayoutEffect(() => {
    const element = historyElement.current;
    const plan = scrollPlan.current;
    if (element && plan) {
      if (plan.kind === "focus") {
        const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
          .find(message => message.dataset.messageId === focusMessage.current);
        if (target) element.scrollTop = target.offsetTop - element.offsetTop - element.clientHeight / 3;
      } else if (plan.kind === "latest") element.scrollTop = element.scrollHeight;
      else if (plan.kind === "top") element.scrollTop = 0;
      else element.scrollTop = (plan.top || 0) + element.scrollHeight - (plan.height || 0);
      scrollPlan.current = null;
    } else if (element && !query && nearBottom.current && !latestGap.current)
      element.scrollTop = element.scrollHeight;
    const frame = window.requestAnimationFrame(measureHistory);
    return () => window.cancelAnimationFrame(frame);
  }, [visibleMessages, measureHistory, query]);
  return <section className="staff-conversation" aria-label={`Conversation: ${conversation.name}`}>
    <header className="staff-conversation-header"><span className="staff-conversation-heading-icon">{details.kind === "channel" ? <Hash size={23} /> : <MessageCircle size={23} />}</span><div><h2>{details.name}</h2><p>{details.kind === "direct" ? "Private conversation between two staff members" : details.description || "A shared space for your practice team"}</p></div>{canManage && details.kind === "channel" && details.id !== "staff-general" && <button className="icon-button" aria-label={details.archived ? "Restore channel" : "Archive channel"} title={details.archived ? "Restore channel" : "Archive channel"} disabled={actionBusy} onClick={onArchive}><Archive size={17} /></button>}</header>
    <form className="staff-conversation-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(searchDraft.trim()); }}><label><Search size={15} /><input type="search" aria-label="Search this conversation" placeholder="Search this conversation" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} maxLength={100} /></label><button className="button secondary small">Search messages</button>{query && <button type="button" className="text-button" onClick={() => { setSearchDraft(""); setQuery(""); }}>Clear search</button>}</form>
    {error && <div className="staff-error" role="alert">{error}<button className="text-button" onClick={() => void load()}>Retry loading messages</button></div>}
    <div ref={historyElement} className="staff-message-history" aria-label={query ? "Matching messages" : "Conversation messages"} onScroll={measureHistory}>
      {hasMore && <button className="staff-load-earlier" disabled={loading} onClick={() => void load(true)}>{loading ? "Loading messages…" : "Load earlier messages"}</button>}
      {query && <p className="staff-search-result-note">Search results for “{query}”</p>}
      {loading && !visibleMessages.length ? <p className="staff-history-loading" role="status">Loading messages…</p> : !visibleMessages.length && <div className="staff-empty-state"><MessageCircle size={30} /><h3>{query ? "No matching messages" : "Start the conversation"}</h3><p>{query ? "Try another search in this conversation." : details.can_post ? "Share an update or ask your team a question." : "There are no messages in this conversation."}</p></div>}
      {visibleMessages.map(message => {
        const task = messageTasks[message.id] || message.task;
        return <article className={`staff-message ${message.author.id === user.id ? "own" : ""} ${focusedMessageId === message.id ? "staff-source-highlight" : ""}`} key={message.id} data-message-id={message.id} data-message-sequence={message.sequence} aria-label={`Message from ${message.author.name}`}>
          <span className="staff-message-avatar">{initials(message.author.name)}</span>
          <div className="staff-message-content"><div className="staff-message-meta"><strong>{message.author.name}</strong><span>{roleName(message.author.role)}</span><time dateTime={message.created_at}>{timestamp(message.created_at)} PT</time></div><p>{message.text}</p>
            <div className="staff-message-task-actions">
              <button type="button" className="staff-message-task-button" disabled={!task && !details.can_post} onClick={() => task ? onViewTask(task.id) : onCreateTask(message, details)}><ClipboardCheck size={13} />{task ? "View task" : "Create task"}</button>
              {task && <span className="staff-message-task-state">{task.done ? "Completed" : `Assigned to ${task.owner_name}`}</span>}
            </div>
          </div>
        </article>;
      })}
    </div>
    {!query && (!atBottom || hasLatestGap || Boolean(focusedMessageId && error)) && <button className="staff-jump-latest" onClick={() => {
      focusMessage.current = ""; setFocusedMessageId("");
      latestGap.current = false; setHasLatestGap(false);
      const element = historyElement.current;
      if (element) element.scrollTop = element.scrollHeight;
      measureHistory();
      void load(false, true);
    }}>Jump to latest messages</button>}
    <form className="staff-message-composer" aria-label="Write a staff message" onSubmit={event => { event.preventDefault(); onSend(); }}>
      {!details.can_post && <p className="staff-read-only">{details.archived ? "This channel is archived. Its message history is still available." : "This conversation is read-only because a participant is inactive."}</p>}
      <label>Message<textarea value={draft} onChange={event => onDraft(event.target.value)} required maxLength={4000} rows={3} disabled={sending || !details.can_post} placeholder={details.can_post ? `Write to ${details.name}…` : "Posting is unavailable"} /></label>
      {sendError && <p className="form-error" role="alert">{sendError} Your draft is saved here; you can try sending again.</p>}
      <div className="staff-composer-footer"><span>{draft.length}/4,000<span className="staff-composer-scope"> · {details.kind === "channel" ? "Visible to your practice team" : "Visible to these two staff members"}</span></span><button className="button primary small" disabled={sending || !draft.trim() || !details.can_post}><Send size={14} />{sending ? "Sending…" : "Send message"}</button></div>
    </form>
  </section>;
}

function ChannelComposer({ onClose, onCreated }: { onClose: () => void; onCreated: (conversation: StaffConversationView) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const retry = useRef({ body: "", id: newClientId() });
  const close = () => { if (!pending.current && (!(name || description) || window.confirm("Discard this unsaved channel?"))) onClose(); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const input = { kind: "channel", name: name.trim(), description: description.trim() };
    const fingerprint = JSON.stringify(input);
    if (retry.current.body !== fingerprint) retry.current = { body: fingerprint, id: newClientId() };
    pending.current = true; setBusy(true); setError("");
    try { onCreated(await post<StaffConversationView>(`${base}/conversations`, { ...input, client_id: retry.current.id })); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal title="Create a channel" subtitle="Give your practice team a shared space for a topic." onClose={close}>
    <form className="staff-modal-form" onSubmit={submit}><fieldset disabled={busy}><label>Channel name<input value={name} onChange={event => setName(event.target.value)} required maxLength={60} placeholder="e.g. Front desk" /></label><label>Channel description<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={240} rows={3} placeholder="What should the team discuss here?" /></label></fieldset><p className="form-hint">All active staff in your practice can view and post in this channel.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create channel"}</button></div></form>
  </Modal>;
}

function AnnouncementComposer({ onClose, onCreated }: { onClose: () => void; onCreated: (announcement: StaffAnnouncementView) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<"Normal" | "Urgent">("Normal");
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const retry = useRef({ body: "", id: newClientId() });
  const close = () => { if (!pending.current && (!(title || body || priority !== "Normal" || !requiresAcknowledgement) || window.confirm("Discard this unsaved announcement?"))) onClose(); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const input = { title: title.trim(), body: body.trim(), priority, requires_acknowledgement: requiresAcknowledgement };
    const fingerprint = JSON.stringify(input);
    if (retry.current.body !== fingerprint) retry.current = { body: fingerprint, id: newClientId() };
    pending.current = true; setBusy(true); setError("");
    try { onCreated(await post<StaffAnnouncementView>(`${base}/announcements`, { ...input, client_id: retry.current.id })); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal title="Post an announcement" subtitle="Share an important update with your practice team." onClose={close}>
    <form className="staff-modal-form" onSubmit={submit}><fieldset disabled={busy}><label>Announcement title<input value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} /></label><label>Announcement message<textarea value={body} onChange={event => setBody(event.target.value)} required maxLength={4000} rows={5} /></label><label>Announcement priority<select value={priority} onChange={event => setPriority(event.target.value as "Normal" | "Urgent")}><option>Normal</option><option>Urgent</option></select></label><label className="staff-checkbox"><input type="checkbox" checked={requiresAcknowledgement} onChange={event => setRequiresAcknowledgement(event.target.checked)} />Require staff acknowledgement</label></fieldset><p className="form-hint">Acknowledgements are requested from the other staff active when you post. Urgent marks the update here; it does not send an emergency alert.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy || !title.trim() || !body.trim()}>{busy ? "Posting…" : "Post announcement"}</button></div></form>
  </Modal>;
}
