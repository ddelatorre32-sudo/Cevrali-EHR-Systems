import { AppointmentRescheduleButton } from "./schedule-management";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { api } from "./api";
import { Avatar, Badge, Modal, fullName, timeLabel } from "./components";
import { AppointmentBillingAccount } from "./patient-accounts-ui";
import { useResource } from "./workflow-ui";
import {
  calendarDateLabel,
  calendarDates,
  calendarRange,
  moveCalendarDate,
  type CalendarView,
} from "../server/scheduling";
import {
  calendarHours,
  calendarMinutes,
  filterCalendarAppointments,
  positionCalendarAppointments,
  slotTime,
} from "./calendar-layout";
import type { Appointment } from "./types";

export type AppointmentPrefill = {
  time?: string;
  provider_id?: string;
  register_patient?: boolean;
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
    new Date(),
  );
const statusClass = (s: string) => s.toLowerCase().replaceAll(" ", "-");
const accountLabel = (a: Appointment) =>
  a.billing_account_claim_number
    ? `${a.billing_account_payer} · Claim ${a.billing_account_claim_number}`
    : a.billing_account_payer ||
      a.billing_account_name ||
      "Visit account not recorded";
function periodLabel(view: CalendarView, day: string) {
  if (view === "month")
    return calendarDateLabel(day, { month: "long", year: "numeric" });
  const range = calendarRange(view, day);
  if (view === "week")
    return `${calendarDateLabel(range.start, { month: "short", day: "numeric" })} – ${calendarDateLabel(range.end, { month: "short", day: "numeric", year: "numeric" })}`;
  return calendarDateLabel(day, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
export function ScheduleCalendar({
  day,
  onDayChange,
  providerId,
  onProviderChange,
  appointments,
  onCreate,
  onChart,
  onStatus,
  onStart,
  clinical,
  onChanged,
  filter,
  onSessionExpired,
  defaultView = "week",
}: {
  day: string;
  onDayChange: (day: string) => void;
  providerId: string;
  onProviderChange: (id: string) => void;
  appointments: Appointment[];
  onCreate: (date: string, prefill: AppointmentPrefill) => void;
  onChart: (id: string) => void;
  onStatus: (a: Appointment, status: string) => Promise<void>;
  onStart: (a: Appointment) => Promise<void>;
  clinical: boolean;
  onChanged: () => Promise<void>;
  filter: string;
  onSessionExpired: () => void;
  defaultView?: CalendarView;
}) {
  const [view, setView] = useState<CalendarView>(defaultView),
    [rows, setRows] = useState<Appointment[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [selectedId, setSelectedId] = useState("");
  useEffect(() => { setView(defaultView); }, [defaultView]);
  const team = useResource<{ id: string; name: string; role: string }[]>(
    "/workflow/team",
    [],
  );
  const range = calendarRange(view, day);
  const days = calendarDates(
    range.start,
    view === "month" ? 42 : view === "week" ? 7 : 1,
  );
  const scroll = useRef<HTMLDivElement>(null);
  const sessionExpired = useRef(onSessionExpired);
  sessionExpired.current = onSessionExpired;
  useEffect(() => {
    let active = true;
    let sequence = 0;
    setRows((previous) =>
      previous.filter((a) => a.date >= range.start && a.date <= range.end),
    );
    setLoading(true);
    setError("");
    async function load() {
      const request = ++sequence;
      try {
        const data = await api<Appointment[]>(
          `/appointments?start=${range.start}&end=${range.end}`,
        );
        if (active && request === sequence) {
          setRows(data);
          setError("");
          setLoading(false);
        }
      } catch (e) {
        if (active && request === sequence) {
          if ((e as { status?: number }).status === 401) {
            sessionExpired.current();
            return;
          }
          setError((e as Error).message);
          setLoading(false);
        }
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [range.start, range.end, appointments, retry]);
  const providers = [
    ...new Map(
      [
        ...team.data.filter((u) => u.role === "clinician"),
        ...rows.map((a) => ({
          id: a.provider_id || "usr-clinician",
          name: a.provider,
          role: "clinician",
        })),
      ].map((p) => [p.id, p]),
    ).values(),
  ];
  const visible = filterCalendarAppointments(rows, providerId, filter);
  const hours = calendarHours(visible);
  const hourHeight = 76;
  const height = (hours.end - hours.start) * hourHeight;
  useEffect(() => {
    if (scroll.current)
      scroll.current.scrollTop = Math.max(
        0,
        (8 - hours.start) * hourHeight - 12,
      );
  }, [view, range.start, hours.start]);
  const selected = rows.find((a) => a.id === selectedId);
  const create = (date: string, time = "14:00") =>
    onCreate(date, {
      time,
      provider_id:
        providerId === "all" ||
        !team.data.some((p) => p.id === providerId && p.role === "clinician")
          ? undefined
          : providerId,
    });
  const selectAppointment = (a: Appointment) => {
    onDayChange(a.date);
    setSelectedId(a.id);
  };
  const openDay = (date: string) => {
    onDayChange(date);
    setView("day");
  };
  return (
    <>
      <div className="calendar-heading">
        <div>
          <div className="calendar-eyebrow">
            <CalendarDays size={15} /> PRACTICE CALENDAR{" "}
            <span>Pacific time</span>
          </div>
          <h2 aria-live="polite">{periodLabel(view, day)}</h2>
          <p>Select a time to schedule. Open a visit to see its details.</p>
        </div>
        <div
          className="calendar-view-switch"
          role="group"
          aria-label="Calendar view"
        >
          {(["day", "week", "month", "list"] as CalendarView[]).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="calendar-toolbar">
        <div className="button-row">
          <button
            className="icon-button bordered"
            aria-label={`Previous ${view === "list" ? "day" : view}`}
            onClick={() => onDayChange(moveCalendarDate(view, day, -1))}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="button secondary small"
            onClick={() => onDayChange(today())}
          >
            Today
          </button>
          <button
            className="icon-button bordered"
            aria-label={`Next ${view === "list" ? "day" : view}`}
            onClick={() => onDayChange(moveCalendarDate(view, day, 1))}
          >
            <ChevronRight size={17} />
          </button>
          <input
            className="schedule-date"
            aria-label="Schedule date"
            type="date"
            value={day}
            onChange={(e) => {
              if (e.target.value) onDayChange(e.target.value);
            }}
          />
        </div>
        <div className="button-row">
          <label className="calendar-provider">
            Provider
            <select
              aria-label="Calendar provider"
              value={providerId}
              onChange={(e) => onProviderChange(e.target.value)}
            >
              <option value="all">All providers</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button bordered"
            aria-label="Refresh calendar"
            onClick={() => setRetry((n) => n + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error calendar-feedback" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="calendar-feedback" role="status">
          Loading calendar…
        </p>
      )}
      {view === "month" && (
        <div className="calendar-month-scroll">
          <div
            className="calendar-month"
            role="group"
            aria-label="Month calendar"
          >
            <div className="calendar-month-weekdays">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="calendar-month-days">
              {days.map((date) => {
                const visits = visible.filter((a) => a.date === date);
                return (
                  <section
                    key={date}
                    className={`calendar-month-day ${date.slice(0, 7) !== day.slice(0, 7) ? "outside-month" : ""} ${date === day ? "selected-date" : ""}`}
                    aria-label={calendarDateLabel(date)}
                  >
                    <div className="calendar-month-date">
                      <button
                        className={date === today() ? "calendar-today" : ""}
                        aria-label={`View ${calendarDateLabel(date)}`}
                        aria-current={date === today() ? "date" : undefined}
                        onClick={() => onDayChange(date)}
                      >
                        {Number(date.slice(-2))}
                      </button>
                      <button
                        className="calendar-add-day"
                        aria-label={`Schedule for ${calendarDateLabel(date)}`}
                        title="Schedule on this date"
                        disabled={loading || Boolean(error)}
                        onClick={() => create(date)}
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                    {visits.slice(0, 3).map((a) => (
                      <button
                        className={`calendar-month-event ${statusClass(a.status)}`}
                        key={a.id}
                        aria-label={`${fullName(a)}, ${calendarDateLabel(a.date)}, ${timeLabel(a.time)}, ${a.provider}, ${a.status}`}
                        onClick={() => selectAppointment(a)}
                      >
                        <span className="calendar-status-dot" />
                        <time>{timeLabel(a.time)}</time>
                        <strong>{fullName(a)}</strong>
                      </button>
                    ))}
                    {visits.length > 3 && (
                      <button
                        className="calendar-more"
                        onClick={() => openDay(date)}
                      >
                        {visits.length - 3} more appointments
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {(view === "day" || view === "week") && (
        <div
          className="calendar-time-scroll"
          ref={scroll}
          tabIndex={0}
          aria-label={`${view === "week" ? "Week" : "Day"} calendar, scroll for more times`}
        >
          <div
            className={`calendar-time-grid ${view}`}
            style={{ "--calendar-columns": days.length } as CSSProperties}
          >
            <div className="calendar-time-header">
              <span className="calendar-time-zone">PACIFIC</span>
              {days.map((date) => (
                <button
                  key={date}
                  className={`calendar-column-day ${date === day ? "selected-date" : ""}`}
                  aria-label={`View day ${calendarDateLabel(date)}`}
                  onClick={() => openDay(date)}
                >
                  <span>{calendarDateLabel(date, { weekday: "short" })}</span>
                  <strong className={date === today() ? "calendar-today" : ""}>
                    {Number(date.slice(-2))}
                  </strong>
                </button>
              ))}
            </div>
            <div className="calendar-time-body" style={{ height }}>
              <div className="calendar-hour-labels">
                {Array.from({ length: hours.end - hours.start }, (_, i) => (
                  <span key={i} style={{ top: i * hourHeight }}>
                    {timeLabel(slotTime((hours.start + i) * 60))}
                  </span>
                ))}
              </div>
              {days.map((date) => (
                <div
                  className={`calendar-day-track ${date === today() ? "is-today" : ""}`}
                  key={date}
                  style={{ height }}
                  aria-label={`Appointments for ${calendarDateLabel(date)}`}
                >
                  {Array.from(
                    { length: (hours.end - hours.start) * 2 },
                    (_, i) => {
                      const time = slotTime(hours.start * 60 + i * 30);
                      return (
                        <button
                          className="calendar-slot"
                          style={{ height: hourHeight / 2 }}
                          key={time}
                          aria-label={`Schedule ${date} at ${time}`}
                          title={`Schedule at ${timeLabel(time)}`}
                          disabled={loading || Boolean(error)}
                          onClick={() => create(date, time)}
                        />
                      );
                    },
                  )}
                  {positionCalendarAppointments(
                    visible.filter((a) => a.date === date),
                  ).map(({ appointment: a, lane, lanes }) => (
                    <button
                      className={`calendar-event ${statusClass(a.status)} ${a.duration < 30 ? "compact" : ""}`}
                      key={a.id}
                      style={{
                        top:
                          ((calendarMinutes(a.time) - hours.start * 60) / 60) *
                            hourHeight +
                          1,
                        height: (a.duration / 60) * hourHeight - 2,
                        left: `calc(${(lane / lanes) * 100}% + 3px)`,
                        width: `calc(${100 / lanes}% - 6px)`,
                      }}
                      aria-label={`${fullName(a)}, ${calendarDateLabel(a.date)}, ${timeLabel(a.time)}, ${a.provider}, ${a.status}, ${accountLabel(a)}`}
                      title={`${fullName(a)} · ${timeLabel(a.time)} · ${a.duration} min\n${a.provider} · ${a.status}\n${accountLabel(a)}`}
                      onClick={() => selectAppointment(a)}
                    >
                      <strong>{fullName(a)}</strong>
                      {a.duration >= 30 && (
                        <span>
                          {timeLabel(a.time)} · {a.status}
                        </span>
                      )}
                      {a.duration >= 60 && (
                        <small>
                          {a.provider}
                          <br />
                          {accountLabel(a)}
                        </small>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="calendar-legend">
        <span>
          <i className="scheduled" />
          Scheduled
        </span>
        <span>
          <i className="checked-in" />
          Checked in
        </span>
        <span>
          <i className="in-progress" />
          In progress
        </span>
        <span>
          <i className="completed" />
          Completed
        </span>
        <span>
          <i className="cancelled" />
          Cancelled
        </span>
        <span>
          <i className="no-show" />
          No-show
        </span>
        <strong>
          {visible.length} appointment{visible.length === 1 ? "" : "s"} in{" "}
          {view === "month" ? "calendar" : view === "week" ? "week" : "day"}
        </strong>
      </div>
      <div className="calendar-agenda-heading">
        <div>
          <h3>
            {view === "list" ? "Daily appointment list" : "Selected day"} ·{" "}
            {calendarDateLabel(day, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </h3>
          <p>Check in patients and continue visits below.</p>
        </div>
        <button className="text-button" onClick={() => create(day)}>
          <Plus size={14} />
          Schedule for this day
        </button>
      </div>
      {selected && (
        <Modal
          title="Appointment details"
          subtitle={`${calendarDateLabel(selected.date)} · Pacific time`}
          onClose={() => setSelectedId("")}
        >
          <div className="modal-body calendar-appointment-detail">
            <div className="chart-identity">
              <Avatar person={selected} large />
              <div>
                <h3>{fullName(selected)}</h3>
                <p>{selected.type}</p>
              </div>
              <Badge>{selected.status}</Badge>
            </div>
            <dl className="finance-details">
              <div>
                <dt>Time</dt>
                <dd>
                  {timeLabel(selected.time)} –{" "}
                  {calendarMinutes(selected.time) + selected.duration === 1440
                    ? "12:00 AM (next day)"
                    : timeLabel(
                        slotTime(
                          calendarMinutes(selected.time) + selected.duration,
                        ),
                      )}{" "}
                  · {selected.duration} minutes
                </dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{selected.provider}</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{selected.reason}</dd>
              </div>
              <div>
                <dt>Visit insurance / claim</dt>
                <dd>
                  {selected.billing_account_payer ||
                    selected.billing_account_name}
                  {selected.billing_account_claim_number
                    ? ` · Claim ${selected.billing_account_claim_number}`
                    : ""}
                </dd>
              </div>
            </dl>
            <AppointmentBillingAccount
              appointment={selected}
              onChanged={onChanged}
            />
            <AppointmentRescheduleButton
              appointment={selected}
              providers={team.data.filter((u) => u.role === "clinician")}
              onChange={async () => {
                await onChanged();
                setRetry((n) => n + 1);
                setSelectedId("");
              }}
            />
            <div className="button-row">
              <button
                className="button secondary"
                onClick={() => {
                  setSelectedId("");
                  onChart(selected.patient_id);
                }}
              >
                Open patient record
              </button>
              {selected.status === "Scheduled" && (
                <button
                  className="button primary"
                  onClick={() => {
                    setSelectedId("");
                    void onStatus(selected, "Checked in");
                  }}
                >
                  Check in patient
                </button>
              )}
              {clinical &&
                ["Checked in", "In progress"].includes(selected.status) && (
                  <button
                    className="button primary"
                    onClick={() => {
                      setSelectedId("");
                      void onStart(selected);
                    }}
                  >
                    {selected.status === "In progress"
                      ? "Continue visit"
                      : "Start visit"}
                  </button>
                )}
              {clinical && selected.status === "In progress" && (
                <button
                  className="button secondary"
                  onClick={() => {
                    setSelectedId("");
                    void onStatus(selected, "Completed");
                  }}
                >
                  Complete visit
                </button>
              )}
              {["Scheduled", "Checked in"].includes(selected.status) && (
                <button
                  className="text-button cancel-link"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Cancel ${fullName(selected)}’s appointment at ${timeLabel(selected.time)}?`,
                      )
                    ) {
                      setSelectedId("");
                      void onStatus(selected, "Cancelled");
                    }
                  }}
                >
                  Cancel appointment
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
