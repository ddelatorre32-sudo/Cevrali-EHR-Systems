import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CheckCheck, ClipboardList, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { api, ApiError, patch, post } from "./api";
import { Modal } from "./components";
import { clinicDate, clinicTimestampLabel, formatClinicDate } from "./clinic-dates";
import type { User } from "./types";
import type { StaffConversationView, StaffMessageView, StaffPerson } from "../server/staff-communication-model";
import type { StaffTaskAssignment, StaffTaskView } from "../server/staff-task-model";
import "./staff-task.css";

const endpoint = "/workflow/staff-tasks";
const newClientId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
  Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join("");
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : "The request could not be completed. Please try again.";
const assignmentOf = (task: StaffTaskAssignment): StaffTaskAssignment => ({
  title: task.title, owner_id: task.owner_id, due_date: task.due_date, priority: task.priority,
});
const assignmentKeys = ["title", "owner_id", "due_date", "priority"] as const;
const changed = (left: StaffTaskAssignment, right: StaffTaskAssignment) =>
  assignmentKeys.some(key => left[key] !== right[key]);

function announceChange(task: StaffTaskView) {
  window.dispatchEvent(new CustomEvent("cevrali:work-updated", { detail: { taskId: task.id } }));
  window.dispatchEvent(new CustomEvent("cevrali:staff-updated", {
    detail: { conversationId: task.conversation_id, refreshMessages: true },
  }));
}

function AssignmentFields({ value, onChange, assignees, inactiveOwner }: {
  value: StaffTaskAssignment;
  onChange: (value: StaffTaskAssignment) => void;
  assignees: StaffPerson[];
  inactiveOwner?: StaffPerson;
}) {
  return <div className="staff-task-fields">
    <label className="staff-task-full">Task title
      <input value={value.title} onChange={event => onChange({ ...value, title: event.target.value })}
        required maxLength={200} />
    </label>
    <label>Assigned to
      <select value={value.owner_id} onChange={event => onChange({ ...value, owner_id: event.target.value })} required>
        {!value.owner_id && <option value="" disabled>Choose a staff member</option>}
        {inactiveOwner && !assignees.some(person => person.id === inactiveOwner.id) &&
          <option value={inactiveOwner.id} disabled>{inactiveOwner.name} (inactive)</option>}
        {assignees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
    </label>
    <label>Due date
      <input type="date" value={value.due_date} onChange={event => onChange({ ...value, due_date: event.target.value })} required />
    </label>
    <label>Priority
      <select value={value.priority} onChange={event => onChange({ ...value, priority: event.target.value as "High" | "Normal" })}>
        <option>Normal</option><option>High</option>
      </select>
    </label>
  </div>;
}

function SourceMessage({ message, conversationName }: {
  message: Omit<StaffMessageView, "task">;
  conversationName: string;
}) {
  return <section className="staff-task-source" aria-label="Original staff message">
    <div className="staff-task-source-heading"><ClipboardList size={16} /><strong>Original message</strong><span>{conversationName}</span></div>
    <p className="staff-task-source-author">{message.author.name}<time dateTime={message.created_at}>{clinicTimestampLabel(message.created_at)}</time></p>
    <blockquote>{message.text}</blockquote>
  </section>;
}

export function CreateMessageTaskDialog({ message, conversation, user, directory, onClose, onCreated }: {
  message: StaffMessageView;
  conversation: StaffConversationView;
  user: User;
  directory: StaffPerson[];
  onClose: () => void;
  onCreated: (task: StaffTaskView) => void | Promise<unknown>;
}) {
  const assignees = directory.filter(person => person.is_active &&
    (conversation.kind === "channel" || conversation.member_ids.includes(person.id)));
  const initial = useRef<StaffTaskAssignment>({
    title: message.text.trim().slice(0, 200),
    owner_id: assignees.some(person => person.id === user.id) ? user.id : assignees[0]?.id || "",
    due_date: clinicDate(), priority: "Normal",
  });
  const [draft, setDraft] = useState<StaffTaskAssignment>(initial.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<StaffTaskView | null>(null);
  const pending = useRef(false);
  const committed = useRef(false);
  const retry = useRef({ fingerprint: "", clientId: newClientId() });
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const dirty = changed(draft, initial.current);
  const close = () => {
    if (pending.current) return;
    if (!committed.current && dirty && !window.confirm("Discard these unsaved task details?")) return;
    onClose();
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || committed.current || !conversation.can_post || !assignees.length) return;
    const input = { ...draft, title: draft.title.trim(), conversation_id: conversation.id, message_id: message.id };
    const fingerprint = JSON.stringify(input);
    if (fingerprint !== retry.current.fingerprint)
      retry.current = { fingerprint, clientId: newClientId() };
    pending.current = true; setBusy(true); setError("");
    try {
      const saved = await post<StaffTaskView>(endpoint, { ...input, client_id: retry.current.clientId });
      committed.current = true;
      if (!active.current) return;
      setCreated(saved);
      announceChange(saved);
      try {
        await onCreated(saved);
      } catch {
        if (active.current) setError("The task was created, but the work list could not refresh. Close this dialog and refresh the list.");
      }
    } catch (cause) {
      if (active.current) setError(messageOf(cause));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <Modal title="Create task from message" subtitle="Give this follow-up an owner and a due date." onClose={close}>
    <form className="staff-task-dialog" onSubmit={submit}>
      <SourceMessage message={message} conversationName={conversation.name} />
      <fieldset disabled={busy || Boolean(created) || !conversation.can_post}>
        <AssignmentFields value={draft} onChange={setDraft} assignees={assignees} />
      </fieldset>
      <p className="staff-task-hint">{conversation.kind === "direct"
        ? "This task stays within this direct conversation and can only be assigned to its active participants."
        : "Staff who can access this channel can view the task. Assign it to an active member of your practice."}</p>
      {!conversation.can_post && <p className="form-error" role="alert">New tasks cannot be created from this read-only conversation.</p>}
      {!assignees.length && <p className="form-error" role="alert">No active staff member is available to receive this task.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {created && <p className="staff-task-success" role="status"><Check size={16} />Task created</p>}
      <div className="staff-task-actions">
        <button type="button" className="button secondary" onClick={close} disabled={busy}>{created ? "Close" : "Cancel"}</button>
        {!created && <button className="button primary" disabled={busy || !draft.title.trim() || !draft.owner_id || !conversation.can_post || !assignees.length}>
          <ClipboardList size={15} />{busy ? "Creating…" : "Create task"}
        </button>}
      </div>
    </form>
  </Modal>;
}

export function StaffTaskDialog({ taskId, onClose, onChanged, onOpenConversation }: {
  taskId: string;
  onClose: () => void;
  onChanged: (task: StaffTaskView) => void | Promise<unknown>;
  onOpenConversation?: (conversationId: string, messageId?: string) => void;
}) {
  const [task, setTask] = useState<StaffTaskView | null>(null);
  const taskRef = useRef<StaffTaskView | null>(null);
  const [draft, setDraft] = useState<StaffTaskAssignment | null>(null);
  const draftRef = useRef<StaffTaskAssignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const callbacks = useRef({ onChanged, onClose, onOpenConversation });
  callbacks.current = { onChanged, onClose, onOpenConversation };

  const rememberDraft = (next: StaffTaskAssignment) => {
    draftRef.current = next; setDraft(next); setNotice("");
  };
  const rememberTask = (next: StaffTaskView, preserveDraft: boolean) => {
    let nextDraft = assignmentOf(next);
    const previous = taskRef.current;
    const unsaved = draftRef.current;
    if (preserveDraft && previous && unsaved) {
      const baseline = assignmentOf(previous);
      nextDraft = {
        title: unsaved.title !== baseline.title ? unsaved.title : nextDraft.title,
        owner_id: unsaved.owner_id !== baseline.owner_id ? unsaved.owner_id : nextDraft.owner_id,
        due_date: unsaved.due_date !== baseline.due_date ? unsaved.due_date : nextDraft.due_date,
        priority: unsaved.priority !== baseline.priority ? unsaved.priority : nextDraft.priority,
      };
    }
    taskRef.current = next; setTask(next);
    draftRef.current = nextDraft; setDraft(nextDraft);
  };

  async function refresh(preserveDraft = true) {
    if (pending.current) return;
    const sequence = ++loadSequence.current;
    setLoading(true); setError("");
    try {
      const fresh = await api<StaffTaskView>(`${endpoint}/${taskId}`);
      if (!alive.current || sequence !== loadSequence.current) return;
      const hadDraft = Boolean(taskRef.current && draftRef.current && changed(draftRef.current, taskRef.current));
      rememberTask(fresh, preserveDraft);
      setStale(false);
      setNotice(hadDraft && preserveDraft
        ? "Task refreshed. Your unsaved changes are retained; review them before saving."
        : "");
    } catch (cause) {
      if (alive.current && sequence === loadSequence.current) setError(messageOf(cause));
    } finally {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    taskRef.current = null; draftRef.current = null;
    setTask(null); setDraft(null); setStale(false); setNotice("");
    void refresh(false);
    return () => { alive.current = false; ++loadSequence.current; };
  }, [taskId]);

  const dirty = Boolean(task && draft && changed(draft, task));
  const canLeave = () => !pending.current && (!dirty || window.confirm("Discard your unsaved task changes?"));
  const close = () => { if (canLeave()) callbacks.current.onClose(); };
  const openConversation = () => {
    if (!task || !callbacks.current.onOpenConversation || !canLeave()) return;
    const conversationId = task.conversation_id;
    const messageId = task.message_id;
    callbacks.current.onClose();
    callbacks.current.onOpenConversation(conversationId, messageId);
  };

  async function save(status?: boolean) {
    const current = taskRef.current;
    const edits = draftRef.current;
    if (!current || !edits || pending.current || loading || !current.can_edit || stale) return;
    const retainEditsOnReopen = status === false && Boolean(current.done) && changed(edits, current);
    if (status !== undefined && changed(edits, current) && !retainEditsOnReopen) return;
    const input = status === undefined
      ? { revision: current.revision, ...edits, title: edits.title.trim() }
      : { revision: current.revision, done: status };
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await patch<StaffTaskView>(`${endpoint}/${current.id}`, input);
      if (!alive.current) return;
      rememberTask(saved, retainEditsOnReopen);
      setStale(false);
      setNotice(status === undefined ? "Task changes saved" : status ? "Task completed" :
        retainEditsOnReopen ? "Task reopened. Your unsaved changes are retained." : "Task reopened");
      announceChange(saved);
      try {
        await callbacks.current.onChanged(saved);
      } catch {
        if (alive.current) setError("The task was saved, but the work list could not refresh. Refresh the list when the connection returns.");
      }
    } catch (cause) {
      if (!alive.current) return;
      setError(messageOf(cause));
      if (cause instanceof ApiError && cause.status === 409) setStale(true);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <Modal title="Staff task" subtitle="Track the follow-up without losing its original conversation." onClose={close}>
    <div className="staff-task-dialog">
      {loading && !task && <p className="staff-task-loading" role="status">Loading staff task…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="staff-task-success" role="status"><Check size={16} />{notice}</p>}
      <div className="staff-task-refresh-row">
        {task && <span role="status" aria-label="Task status" className={`staff-task-status ${task.done ? "completed" : "open"}`}>{task.done ? "Completed" : "Open"}</span>}
        <button className="button secondary small" type="button" disabled={busy || loading} onClick={() => void refresh(true)}>
          <RefreshCw size={14} />{loading ? "Refreshing…" : "Refresh task"}
        </button>
      </div>
      {stale && <p className="staff-task-conflict">Refresh the task before saving again. Your unsaved fields will be retained.</p>}
      {task && draft && <>
        <div className="staff-task-byline"><span>Created by {task.creator.name}</span><time dateTime={task.created_at}>{clinicTimestampLabel(task.created_at)}</time></div>
        <SourceMessage message={task.source_message} conversationName={task.conversation.name} />
        {onOpenConversation && <button className="staff-task-source-link" type="button" disabled={busy} onClick={openConversation}><ExternalLink size={14} />Open source conversation</button>}
        {task.done && <p className="staff-task-hint">This task is completed{task.completed_at ? ` (${clinicTimestampLabel(task.completed_at)})` : ""}. Reopen it before changing its assignment or details.</p>}
        {!task.can_edit && <p className="staff-task-hint">You can view this task. Its creator, assignee, or an administrator with access to this conversation can update it.</p>}
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy || loading || !task.can_edit || Boolean(task.done)}>
            <AssignmentFields value={draft} onChange={rememberDraft} assignees={task.allowed_assignees} inactiveOwner={task.owner} />
          </fieldset>
          {task.can_edit && <div className="staff-task-actions">
            {!task.done && <button className="button primary" disabled={busy || loading || stale || !dirty || !draft.title.trim()}>
              <Check size={15} />{busy ? "Saving…" : "Save task changes"}
            </button>}
            <button type="button" className="button secondary" disabled={busy || loading || stale || (dirty && !task.done)}
              onClick={() => void save(!task.done)}>
              {task.done ? <RotateCcw size={15} /> : <CheckCheck size={15} />}{task.done ? "Reopen task" : "Complete task"}
            </button>
          </div>}
          {dirty && <p className="staff-task-hint">{task.done
            ? "Reopen this task to continue editing your retained changes."
            : "Save your changes before completing this task."}</p>}
        </form>
        <details className="staff-task-history">
          <summary>Task history ({task.history.length})</summary>
          <ol>{task.history.map(entry => <li key={entry.revision}>
            <div><strong>{entry.action}</strong><time dateTime={entry.at}>{clinicTimestampLabel(entry.at)}</time></div>
            <p>{entry.actor_name} · {entry.after.priority} priority · Due {formatClinicDate(entry.after.due_date)}</p>
            <p>Assigned to {task.allowed_assignees.find(person => person.id === entry.after.owner_id)?.name ||
              (task.owner.id === entry.after.owner_id ? task.owner.name :
                task.creator.id === entry.after.owner_id ? task.creator.name : "Former staff member")}</p>
            <p>{entry.after.title}</p>
          </li>)}</ol>
        </details>
      </>}
    </div>
  </Modal>;
}
