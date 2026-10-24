import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight, CalendarDays, Check, CheckCheck, ClipboardCheck, Clock3,
  FileCheck2, ListTodo, Megaphone, MessageCircle, RefreshCw, Search,
} from "lucide-react";
import { api, patch, post } from "./api";
import { formatClinicDate } from "./clinic-dates";
import { StaffTaskDialog } from "./staff-task-ui";
import type { User } from "./types";
import type { MyWorkDashboard } from "../server/my-work-model";
import type { StaffTaskView } from "../server/staff-task-model";
import "./my-work.css";

export type MyWorkDestination = "staff" | "inbox" | "orders" | "fax-inbox" | "authorizations";
type TaskFilter = "mine" | "assigned" | "completed";
type DueFilter = "all" | "overdue" | "today";
const failure = (cause: unknown) => cause instanceof Error ? cause.message : "Your work could not be loaded. Please try again.";
const workUpdated = () => {
  window.dispatchEvent(new Event("cevrali:work-updated"));
  window.dispatchEvent(new CustomEvent("cevrali:staff-updated"));
};
const dueLabel = (day: string, today: string) => !day ? "No due date" : day < today
  ? `Overdue · ${formatClinicDate(day)}` : day === today ? "Due today" : `Due ${formatClinicDate(day)}`;

export function MyWorkPage({ user, onNavigate, onOpenPatient }: {
  user: User;
  onNavigate: (destination: MyWorkDestination, sourceId?: string, messageId?: string) => void;
  onOpenPatient: (patientId: string) => void;
}) {
  const [data, setData] = useState<MyWorkDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("mine");
  const [due, setDue] = useState<DueFilter>("all");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const active = useRef(true);
  const requests = useRef(0);
  const pending = useRef(new Set<string>());
  const current = useRef<MyWorkDashboard | null>(null);
  const reload = useCallback(async () => {
    const request = ++requests.current;
    if (!current.current) setLoading(true);
    try {
      const next = await api<MyWorkDashboard>("/workflow/my-work");
      if (!active.current || request !== requests.current) return;
      current.current = next; setData(next); setError("");
    } catch (cause) {
      if (active.current && request === requests.current) setError(failure(cause));
    } finally {
      if (active.current && request === requests.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    const refresh = () => { if (document.visibilityState !== "hidden") void reload(); };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("cevrali:staff-updated", refresh);
    window.addEventListener("cevrali:work-updated", refresh);
    return () => {
      active.current = false; ++requests.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("cevrali:staff-updated", refresh);
      window.removeEventListener("cevrali:work-updated", refresh);
    };
  }, [reload]);

  async function action(key: string, operation: () => Promise<unknown>, message: string) {
    if (pending.current.has(key)) return;
    pending.current.add(key); setBusy([...pending.current]); setError(""); setNotice("");
    try {
      await operation();
      if (!active.current) return;
      ++requests.current;
      const previous = current.current;
      if (previous) {
        const completedCare = previous.care_tasks.find(task => task.id === key);
        const acknowledged = previous.announcements.some(announcement => announcement.id === key);
        const next = { ...previous,
          care_tasks: previous.care_tasks.filter(task => task.id !== key),
          announcements: previous.announcements.filter(announcement => announcement.id !== key),
          counts: { ...previous.counts,
            assigned_tasks: Math.max(0, previous.counts.assigned_tasks - Number(Boolean(completedCare))),
            overdue: Math.max(0, previous.counts.overdue - Number(Boolean(completedCare?.due_date && completedCare.due_date < previous.today))),
            due_today: Math.max(0, previous.counts.due_today - Number(completedCare?.due_date === previous.today)),
            announcements_to_acknowledge: Math.max(0, previous.counts.announcements_to_acknowledge - Number(acknowledged)),
          } };
        current.current = next; setData(next);
      }
      setNotice(message);
      workUpdated();
      await reload();
    } catch (cause) {
      if (active.current) setError(failure(cause));
    } finally {
      pending.current.delete(key);
      if (active.current) setBusy([...pending.current]);
    }
  }
  const changedTask = (task: StaffTaskView) => {
    ++requests.current;
    const previous = current.current;
    if (previous) {
      const next = { ...previous, staff_tasks: previous.staff_tasks.map(item => item.id === task.id ? task : item) };
      current.current = next; setData(next);
    }
    workUpdated();
    void reload();
  };
  const needle = query.toLowerCase().trim();
  const matches = (...values: (string | null | undefined)[]) => !needle || values.some(value => value?.toLowerCase().includes(needle));
  const tasks = useMemo(() => (data?.staff_tasks || []).filter(task => {
    const statusMatches = filter === "completed" ? Boolean(task.done) : !task.done &&
      (filter === "assigned" ? task.created_by === user.id : task.owner_id === user.id);
    const dueMatches = due === "all" || (due === "overdue" ? task.due_date < (data?.today || "") : task.due_date === data?.today);
    return statusMatches && dueMatches && (!needle || [task.title, task.owner.name, task.creator.name, task.conversation.name]
      .some(value => value.toLowerCase().includes(needle)));
  }).sort((a, b) => Number(b.priority === "High") - Number(a.priority === "High") ||
    a.due_date.localeCompare(b.due_date) || b.created_at.localeCompare(a.created_at)), [data, filter, due, needle, user.id]);
  const careTasks = data?.care_tasks.filter(task => matches(task.title, task.patient_name, task.category)) || [];
  const reviews = data?.reviews.filter(review => matches(review.title, review.patient_name, review.kind)) || [];
  const authorizations = data?.authorizations.filter(authorization => matches(authorization.patient_name, authorization.payer, authorization.status)) || [];
  const conversations = data?.conversations.filter(conversation => matches(conversation.name, conversation.last_message?.text)) || [];
  const announcements = data?.announcements.filter(announcement => matches(announcement.title, announcement.body)) || [];

  return <div className="my-work-page">
    <section className="my-work-intro">
      <span className="my-work-intro-icon"><ListTodo size={27} /></span>
      <div><span className="eyebrow">YOUR DAY, CONNECTED</span><h2>Your next steps, in one place.</h2><p>Follow through on team conversations and the work assigned to you.</p></div>
      {data && <span className="my-work-today"><CalendarDays size={15} />{formatClinicDate(data.today)}</span>}
    </section>
    {error && <div className="my-work-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void reload()}>Retry loading my work</button></div>}
    {notice && <p className="my-work-notice" role="status"><Check size={15} />{notice}</p>}
    {loading && !data && <section className="panel my-work-loading" role="status">Loading your work…</section>}
    {data && <>
      <div className="my-work-summary" aria-label="My work summary">
        <Summary label="Assigned tasks" count={data.counts.assigned_tasks} icon={ClipboardCheck} detail="Open follow-ups assigned to you" />
        <Summary label="Overdue work" count={data.counts.overdue} icon={Clock3} detail={`${data.counts.due_today} more due today`} urgent={data.counts.overdue > 0} />
        {data.clinical && <Summary label="Awaiting clinical review" count={data.counts.awaiting_review} icon={FileCheck2} detail="Results and outside documents" />}
        <Summary label="Unread staff items" count={data.counts.unread_messages + data.counts.announcements_to_acknowledge} icon={MessageCircle} detail={`${data.counts.unread_messages} messages · ${data.counts.announcements_to_acknowledge} announcements`} />
      </div>
      <div className="my-work-toolbar"><label className="my-work-search"><Search size={16} /><input type="search" aria-label="Search my work" placeholder="Search your work" value={query} onChange={event => setQuery(event.target.value)} /></label><button className="button secondary small" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} />Refresh my work</button></div>
      <div className="my-work-columns">
        <div className="my-work-main-column">
          <section className="my-work-section" aria-label="Staff follow-ups">
            <SectionHeading icon={ListTodo} title="Staff follow-ups" detail="A clear owner and deadline for every message follow-up." />
            <div className="my-work-task-controls">
              <div className="my-work-task-tabs" role="tablist" aria-label="Staff task filters">
                <button role="tab" aria-selected={filter === "mine"} onClick={() => setFilter("mine")}>Assigned to me</button>
                <button role="tab" aria-selected={filter === "assigned"} onClick={() => setFilter("assigned")}>Assigned by me</button>
                <button role="tab" aria-selected={filter === "completed"} onClick={() => setFilter("completed")}>Completed</button>
              </div>
              <label className="my-work-due-filter">Task due date<select value={due} onChange={event => setDue(event.target.value as DueFilter)}><option value="all">All dates</option><option value="overdue">Overdue</option><option value="today">Due today</option></select></label>
            </div>
            {!tasks.length && <EmptyWork icon={CheckCheck} title={filter === "completed" ? "No completed staff follow-ups" : "No matching staff follow-ups"} detail={filter === "assigned" ? "Create a task from a staff message to track its next step." : "Tasks assigned from staff conversations will appear here."} />}
            <div className="my-work-card-list">{tasks.map(task => <article key={task.id} className={`my-work-task-card ${task.done ? "is-complete" : ""}`} aria-label={`Staff task: ${task.title}`}>
              <div className="my-work-card-badges"><span className={`my-work-badge ${task.done ? "complete" : task.priority === "High" ? "high" : ""}`}>{task.done ? "Completed" : task.priority === "High" ? "High priority" : "Staff follow-up"}</span>{task.conversation.kind === "direct" && <span className="my-work-private">Private conversation</span>}</div>
              <h3>{task.title}</h3><p className="my-work-card-meta">Assigned to <strong>{task.owner.name}</strong><span>·</span>{task.conversation.name}</p>
              <div className="my-work-card-footer"><span className={`my-work-due ${!task.done && task.due_date < data.today ? "overdue" : ""}`}><CalendarDays size={13} />{dueLabel(task.due_date, data.today)}</span><button className="button secondary small" onClick={() => setTaskId(task.id)}>View task<ArrowUpRight size={13} /></button></div>
            </article>)}</div>
          </section>

          {data.clinical && <section className="my-work-section" aria-label="Clinical follow-ups">
            <SectionHeading icon={ClipboardCheck} title="Clinical follow-ups" detail="Your assigned care tasks, with their existing review requirements." />
            {!careTasks.length && <EmptyWork icon={CheckCheck} title="No matching clinical follow-ups" detail="Open care tasks assigned to you will appear here." />}
            <div className="my-work-card-list">{careTasks.map(task => <article key={task.id} className="my-work-task-card" aria-label={`Care task: ${task.title}`}><div className="my-work-card-badges"><span className={`my-work-badge ${task.priority === "High" ? "high" : ""}`}>{task.priority === "High" ? "High priority" : task.category}</span></div><h3>{task.title}</h3>{task.patient_id && <button className="my-work-patient" onClick={() => onOpenPatient(task.patient_id!)}>{task.patient_name || "Open patient chart"}</button>}<div className="my-work-card-footer"><span className={`my-work-due ${task.due_date && task.due_date < data.today ? "overdue" : ""}`}>{dueLabel(task.due_date, data.today)}</span><div className="button-row"><button className="button secondary small" onClick={() => onNavigate("inbox", task.id)}>Open care task</button>{task.can_complete && <button className="button primary small" disabled={busy.includes(task.id)} onClick={() => void action(task.id, () => patch(`/workflow/tasks/${task.id}`, { done: true }), "Care task completed")}><Check size={13} />{busy.includes(task.id) ? "Completing…" : "Complete care task"}</button>}</div></div></article>)}</div>
          </section>}
        </div>
        <div className="my-work-side-column">
          {data.clinical && <section className="my-work-section" aria-label="Results and documents awaiting review">
            <SectionHeading icon={FileCheck2} title="Awaiting clinical review" detail="Review the source before acknowledging a result or report." />
            {!reviews.length && <EmptyWork icon={CheckCheck} title="No matching reviews waiting" detail="Assigned results and filed outside documents awaiting your review appear here." />}
            <div className="my-work-card-list">{reviews.map(review => <article key={`${review.kind}:${review.id}`} className="my-work-task-card" aria-label={`Review: ${review.title}`}><div className="my-work-card-badges"><span className={`my-work-badge ${review.priority === "High" ? "high" : ""}`}>{review.priority === "High" ? "High priority" : review.kind === "result" ? "Lab result" : "Outside document"}</span></div><h3>{review.title}</h3><button className="my-work-patient" onClick={() => onOpenPatient(review.patient_id)}>{review.patient_name}</button><div className="my-work-card-footer"><span className={`my-work-due ${review.due_date && review.due_date < data.today ? "overdue" : ""}`}>{dueLabel(review.due_date, data.today)}</span><button className="button secondary small" onClick={() => onNavigate(review.destination, review.id)}>Review source<ArrowUpRight size={13} /></button></div></article>)}</div>
          </section>}

          <section className="my-work-section" aria-label="Authorization follow-ups">
            <SectionHeading icon={CalendarDays} title="Authorization follow-ups" detail="Requests you own that have reached their follow-up date." />
            {!authorizations.length && <EmptyWork icon={CheckCheck} title="No matching authorization follow-ups" detail="Due authorization requests assigned to you will appear here." />}
            <div className="my-work-card-list">{authorizations.map(authorization => <article key={authorization.id} className="my-work-task-card" aria-label={`Authorization follow-up: ${authorization.patient_name}`}><div className="my-work-card-badges"><span className="my-work-badge">{authorization.status}</span></div><h3>{authorization.patient_name}</h3><p className="my-work-card-meta">{authorization.payer}</p><div className="my-work-card-footer"><span className={`my-work-due ${authorization.overdue ? "overdue" : ""}`}>{dueLabel(authorization.due_date, data.today)}</span><button className="button secondary small" onClick={() => onNavigate("authorizations", authorization.id)}>Open authorization<ArrowUpRight size={13} /></button></div></article>)}</div>
          </section>

          <section className="my-work-section" aria-label="Unread staff messages">
            <SectionHeading icon={MessageCircle} title="Unread staff messages" detail="Open a conversation to catch up with your team." />
            {!conversations.length && <EmptyWork icon={CheckCheck} title="No matching unread conversations" detail="New messages in your team channels and private conversations appear here." />}
            <div className="my-work-card-list">{conversations.map(conversation => <article className="my-work-task-card" key={conversation.id} aria-label={`Unread conversation: ${conversation.name}`}><div className="my-work-card-badges"><span className="my-work-badge">{conversation.unread_count} unread</span>{conversation.kind === "direct" && <span className="my-work-private">Private</span>}</div><h3>{conversation.name}</h3>{conversation.last_message && <p className="my-work-message-preview">{conversation.last_message.text}</p>}<div className="my-work-card-footer"><span className="my-work-card-meta">{conversation.last_message?.author.name}</span><button className="button secondary small" onClick={() => onNavigate("staff", conversation.id)}>Open conversation<ArrowUpRight size={13} /></button></div></article>)}</div>
          </section>

          <section className="my-work-section" aria-label="Announcements to acknowledge">
            <SectionHeading icon={Megaphone} title="Announcements to acknowledge" detail="Acknowledge each update after reading it." />
            {!announcements.length && <EmptyWork icon={CheckCheck} title="No matching acknowledgements waiting" detail="Practice announcements that request your acknowledgement appear here." />}
            <div className="my-work-card-list">{announcements.map(announcement => <article className="my-work-task-card" key={announcement.id} aria-label={`Announcement acknowledgement: ${announcement.title}`}><div className="my-work-card-badges"><span className={`my-work-badge ${announcement.priority === "Urgent" ? "high" : ""}`}>{announcement.priority === "Urgent" ? "Urgent update" : "Practice update"}</span></div><h3>{announcement.title}</h3><p className="my-work-announcement-body">{announcement.body}</p><div className="my-work-card-footer"><button className="my-work-source-link" onClick={() => onNavigate("staff", `announcement:${announcement.id}`)}>Open announcement<ArrowUpRight size={12} /></button><button className="button primary small" disabled={busy.includes(announcement.id)} onClick={() => void action(announcement.id, () => post(`/workflow/staff/announcements/${announcement.id}/acknowledge`, {}), "Announcement acknowledged")}><Check size={13} />{busy.includes(announcement.id) ? "Acknowledging…" : "Acknowledge announcement"}</button></div></article>)}</div>
          </section>
        </div>
      </div>
    </>}
    {taskId && <StaffTaskDialog key={taskId} taskId={taskId} onClose={() => setTaskId(null)} onChanged={changedTask} onOpenConversation={(conversationId, messageId) => onNavigate("staff", conversationId, messageId)} />}
  </div>;
}

function Summary({ label, count, icon: Icon, detail, urgent = false }: {
  label: string; count: number; icon: typeof ListTodo; detail: string; urgent?: boolean;
}) {
  return <article className={`my-work-summary-card ${urgent ? "urgent" : ""}`} aria-label={label}><span className="my-work-summary-icon"><Icon size={20} /></span><div><span>{label}</span><strong>{count}</strong><small>{detail}</small></div></article>;
}

function SectionHeading({ icon: Icon, title, detail }: { icon: typeof ListTodo; title: string; detail: string }) {
  return <header className="my-work-section-heading"><span><Icon size={19} /></span><div><h2>{title}</h2><p>{detail}</p></div></header>;
}

function EmptyWork({ icon: Icon, title, detail }: { icon: typeof ListTodo; title: string; detail: string }) {
  return <div className="my-work-empty"><Icon size={25} /><h3>{title}</h3><p>{detail}</p></div>;
}
