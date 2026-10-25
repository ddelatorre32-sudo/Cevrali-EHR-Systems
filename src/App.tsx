import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { filterCalendarAppointments } from "./calendar-layout";
import { SessionPrivacyGuard } from "./session-privacy";
import { SettingsPage } from "./settings-ui";
import { defaultWorkspaceSettings, type WorkspaceSettings } from "../server/settings-model";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Clock3,
  FileCheck2,
  FileText,
  FlaskConical,
  Heart,
  Inbox,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  UsersRound,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  isStandalonePreview,
  patch,
  post,
  setPracticeContext,
} from "./api";
import { AccountPage, PracticeSignup, StaffJoin } from "./accounts-ui";
import { BillingAccountSelect } from "./patient-accounts-ui";
import {
  QueuePage,
  PatientIntakePortal,
  IntakePage,
  TaskBoard,
  RemindersPage,
  PatientQuickTools,
  CommandPalette,
} from "./workflow-ui";
import { OrderList, IntegrationsPage, MetricsPage } from "./order-tools";
import { InsurancePage, BillingPage } from "./finance-ui";
import { AuthorizationsPage } from "./authorizations-ui";
import { ScheduleManagement } from "./schedule-management";
import { TreatmentReconciliationPage } from "./treatment-ui";
import { ScheduleCalendar, type AppointmentPrefill } from "./schedule-calendar";
import { ReadinessPage, FaxInboxPage, FaxAlertButton } from "./operations-ui";
import { StaffCommunicationPage, StaffUnreadBadge } from "./staff-communication-ui";
import { MyWorkPage } from "./my-work-ui";
import { DigitalCheckInBadge, DigitalCheckInPage } from "./digital-checkin-ui";
import {
  age,
  AppointmentForm,
  AppointmentTable,
  Avatar,
  Badge,
  Empty,
  EncounterEditor,
  fullName,
  Modal,
  mrn,
  PatientChart,
  PatientForm,
  prettyDate,
  timeLabel,
} from "./components";
import type {
  Appointment,
  Audit,
  Encounter,
  Lab,
  Overview,
  Patient,
  Task,
  User,
} from "./types";

type Page =
  | "overview"
  | "patients"
  | "schedule"
  | "encounters"
  | "labs"
  | "inbox"
  | "queue"
  | "intake"
  | "digital-checkin"
  | "orders"
  | "reminders"
  | "metrics"
  | "integrations"
  | "insurance"
  | "billing"
  | "authorizations"
  | "account"
  | "settings"
  | "staff"
  | "my-work"
  | "readiness"
  | "treatments"
  | "fax-inbox"
  | "activity";
const pages: {
  id: Page;
  label: string;
  icon: typeof Activity;
  section?: string;
}[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    section: "WORKSPACE",
  },
  { id: "my-work", label: "My work", icon: ClipboardList },
  { id: "patients", label: "Patients", icon: UsersRound },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "readiness", label: "Pre-visit readiness", icon: CheckCheck },
  { id: "fax-inbox", label: "Fax inbox", icon: FileText },
  { id: "encounters", label: "Encounters", icon: FileText },
  { id: "queue", label: "Patient queue", icon: Activity },
  { id: "digital-checkin", label: "Digital check-in", icon: CheckCheck },
  { id: "inbox", label: "Care inbox", icon: Inbox, section: "CARE MANAGEMENT" },
  { id: "labs", label: "Lab results", icon: FlaskConical },
  { id: "intake", label: "Intake", icon: CheckCheck },
  { id: "orders", label: "Orders & referrals", icon: Stethoscope },
  { id: "reminders", label: "Reminders", icon: Bell },
  { id: "staff", label: "Staff communication", icon: MessageCircle, section: "YOUR TEAM" },
  {
    id: "insurance",
    label: "Insurance",
    icon: ShieldCheck,
    section: "REVENUE CYCLE",
  },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "treatments", label: "Treatment reconciliation", icon: CheckCheck },
  { id: "authorizations", label: "Authorizations", icon: FileCheck2 },
  { id: "metrics", label: "Practice metrics", icon: Activity },
  { id: "integrations", label: "Integrations", icon: Settings2 },
  { id: "activity", label: "Activity log", icon: ShieldCheck },
  { id: "account", label: "Account setup", icon: UsersRound },
  { id: "settings", label: "Settings", icon: Settings2, section: "WORKSPACE SETTINGS" },
];
const currentPage = () =>
  pages.some((p) => p.id === location.hash.slice(1).split("?")[0])
    ? (location.hash.slice(1).split("?")[0] as Page)
    : "overview";
const currentWorkSource = () => {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  return { sourceId: params.get("source") || undefined,
    conversationId: params.get("conversation") || undefined,
    messageId: params.get("message") || undefined,
    announcementId: params.get("announcement") || undefined };
};
const todayDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
    new Date(),
  );
const clinicHour = () =>
  Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date()),
  );
const demo = { email: "alex@cevrali.demo", password: "CevraliDemo2026!" };

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [signup, setSignup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(credentials: typeof demo) {
    setBusy(true);
    setError("");
    try {
      onLogin(await post<User>("/auth/login", credentials));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void login({
      email: String(f.get("email")),
      password: String(f.get("password")),
    });
  }
  return (
    <div className="login-layout">
      {signup && (
        <PracticeSignup
          onClose={() => setSignup(false)}
          onCreated={(u) => {
            location.hash = "account";
            onLogin(u);
          }}
        />
      )}
      <section className="login-story">
        <a href="#" className="brand">
          <span className="brand-icon">
            <Leaf size={26} />
          </span>
          <span>
            cevrali<span className="brand-period">.</span>
          </span>
        </a>
        <div className="login-story-content">
          <span className="eyebrow light">
            <span className="live-dot" />A LITTLE MORE HUMAN
          </span>
          <h1>
            Better days.
            <br />
            Connected care.
          </h1>
          <p>
            A thoughtful workspace that brings your patients, your practice, and
            your day together.
          </p>
          <div className="login-illustration">
            <div className="illustration-orbit orbit-one" />
            <div className="illustration-orbit orbit-two" />
            <div className="illustration-center">
              <Heart size={64} strokeWidth={1.2} />
            </div>
            <div className="floating-note">
              <span>
                <CheckCheck size={18} />
              </span>
              <div>
                <strong>Care, without the clutter.</strong>
                <small>Everything you need, in one place.</small>
              </div>
            </div>
          </div>
        </div>
        <p className="login-bottom">
          Thoughtfully built for the people who care.
        </p>
      </section>
      <main className="login-main">
        <div className="login-card">
          <span className="login-mark">
            <Stethoscope size={25} />
          </span>
          <p className="eyebrow">YOUR CLINICAL WORKSPACE</p>
          <h2>Welcome to Cevrali</h2>
          <p className="muted">
            A clear view of your day. A better way to care.
          </p>
          <button
            className="button primary demo-login"
            disabled={busy}
            onClick={() => login(demo)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ArrowRight size={17} />
            )}
            Open clinician demo
          </button>
          <div className="login-divider">
            <span>or sign in to your account</span>
          </div>
          <form onSubmit={submit}>
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@practice.com"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button secondary login-submit" disabled={busy}>
              Sign in
              <ArrowRight size={16} />
            </button>
          </form>
          <button
            className="button secondary login-submit"
            onClick={() => setSignup(true)}
          >
            Create practice account
          </button>
          <button
            className="text-button reception-login"
            disabled={busy}
            onClick={() => login({ ...demo, email: "frontdesk@cevrali.demo" })}
          >
            Explore the front desk demo
            <ArrowUpRight size={14} />
          </button>
          <div className="demo-notice">
            <ShieldCheck size={18} />
            <p>
              <strong>A safe space to explore</strong>
              <span>
                This starter uses synthetic patient data. Use the demo accounts
                to explore clinical and front desk workflows.
              </span>
            </p>
          </div>
        </div>
        <p className="login-footer">CEVRALI EHR · DEVELOPMENT WORKSPACE</p>
      </main>
    </div>
  );
}

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  if (hash.startsWith("#intake/"))
    return <PatientIntakePortal token={hash.slice("#intake/".length)} />;
  if (hash.startsWith("#join/"))
    return (
      <StaffJoin
        token={hash.slice("#join/".length)}
        onJoined={(u) => {
          setPracticeContext(u.practice?.id, u.id, u.role, Boolean(u.is_admin));
          location.hash = "account";
        }}
      />
    );
  return <WorkspaceApp />;
}

function WorkspaceApp() {
  const [user, setUser] = useState<User | null>(null);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>(defaultWorkspaceSettings);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [authAttempt, setAuthAttempt] = useState(0);
  const [page, setPage] = useState<Page>(currentPage);
  const [workSource, setWorkSource] = useState(currentWorkSource);
  const [mobileNav, setMobileNav] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [team, setTeam] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [labs, setLabs] = useState<Lab[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [day, setDay] = useState(todayDate);
  const [scheduleProvider, setScheduleProvider] = useState("all");
  const [appointmentPrefill, setAppointmentPrefill] =
    useState<AppointmentPrefill>({});
  const [query, setQuery] = useState("");
  const [globalQuery, setGlobalQuery] = useState("");
  const [filter, setFilter] = useState("All appointments");
  const [encounterFilter, setEncounterFilter] = useState("All notes");
  const [modal, setModal] = useState<
    "patient" | "new-patient" | "appointment" | "encounter" | "help" | null
  >(null);
  const [chart, setChart] = useState<Patient | null>(null);
  const [chartTab, setChartTab] = useState("Summary");
  const [editor, setEditor] = useState<Encounter | null>(null);
  const [encounterPatient, setEncounterPatient] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sessionVersion = useRef(0);
  const refreshSequence = useRef(0);
  const clinical = user?.role === "clinician";
  function sessionUser(next: User | null) {
    setPracticeContext(
      next?.practice?.id,
      next?.id,
      next?.role,
      next ? Boolean(next.is_admin) : undefined,
    );
    if (
      !next ||
      next.practice?.id !== user?.practice?.id ||
      next.id !== user?.id ||
      next.role !== user?.role ||
      Boolean(next.is_admin) !== Boolean(user?.is_admin)
    ) {
      sessionVersion.current++;
      setWorkspaceSettings(defaultWorkspaceSettings());
      setOverview(null);
      setPatients([]);
      setAppointments([]);
      setTeam([]);
      setEncounters([]);
      setTasks([]);
      setLabs([]);
      setAudit([]);
      setChart(null);
      setEditor(null);
      setModal(null);
      setCommandOpen(false);
      setQuery("");
      setGlobalQuery("");
      setToast("");
      setScheduleProvider("all");
      setAppointmentPrefill({});
    }
    setUser(next);
  }
  const navigate = (next: Page) => {
    location.hash = next;
    setWorkSource({ sourceId: undefined, conversationId: undefined, messageId: undefined, announcementId: undefined });
    setPage(next);
    setMobileNav(false);
  };
  useEffect(() => {
    const handler = () => { setPage(currentPage()); setWorkSource(currentWorkSource()); };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setAuthLoading(true);
    setAuthError("");
    api<User>("/auth/me", { signal: controller.signal })
      .then((current) => {
        if (active) sessionUser(current);
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) sessionUser(null);
        else
          setAuthError(
            controller.signal.aborted
              ? "Cevrali is taking longer than expected to respond. Please retry the connection."
              : "Your session could not be checked. Please retry the connection.",
          );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [authAttempt]);
  const settingsIdentity = user ? `${user.practice?.id}:${user.id}:${user.role}:${Boolean(user.is_admin)}` : "";
  useEffect(() => {
    if (!settingsIdentity) return;
    let active = true;
    api<WorkspaceSettings>("/workflow/user-settings").then((saved) => {
      if (!active) return;
      setWorkspaceSettings(saved);
      if (!location.hash || location.hash === "#") navigate(saved.start_page);
    }).catch(() => { /* Settings provides a visible retry if preferences are unavailable. */ });
    return () => { active = false; };
  }, [settingsIdentity]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (clinical) setCommandOpen(true);
        else searchRef.current?.focus();
      }
      if (e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setModal("patient");
      }
      if (e.altKey && e.key.toLowerCase() === "n" && clinical) {
        e.preventDefault();
        setEncounterPatient("");
        setModal("encounter");
      }
      if (e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        navigate("schedule");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clinical]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timeout);
  }, [toast]);
  const refresh = useCallback(
    async (selectedDay = day) => {
      if (!user) return;
      const version = sessionVersion.current;
      const request = ++refreshSequence.current;
      const values = await Promise.all([
        api<Overview>("/overview"),
        api<Patient[]>("/patients"),
        api<Appointment[]>(`/appointments?date=${selectedDay}`),
        clinical ? api<Encounter[]>("/encounters") : Promise.resolve([]),
        clinical ? api<Task[]>("/tasks") : Promise.resolve([]),
        clinical ? api<Lab[]>("/labs") : Promise.resolve([]),
        api<{ id: string; name: string; role: string }[]>("/workflow/team"),
      ]);
      if (
        version !== sessionVersion.current ||
        request !== refreshSequence.current
      )
        return;
      setOverview(values[0]);
      setPatients(values[1]);
      setAppointments(values[2]);
      setEncounters(values[3]);
      setTasks(values[4]);
      setLabs(values[5]);
      setTeam(values[6]);
    },
    [user, clinical, day],
  );
  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError("");
    refresh()
      .catch((e) => {
        setError(e.message);
        if (e.status === 401) sessionUser(null);
      })
      .finally(() => setLoading(false));
  }, [refresh, user]);
  useEffect(() => {
    if (page === "activity" && user && clinical)
      api<Audit[]>("/audit")
        .then(setAudit)
        .catch((e) => setError(e.message));
  }, [page, user, clinical]);
  useEffect(() => {
    if (
      user &&
      !clinical &&
      [
        "encounters",
        "labs",
        "inbox",
        "activity",
        "intake",
        "orders",
        "metrics",
        "integrations",
      ].includes(page)
    )
      navigate("overview");
  }, [user, clinical, page]);
  async function action(callback: () => Promise<void>, message?: string) {
    if (actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      await callback();
      if (message) setToast(message);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 401) sessionUser(null);
    } finally {
      setActionBusy(false);
    }
  }
  async function openChart(id: string) {
    await action(async () => {
      const patient = clinical
        ? await api<Patient>(`/patients/${id}`)
        : patients.find((p) => p.id === id);
      if (!patient)
        throw new Error(
          "Patient not found. Refresh the directory and try again.",
        );
      await patch("/workflow/preferences", { recent_patient: id });
      setChartTab(clinical ? "Summary" : "Insurance");
      setChart(patient);
    });
  }
  async function changeStatus(a: Appointment, status: string) {
    await action(async () => {
      await patch(`/appointments/${a.id}`, { status });
      await refresh();
    }, `Appointment ${status.toLowerCase()}`);
  }
  async function startVisit(a: Appointment) {
    await action(async () => {
      const result = await post<{ id: string }>("/encounters", {
        patient_id: a.patient_id,
        appointment_id: a.id,
        chief_complaint: a.reason,
      });
      if (a.status === "Checked in")
        await patch(`/appointments/${a.id}`, { status: "In progress" });
      const list = await api<Encounter[]>("/encounters");
      setEditor(list.find((e) => e.id === result.id) || null);
      await refresh();
    });
  }
  async function toggleTask(task: Task) {
    await action(
      async () => {
        await patch(`/tasks/${task.id}`, { done: !task.done });
        await refresh();
      },
      task.done ? "Task reopened" : "Task completed",
    );
  }
  async function logout() {
    await action(async () => {
      await post("/auth/logout", {});
      sessionUser(null);
      setOverview(null);
      setPatients([]);
      setAppointments([]);
      setEncounters([]);
      setTasks([]);
      setLabs([]);
      setAudit([]);
      setChart(null);
      setEditor(null);
      setModal(null);
      location.hash = "";
      setPage("overview");
      setMobileNav(false);
    });
  }
  async function createEncounter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const input = Object.fromEntries(f.entries());
    await action(async () => {
      if (!input.billing_account_id)
        throw new Error("Choose the account for this visit");
      const created = await post<{ id: string }>("/encounters", input);
      const list = await api<Encounter[]>("/encounters");
      setModal(null);
      setChart(null);
      setEditor(list.find((e) => e.id === created.id) || null);
      await refresh();
    });
  }
  function exportDirectory() {
    const safe = (s: string) =>
      `"${/^[=+@\-\t\r]/.test(s) ? "'" : ""}${s.replaceAll('"', '""')}"`;
    const csv = [
      "Patient ID,First name,Last name,Date of birth,Sex,Phone,Email",
      ...patients.map((p) =>
        [p.id, p.first_name, p.last_name, p.dob, p.sex, p.phone, p.email]
          .map(safe)
          .join(","),
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "cevrali-demo-patients.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("Demo patient directory exported");
  }
  const visiblePatients = patients.filter((p) =>
    `${fullName(p)} ${mrn(p.id)} ${p.phone}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const visibleAppointments = filterCalendarAppointments(
    appointments,
    page === "schedule" ? scheduleProvider : "all",
    filter,
  );
  const nextPatient =
    appointments.find((a) => a.status === "Checked in") ||
    appointments.find((a) => a.status === "Scheduled");
  const pendingTasks = tasks.filter((t) => !t.done);
  const activePage = pages.find((p) => p.id === page)!;
  const isToday = day === (overview?.today || todayDate());
  const tableProps = {
    onBillingChanged: () => refresh(),
    appointments: visibleAppointments,
    onChart: openChart,
    onStatus: changeStatus,
    onStart: startVisit,
    clinical,
  };
  if (authLoading)
    return (
      <div className="app-loading">
        <Leaf size={36} />
        <span>Preparing your workspace…</span>
      </div>
    );
  if (!user && authError)
    return (
      <main className="session-privacy-overlay">
        <section className="session-privacy-card">
          <Leaf size={32} />
          <h1>Unable to open Cevrali</h1>
          <p role="alert">{authError}</p>
          <button
            className="button primary"
            onClick={() => setAuthAttempt((attempt) => attempt + 1)}
          >
            Retry connection
          </button>
        </section>
      </main>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setError("");
          sessionUser(u);
        }}
      />
    );

  const taskList = (all = false) =>
    (all ? tasks : pendingTasks).map((t) => (
      <div className={`task-row ${t.done ? "task-done" : ""}`} key={t.id}>
        <button
          className="task-check"
          disabled={actionBusy}
          aria-label={`${t.done ? "Reopen" : "Complete"} ${t.title}`}
          onClick={() => toggleTask(t)}
        >
          {t.done ? <Check size={13} /> : null}
        </button>
        <div>
          <strong>{t.title}</strong>
          <button
            className="task-patient"
            onClick={() => openChart(t.patient_id)}
          >
            {fullName(t)}
          </button>
          <span className="task-meta">
            {t.category}
            {t.priority === "High" && (
              <span className="priority-dot">Priority</span>
            )}
          </span>
        </div>
        <ChevronRight size={15} className="muted" />
      </div>
    ));

  return (
    <div className="app-shell" data-density={workspaceSettings.density} data-reduced-motion={workspaceSettings.reduced_motion}>
      <SessionPrivacyGuard
        user={user}
        onUserChanged={sessionUser}
        onExpired={() => sessionUser(null)}
      />
      {mobileNav && (
        <div className="nav-scrim" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <a className="brand" href="#overview" aria-label="Cevrali home">
          <span className="brand-icon">
            <Leaf size={25} />
          </span>
          <span>
            cevrali<span className="brand-period">.</span>
          </span>
        </a>
        <div className="practice-selector">
          <span className="practice-icon">
            <Plus size={20} />
          </span>
          <div>
            <strong>{user.practice?.name || "Evergreen Medical"}</strong>
            <small>Outpatient practice</small>
          </div>
          <span className="practice-dot" />
        </div>
        <nav aria-label="Main navigation">
          {pages
            .filter(
              (p) =>
                clinical ||
                [
                  "overview",
                  "patients",
                  "schedule",
                  "readiness",
                  "fax-inbox",
                  "queue",
                  "digital-checkin",
                  "reminders",
                  "insurance",
                  "billing",
                  "treatments",
                  "authorizations",
                  "account",
                  "settings",
                  "staff",
                  "my-work",
                ].includes(p.id),
            )
            .map((p) => (
              <div key={p.id}>
                {p.section && <p className="nav-section">{p.section}</p>}
                <button
                  className={`nav-item ${page === p.id ? "active" : ""}`}
                  onClick={() => navigate(p.id)}
                >
                  <p.icon size={19} strokeWidth={1.65} />
                  <span>{p.label}</span>
                  {p.id === "staff" && <StaffUnreadBadge key={settingsIdentity} />}
                  {p.id === "digital-checkin" && <DigitalCheckInBadge key={settingsIdentity} />}
                  {p.id === "inbox" && pendingTasks.length > 0 && (
                    <em>{pendingTasks.length}</em>
                  )}
                  {p.id === "encounters" && (overview?.drafts || 0) > 0 && (
                    <span className="nav-dot" />
                  )}
                </button>
              </div>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <span className="workspace-note-icon">
              <Sparkles size={18} />
            </span>
            <strong>A little space to explore.</strong>
            <p>
              Real workflows.
              <br />
              Thoughtfully simulated data.
            </p>
            <button onClick={() => setModal("help")}>
              About this workspace
              <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="sidebar-help" onClick={() => setModal("help")}>
            <CircleHelp size={17} />
            Help & workspace details
          </button>
          <div className="profile">
            <span className="user-avatar">
              {user.name
                .replace(/^Dr\.\s*/, "")
                .split(" ")
                .map((n) => n[0])
                .slice(0, 2)
                .join("")}
              <i />
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>
                {user.is_admin
                  ? "Practice administrator"
                  : clinical
                    ? "Clinician"
                    : "Front desk coordinator"}
              </small>
            </div>
            <button aria-label="Sign out" title="Sign out" onClick={logout}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{activePage.label}</strong>
          </div>
          <form
            className="global-search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(globalQuery);
              navigate("patients");
            }}
          >
            <Search size={16} />
            <input
              ref={searchRef}
              value={globalQuery}
              onChange={(e) => setGlobalQuery(e.target.value)}
              placeholder="Search patients…"
              aria-label="Search all patients"
            />
            <button
              type="button"
              className="shortcut-hint"
              aria-label="Open command palette"
              onClick={() =>
                clinical ? setCommandOpen(true) : searchRef.current?.focus()
              }
            >
              ⌘ K
            </button>
          </form>
          <div className="topbar-actions">
            <button
              className="button primary new-patient-action"
              onClick={() => setModal("new-patient")}
            >
              <Plus size={16} />
              New patient
            </button>
            <span className="demo-tag">
              <span />
              {isStandalonePreview
                ? "Offline preview"
                : user.practice?.is_demo === false
                  ? "Practice account"
                  : "Demo workspace"}
            </span>
            {clinical && (
              <button
                className="notification-button icon-button"
                aria-label={`Care inbox, ${pendingTasks.length} pending tasks`}
                onClick={() => navigate("inbox")}
              >
                <Bell size={19} />
                {pendingTasks.length > 0 && <i />}
              </button>
            )}
            <FaxAlertButton onOpen={() => navigate("fax-inbox")} />
            <button
              className="icon-button staff-communication-shortcut"
              aria-label="Open staff communication"
              onClick={() => navigate("staff")}
            >
              <MessageCircle size={19} />
            </button>
            <button
              className="icon-button"
              aria-label="Open settings"
              onClick={() => navigate("settings")}
            >
              <Settings2 size={19} />
            </button>
          </div>
        </header>
        <main className="main-content" aria-busy={loading || actionBusy}>
          {user.is_admin &&
            user.practice?.is_demo === false &&
            !user.practice.setup_completed_at &&
            page !== "account" && (
              <div className="account-setup-banner">
                <div>
                  <strong>Welcome to your new practice workspace</strong>
                  <p>Confirm your practice details and invite your team.</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => navigate("account")}
                >
                  Finish account setup
                </button>
              </div>
            )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  void action(refresh);
                }}
              >
                Retry
              </button>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {page === "overview" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    YOUR DAY, AT A GLANCE <span className="eyebrow-line" />
                  </div>
                  <h1>
                    Good{" "}
                    {clinicHour() < 12
                      ? "morning"
                      : clinicHour() < 17
                        ? "afternoon"
                        : "evening"}
                    ,{" "}
                    {user.practice?.is_demo === false
                      ? user.name.replace(/^Dr\.\s*/, "").split(" ")[0]
                      : clinical
                        ? "Dr. Morgan"
                        : "Jamie"}
                    <span className="greeting-dot">.</span>
                  </h1>
                  <p>Here’s what’s happening at your practice today.</p>
                </div>
                <button
                  className="button date-button"
                  onClick={() => {
                    setDay(todayDate());
                    navigate("schedule");
                  }}
                >
                  <CalendarDays size={16} />
                  {prettyDate(todayDate(), {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                  <ChevronRight size={15} />
                </button>
              </div>
              <section className="welcome-banner">
                <div className="welcome-copy">
                  <span className="banner-eyebrow">
                    <span className="live-dot" />
                    EVERY PATIENT. EVERY DETAIL.
                  </span>
                  <h2>
                    More connected.
                    <br />
                    <span>More time to care.</span>
                  </h2>
                  <p>
                    Your patients, your schedule, and your next steps.
                    <br className="desktop-break" /> All in a day’s good work.
                  </p>
                  <button
                    className="banner-link"
                    onClick={() => {
                      setDay(todayDate());
                      navigate("schedule");
                    }}
                  >
                    Take a look at your day
                    <ArrowRight size={16} />
                  </button>
                </div>
                <div className="banner-art" aria-hidden="true">
                  <div className="banner-orbit" />
                  <div className="banner-orbit second" />
                  <svg viewBox="0 0 250 260" className="botanical">
                    <path d="M124 260C145 177 137 90 185 5" />
                    <path d="M141 180C93 186 51 167 44 110c55 0 87 20 97 70Z" />
                    <path d="M140 137c41-5 70-31 70-74-45 6-65 28-70 74Z" />
                    <path d="M160 83c-38-6-56-31-50-66 36 6 54 29 50 66Z" />
                    <path d="M157 226c48 1 74-24 80-60-45-2-72 18-80 60Z" />
                    <path d="m141 180-65-46m66 3 43-46m-25-8-35-46m32 189 55-40" />
                  </svg>
                </div>
                {nextPatient && (
                  <button
                    className="next-patient"
                    onClick={() =>
                      clinical
                        ? openChart(nextPatient.patient_id)
                        : navigate("schedule")
                    }
                  >
                    <span className="next-patient-label">
                      <span className="live-dot" />
                      NEXT UP IN YOUR DAY
                    </span>
                    <div>
                      <Avatar person={nextPatient} />
                      <span>
                        <strong>{fullName(nextPatient)}</strong>
                        <small>{nextPatient.type}</small>
                      </span>
                      <ArrowUpRight size={18} />
                    </div>
                    <footer>
                      <Clock3 size={13} />
                      {timeLabel(nextPatient.time)}
                      <span>·</span>
                      <span>{nextPatient.status}</span>
                    </footer>
                  </button>
                )}
              </section>
              <section className="stats-grid" aria-label="Practice statistics">
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Today’s appointments</span>
                    <span className="stat-icon green">
                      <CalendarDays size={18} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {overview?.appointments ?? "—"}
                    <span className="stat-label">visits</span>
                  </div>
                  <div className="stat-bottom">
                    <span className="mini-progress">
                      <i
                        style={{
                          width: `${overview?.appointments ? (overview.completed / overview.appointments) * 100 : 0}%`,
                        }}
                      />
                    </span>
                    {overview?.completed ?? 0} completed
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Patients checked in</span>
                    <span className="stat-icon gold">
                      <UsersRound size={18} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {overview?.waiting ?? "—"}
                    <span className="stat-label">waiting</span>
                  </div>
                  <div className="stat-bottom">
                    <span className="status-dot gold-dot" />
                    Ready for their next step
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>
                      {clinical ? "Unsigned notes" : "Completed visits"}
                    </span>
                    <span className="stat-icon lilac">
                      <FileText size={18} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {clinical
                      ? (overview?.drafts ?? "—")
                      : (overview?.completed ?? "—")}
                    <span className="stat-label">
                      {clinical ? "drafts" : "visits"}
                    </span>
                  </div>
                  <button
                    className="stat-bottom stat-link"
                    onClick={() =>
                      navigate(clinical ? "encounters" : "schedule")
                    }
                  >
                    {clinical
                      ? "Finish your documentation"
                      : "View the schedule"}
                    <ArrowUpRight size={13} />
                  </button>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Total patients</span>
                    <span className="stat-icon peach">
                      <Heart size={18} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {overview?.patients ?? "—"}
                    <span className="stat-label">in your care</span>
                  </div>
                  <button
                    className="stat-bottom stat-link"
                    onClick={() => navigate("patients")}
                  >
                    Every record, connected
                    <ArrowUpRight size={13} />
                  </button>
                </div>
              </section>
              <div className="dashboard-grid">
                <section className="panel schedule-panel">
                  <div className="panel-heading">
                    <div className="section-title">
                      <h2>
                        {isToday
                          ? "Today’s"
                          : prettyDate(day, {
                              month: "short",
                              day: "numeric",
                            })}{" "}
                        appointments
                      </h2>
                      <span className="count-chip">{appointments.length}</span>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("schedule")}
                    >
                      View schedule
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  <div className="panel-toolbar">
                    <div className="tabs">
                      {[
                        "All appointments",
                        "Upcoming",
                        "Completed",
                        "No-shows",
                      ].map((f) => (
                        <button
                          key={f}
                          className={filter === f ? "active" : ""}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <button
                      className="small-add"
                      aria-label="Schedule appointment"
                      onClick={() => setModal("appointment")}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  <AppointmentTable {...tableProps} limit={5} />
                  <div className="panel-bottom">
                    <span>
                      Showing {Math.min(5, visibleAppointments.length)} of{" "}
                      {visibleAppointments.length} appointments
                    </span>
                    <button
                      className="text-button"
                      onClick={() => navigate("schedule")}
                    >
                      All appointments
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
                <section className="panel tasks-panel">
                  <div className="panel-heading">
                    <div className="section-title">
                      <span className="task-heading-icon">
                        <Inbox size={17} />
                      </span>
                      <h2>{clinical ? "Your care inbox" : "Practice notes"}</h2>
                      {clinical && (
                        <span className="count-chip warm">
                          {pendingTasks.length}
                        </span>
                      )}
                    </div>
                  </div>
                  {clinical ? (
                    <>
                      <div className="inbox-intro">
                        Small steps. Better continuity of care.
                      </div>
                      {pendingTasks.length ? (
                        taskList()
                      ) : (
                        <Empty
                          icon={CheckCheck}
                          title="All caught up"
                          description="Your care inbox is clear."
                        />
                      )}
                      <button
                        className="inbox-footer"
                        onClick={() => navigate("inbox")}
                      >
                        Open care inbox
                        <ArrowRight size={15} />
                      </button>
                    </>
                  ) : (
                    <div className="reception-note">
                      <CalendarDays size={28} />
                      <h3>A smooth start to every visit.</h3>
                      <p>
                        Register patients, book appointments, and check patients
                        in from your workspace.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => setModal("patient")}
                      >
                        Register a patient
                        <Plus size={15} />
                      </button>
                    </div>
                  )}
                </section>
              </div>
              <div className="bottom-grid">
                <section className="panel day-flow">
                  <div className="panel-heading">
                    <h2>A pulse on your day</h2>
                    <span className="subtle-label">
                      {isToday
                        ? "Today"
                        : prettyDate(day, { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <div className="flow-content">
                    <div
                      className="flow-ring"
                      style={{
                        background: `conic-gradient(#527966 0% ${appointments.length ? (appointments.filter((a) => a.status === "Completed").length / appointments.length) * 100 : 0}%, #e9ede7 0%)`,
                      }}
                    >
                      <div>
                        <strong>
                          {
                            appointments.filter((a) => a.status === "Completed")
                              .length
                          }
                          <span>/{appointments.length}</span>
                        </strong>
                        <small>visits completed</small>
                      </div>
                    </div>
                    <div className="flow-legend">
                      {[
                        ["Completed", "flow-green"],
                        ["In progress", "flow-blue"],
                        ["Checked in", "flow-gold"],
                        ["Scheduled", "flow-gray"],
                      ].map(([status, color]) => (
                        <div key={status}>
                          <span className={`status-dot ${color}`} />
                          <span>{status}</span>
                          <strong>
                            {
                              appointments.filter((a) => a.status === status)
                                .length
                            }
                          </strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
                <section className="care-card">
                  <span className="care-card-icon">
                    <Leaf size={23} />
                  </span>
                  <div>
                    <p className="eyebrow">CARE STARTS WITH CONNECTION</p>
                    <h2>
                      A familiar face.
                      <br />A fuller picture.
                    </h2>
                    <p>
                      Keep every patient’s story close,
                      <br />
                      from the first visit to the next chapter.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => navigate("patients")}
                    >
                      Explore your patient directory
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="care-decoration" aria-hidden="true">
                    <Heart size={112} strokeWidth={0.7} />
                  </div>
                </section>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {user.practice?.name || "Evergreen Medical"}{" "}
                    <span className="eyebrow-line" />
                  </div>
                  <h1>
                    {activePage.label}
                    <span className="greeting-dot">.</span>
                  </h1>
                  <p>
                    {
                      {
                        patients:
                          "Every patient’s story, connected in one place.",
                        schedule:
                          "A little structure for a day of meaningful care.",
                        readiness: "Resolve missing details before the visit.",
                        "fax-inbox":
                          "Receive, match and file outside documents with staff alerts.",
                        encounters:
                          "Thoughtful documentation. Clear continuity of care.",
                        labs: "A closer look at the details that matter.",
                        inbox: "Keep the next steps in patient care moving.",
                        activity: "A transparent record of workspace activity.",
                        overview: "",
                        queue:
                          "Know who is waiting, ready, and taking the next step.",
                        intake:
                          "Review patient-reported updates before the visit.",
                        orders:
                          "Connect the clinical plan to orders and result review.",
                        reminders: "Keep confirmations and follow-ups moving.",
                        insurance:
                          "Check coverage and resolve eligibility questions before the visit.",
                        treatments:
                          "Reconcile actual treatment with approvals and billing.",
                        billing:
                          "Manage charges, demo claims, payments, and patient balances.",
                        authorizations:
                          "Track approvals, remaining visits, and upcoming expiration dates.",
                        metrics:
                          "Find bottlenecks using recorded workflow data.",
                        integrations:
                          "Prepare service connections with clear delivery status.",
                        account:
                          "Set up your organization, invite your team, and manage account access.",
                        settings:
                          "Manage practice controls, personal preferences, and reusable note templates.",
                        staff:
                          "Keep your team connected with conversations and practice announcements.",
                        "my-work":
                          "Your assignments, reviews, and follow-ups in one place.",
                        "digital-checkin":
                          "Review registration details, insurance cards, and signed consent forms.",
                      }[page]
                    }
                  </p>
                </div>
                <div className="button-row">
                  {page === "patients" && (
                    <>
                      <button
                        className="button secondary"
                        onClick={exportDirectory}
                      >
                        <ArrowDownToLine size={16} />
                        Export
                      </button>
                      <button
                        className="button primary"
                        onClick={() => setModal("patient")}
                      >
                        <Plus size={16} />
                        Register patient
                      </button>
                    </>
                  )}
                  {page === "schedule" && (
                    <>
                      <button
                        className="button secondary"
                        onClick={() => {
                          setAppointmentPrefill({
                            register_patient: true,
                            provider_id:
                              scheduleProvider === "all"
                                ? undefined
                                : scheduleProvider,
                          });
                          setModal("appointment");
                        }}
                      >
                        <Plus size={16} />
                        Register & schedule
                      </button>
                      <button
                        className="button primary"
                        onClick={() => {
                          setAppointmentPrefill({
                            provider_id:
                              scheduleProvider === "all"
                                ? undefined
                                : scheduleProvider,
                          });
                          setModal("appointment");
                        }}
                      >
                        <Plus size={16} />
                        New appointment
                      </button>
                    </>
                  )}
                  {page === "encounters" && (
                    <button
                      className="button primary"
                      onClick={() => {
                        setEncounterPatient("");
                        setModal("encounter");
                      }}
                    >
                      <Plus size={16} />
                      New encounter
                    </button>
                  )}
                  {page === "activity" && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        action(async () =>
                          setAudit(await api<Audit[]>("/audit")),
                        )
                      }
                    >
                      Refresh activity
                    </button>
                  )}
                </div>
              </div>
              {page === "patients" && (
                <section className="panel">
                  {clinical && (
                    <PatientQuickTools
                      patients={patients}
                      query={query}
                      onQuery={setQuery}
                      onChart={openChart}
                    />
                  )}
                  <div className="directory-toolbar">
                    <div className="section-title">
                      <h2>Patient directory</h2>
                      <span className="count-chip">{patients.length}</span>
                    </div>
                    <div className="input-search">
                      <Search size={16} />
                      <input
                        placeholder="Search name, ID, or phone…"
                        aria-label="Filter patient directory"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          className="icon-button"
                          aria-label="Clear patient search"
                          onClick={() => setQuery("")}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {visiblePatients.length ? (
                    <div className="table-scroll">
                      <table className="patient-table">
                        <thead>
                          <tr>
                            <th>Patient</th>
                            <th>Patient ID</th>
                            <th>Date of birth</th>
                            <th>Contact</th>
                            <th>Record</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visiblePatients.map((p) => (
                            <tr key={p.id}>
                              <td>
                                <button
                                  className="person-cell"
                                  disabled={!clinical}
                                  onClick={() => openChart(p.id)}
                                >
                                  <Avatar person={p} />
                                  <span>
                                    <strong>{fullName(p)}</strong>
                                    <small>
                                      {age(p.dob)} years · {p.sex}
                                    </small>
                                  </span>
                                </button>
                              </td>
                              <td className="mono">{mrn(p.id)}</td>
                              <td>{prettyDate(p.dob)}</td>
                              <td>
                                <div>{p.phone}</div>
                                <small className="muted">{p.email}</small>
                              </td>
                              <td>
                                {clinical ? (
                                  <button
                                    className="text-button"
                                    onClick={() => openChart(p.id)}
                                  >
                                    Open chart
                                    <ArrowUpRight size={14} />
                                  </button>
                                ) : (
                                  <button
                                    className="text-button"
                                    onClick={() => openChart(p.id)}
                                  >
                                    Insurance & billing
                                    <ArrowUpRight size={14} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      icon={UsersRound}
                      title="No patients found"
                      description="Try a different name, patient ID, or phone number."
                    />
                  )}
                  <div className="panel-bottom">
                    <span>
                      {visiblePatients.length} patient
                      {visiblePatients.length === 1 ? "" : "s"} in this view
                    </span>
                    <span>Synthetic demo records</span>
                  </div>
                </section>
              )}
              {page === "schedule" && (
                <section className="panel">
                  <ScheduleCalendar
                    defaultView={workspaceSettings.calendar_view}
                    day={day}
                    onDayChange={setDay}
                    providerId={scheduleProvider}
                    onProviderChange={setScheduleProvider}
                    appointments={appointments}
                    filter={filter}
                    clinical={clinical}
                    onSessionExpired={() => sessionUser(null)}
                    onChart={openChart}
                    onStatus={changeStatus}
                    onStart={startVisit}
                    onChanged={() => refresh()}
                    onCreate={(date, prefill) => {
                      setDay(date);
                      setAppointmentPrefill(prefill);
                      setModal("appointment");
                    }}
                  />
                  <div className="panel-toolbar">
                    <div className="tabs">
                      {[
                        "All appointments",
                        "Upcoming",
                        "Completed",
                        "No-shows",
                      ].map((f) => (
                        <button
                          className={filter === f ? "active" : ""}
                          onClick={() => setFilter(f)}
                          key={f}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <span className="subtle-label">
                      {visibleAppointments.length} appointments
                    </span>
                  </div>
                  <AppointmentTable {...tableProps} />
                  <div className="appointment-actions">
                    {visibleAppointments
                      .filter((a) => a.status === "In progress" && clinical)
                      .map((a) => (
                        <button
                          className="button secondary small"
                          key={a.id}
                          onClick={() => changeStatus(a, "Completed")}
                          disabled={actionBusy}
                        >
                          <CheckCheck size={15} />
                          Complete {fullName(a)}’s visit
                        </button>
                      ))}
                    {visibleAppointments
                      .filter((a) =>
                        ["Scheduled", "Checked in"].includes(a.status),
                      )
                      .map((a) => (
                        <button
                          className="text-button cancel-link"
                          key={a.id}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Cancel ${fullName(a)}’s appointment at ${timeLabel(a.time)}?`,
                              )
                            )
                              void changeStatus(a, "Cancelled");
                          }}
                        >
                          Cancel {fullName(a)} · {timeLabel(a.time)}
                        </button>
                      ))}
                  </div>
                  <ScheduleManagement
                    patients={patients}
                    providers={team.filter((u) => u.role === "clinician")}
                    onChange={() => refresh()}
                  />
                </section>
              )}
              {page === "treatments" && <TreatmentReconciliationPage />}
              {page === "encounters" && (
                <section className="panel">
                  <div className="panel-toolbar">
                    <div className="tabs">
                      {["All notes", "Draft", "Signed"].map((f) => (
                        <button
                          className={encounterFilter === f ? "active" : ""}
                          key={f}
                          onClick={() => setEncounterFilter(f)}
                        >
                          {f}
                          {f === "Draft" && (
                            <span className="tab-count">
                              {
                                encounters.filter((e) => e.status === "Draft")
                                  .length
                              }
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <span className="subtle-label">SOAP documentation</span>
                  </div>
                  {encounters.filter(
                    (e) =>
                      encounterFilter === "All notes" ||
                      e.status === encounterFilter,
                  ).length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Patient</th>
                            <th>Encounter</th>
                            <th>Date</th>
                            <th>Status</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {encounters
                            .filter(
                              (e) =>
                                encounterFilter === "All notes" ||
                                e.status === encounterFilter,
                            )
                            .map((e) => (
                              <tr key={e.id}>
                                <td>
                                  <button
                                    className="person-cell"
                                    onClick={() => openChart(e.patient_id)}
                                  >
                                    <Avatar person={e} />
                                    <span>
                                      <strong>{fullName(e)}</strong>
                                      <small>{mrn(e.patient_id)}</small>
                                    </span>
                                  </button>
                                </td>
                                <td>
                                  <strong>{e.chief_complaint}</strong>
                                  <small className="cell-secondary">
                                    {e.author}
                                  </small>
                                </td>
                                <td>{prettyDate(e.created_at)}</td>
                                <td>
                                  <Badge>{e.status}</Badge>
                                </td>
                                <td>
                                  <button
                                    className="text-button"
                                    onClick={() => setEditor(e)}
                                  >
                                    {e.status === "Signed"
                                      ? "View note"
                                      : "Continue note"}
                                    <ArrowUpRight size={14} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      icon={FileCheck2}
                      title="No notes in this view"
                      description="Start a patient encounter or choose another filter."
                    />
                  )}
                </section>
              )}
              {page === "labs" && (
                <section className="panel">
                  <div className="panel-heading">
                    <div className="section-title">
                      <h2>Laboratory results</h2>
                      <span className="count-chip">{labs.length}</span>
                    </div>
                    <span className="subtle-label">
                      Seeded results · No live lab connection
                    </span>
                  </div>
                  {labs.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Patient</th>
                            <th>Test</th>
                            <th>Result</th>
                            <th>Reference range</th>
                            <th>Date</th>
                            <th>Flag</th>
                          </tr>
                        </thead>
                        <tbody>
                          {labs.map((l) => (
                            <tr key={l.id}>
                              <td>
                                <button
                                  className="person-cell"
                                  onClick={() => openChart(l.patient_id)}
                                >
                                  <Avatar person={l} />
                                  <strong>{fullName(l)}</strong>
                                </button>
                              </td>
                              <td>{l.name}</td>
                              <td
                                className={l.flag === "High" ? "abnormal" : ""}
                              >
                                <strong>{l.value}</strong> {l.unit}
                              </td>
                              <td>{l.reference_range}</td>
                              <td>{prettyDate(l.date)}</td>
                              <td>
                                <Badge>{l.flag}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      icon={FlaskConical}
                      title="No lab results"
                      description="No results have been recorded."
                    />
                  )}
                </section>
              )}
              {page === "inbox" && (
                <TaskBoard
                  patients={patients}
                  user={user}
                  onChanged={refresh}
                  initialTaskId={workSource.sourceId}
                />
              )}
              {page === "queue" && (
                <QueuePage
                  clinical={clinical}
                  onVisit={startVisit}
                  onChanged={refresh}
                />
              )}
              {page === "intake" && <IntakePage onChanged={refresh} />}
              {page === "digital-checkin" && <DigitalCheckInPage key={settingsIdentity} user={user} onOpenPatient={openChart} onChanged={refresh} />}
              {page === "readiness" && <ReadinessPage onChart={openChart} />}
              {page === "fax-inbox" && (
                <FaxInboxPage
                  patients={patients}
                  clinical={clinical}
                  onChart={openChart}
                  initialFaxId={workSource.sourceId}
                />
              )}
              {page === "orders" && <OrderList patients={patients} initialResultId={workSource.sourceId} />}
              {page === "reminders" && <RemindersPage clinical={clinical} />}
              {page === "insurance" && <InsurancePage patients={patients} />}
              {page === "billing" && <BillingPage patients={patients} />}
              {page === "authorizations" && (
                <AuthorizationsPage patients={patients} initialAuthorizationId={workSource.sourceId} />
              )}
              {page === "metrics" && <MetricsPage />}
              {page === "integrations" && <IntegrationsPage />}
              {page === "my-work" && <MyWorkPage key={settingsIdentity} user={user} onOpenPatient={openChart} onNavigate={(destination, sourceId, messageId) => {
                const params = new URLSearchParams();
                if (sourceId) {
                  if (destination === "staff") params.set(sourceId.startsWith("announcement:") ? "announcement" : "conversation", sourceId.startsWith("announcement:") ? sourceId.slice("announcement:".length) : sourceId);
                  else params.set("source", sourceId);
                }
                if (messageId && destination === "staff") params.set("message", messageId);
                location.hash = destination + (params.size ? `?${params}` : "");
                setPage(destination); setMobileNav(false);
                setWorkSource({ sourceId: params.get("source") || undefined, conversationId: params.get("conversation") || undefined, messageId: params.get("message") || undefined, announcementId: params.get("announcement") || undefined });
              }} />}
              {page === "staff" && <StaffCommunicationPage key={settingsIdentity} user={user} initialConversationId={workSource.conversationId} initialMessageId={workSource.messageId} initialAnnouncementId={workSource.announcementId} />}
              {page === "settings" && <SettingsPage key={settingsIdentity} user={user} onUserChanged={sessionUser} onSettingsChanged={setWorkspaceSettings} />}
              {page === "account" && (
                <AccountPage
                  key={`${user.practice?.id}-${user.id}`}
                  user={user}
                  onUserChanged={sessionUser}
                />
              )}
              {page === "activity" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Recent workspace activity</h2>
                    <span className="subtle-label">
                      Latest 100 events · UTC
                    </span>
                  </div>
                  {audit.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Event</th>
                            <th>Team member</th>
                            <th>Resource</th>
                            <th>Timestamp (UTC)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {audit.map((a) => (
                            <tr key={a.id}>
                              <td>
                                <span className="audit-icon">
                                  <ShieldCheck size={15} />
                                </span>
                                {a.action}
                              </td>
                              <td>{a.actor}</td>
                              <td className="mono">{a.resource}</td>
                              <td className="mono">{a.created_at}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      icon={ShieldCheck}
                      title="No activity yet"
                      description="Workspace events will appear here as you work."
                    />
                  )}
                </section>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>
              <Leaf size={13} />
              Connected care, thoughtfully.
            </span>
            <span>
              <span className="status-dot flow-green" />
              {isStandalonePreview
                ? "Synthetic data · Preview changes reset on reload"
                : "Synthetic data · Development workspace"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {commandOpen && (
        <CommandPalette
          patients={patients}
          encounters={encounters}
          onChart={openChart}
          onNote={setEditor}
          onNavigate={(value) => navigate(value as Page)}
          onClose={() => setCommandOpen(false)}
        />
      )}
      {(modal === "patient" || modal === "new-patient") && (
        <PatientForm
          clinical={clinical}
          openOnCreate={modal === "new-patient"}
          onClose={() => setModal(null)}
          onSaved={async (
            id,
            openRecord,
            initialTab = "Insurance",
            existing = false,
          ) => {
            await refresh();
            setToast(
              existing
                ? "Existing patient record opened"
                : "Patient registered",
            );
            if (openRecord) {
              const patient = clinical
                ? await api<Patient>(`/patients/${id}`)
                : (await api<Patient[]>("/patients")).find((p) => p.id === id);
              if (!patient)
                throw new Error("Patient record could not be loaded.");
              setChartTab(initialTab);
              setChart(patient);
            }
          }}
        />
      )}
      {modal === "appointment" && (
        <AppointmentForm
          patients={patients}
          today={day}
          initialTime={appointmentPrefill.time}
          initialProvider={appointmentPrefill.provider_id}
          registerNewPatient={appointmentPrefill.register_patient}
          clinical={clinical}
          onPatientsChanged={() => refresh()}
          onClose={() => setModal(null)}
          onSaved={async (date) => {
            setDay(date);
            navigate("schedule");
            await refresh(date);
            setToast("Appointment scheduled");
          }}
        />
      )}
      {chart && !modal && (
        <PatientChart
          key={chart.id}
          patient={chart}
          user={user}
          clinical={clinical}
          initialTab={chartTab}
          onClose={() => setChart(null)}
          onChanged={async () => {
            const id = chart.id;
            const next = clinical
              ? await api<Patient>(`/patients/${id}`)
              : (await api<Patient[]>("/patients")).find((person) => person.id === id);
            if (!next) throw new Error("Patient record could not be refreshed.");
            setChart((current) => current?.id === id ? next : current);
            await refresh();
          }}
          onEncounter={(p) => {
            setEncounterPatient(p.id);
            setChart(null);
            setModal("encounter");
          }}
        />
      )}
      {editor && (
        <EncounterEditor
          key={editor.id}
          encounter={editor}
          patientName={fullName(
            patients.find((p) => p.id === editor.patient_id) || {},
          )}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await refresh();
            setToast("Encounter saved");
          }}
        />
      )}
      {modal === "encounter" && (
        <Modal
          title="Start an encounter"
          subtitle="Begin a new clinical note for a patient."
          onClose={() => setModal(null)}
        >
          <form className="modal-body form-stack" onSubmit={createEncounter}>
            <label>
              Patient
              <select
                name="patient_id"
                value={encounterPatient}
                onChange={(e) => setEncounterPatient(e.target.value)}
                required
              >
                <option disabled value="">
                  Select a patient
                </option>
                {patients.map((p) => (
                  <option value={p.id} key={p.id}>
                    {fullName(p)} · {mrn(p.id)}
                  </option>
                ))}
              </select>
            </label>
            <BillingAccountSelect patientId={encounterPatient} />
            <label>
              Chief complaint
              <input
                name="chief_complaint"
                placeholder="Reason for this encounter"
                required
                maxLength={500}
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <footer className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={actionBusy}>
                <Plus size={16} />
                Create encounter
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {modal === "help" && (
        <Modal
          title="Your Cevrali workspace"
          subtitle="A foundation for connected outpatient care."
          onClose={() => setModal(null)}
        >
          <div className="modal-body help-content">
            <span className="help-logo">
              <Leaf size={30} />
            </span>
            <h3>Make yourself at home.</h3>
            <p>
              Register a patient, schedule their visit, and document a SOAP
              encounter. Save a draft as you go, then sign to lock the completed
              note.
            </p>
            <div className="mini-card">
              <h3>
                <ShieldCheck size={17} />
                {isStandalonePreview
                  ? "Interactive offline preview"
                  : "Development demo"}
              </h3>
              <p>
                {isStandalonePreview && (
                  <>
                    This file runs entirely in your browser. Changes reset on
                    reload and do not update the application's database.{" "}
                  </>
                )}
                All seeded records are synthetic. This starter does not connect
                to live pharmacies, labs, payers, or health information
                exchanges. Production clinical use requires additional security,
                compliance, and clinical validation.
              </p>
            </div>
            <div className="help-details">
              <div>
                <span>Signed in as</span>
                <strong>{user.name}</strong>
              </div>
              <div>
                <span>Access</span>
                <strong>
                  {clinical
                    ? "Clinical workspace"
                    : "Registration & scheduling"}
                </strong>
              </div>
              <div>
                <span>Clinic time zone</span>
                <strong>America/Los_Angeles</strong>
              </div>
              <div>
                <span>Version</span>
                <strong>Cevrali 0.1.0</strong>
              </div>
            </div>
            <button className="button primary" onClick={() => setModal(null)}>
              Back to workspace
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
