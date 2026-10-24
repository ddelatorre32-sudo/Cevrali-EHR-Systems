import type { Appointment } from "./types";
/** Share status/provider filtering across the calendar and selected-day list. */
export function filterCalendarAppointments<
  T extends { status: string; provider_id?: string },
>(appointments: T[], providerId: string, filter: string): T[] {
  return appointments.filter(
    (a) =>
      (providerId === "all" ||
        (a.provider_id || "usr-clinician") === providerId) &&
      (filter === "All appointments" ||
        (filter === "Upcoming"
          ? ["Scheduled", "Checked in", "In progress"].includes(a.status)
          : filter === "No-shows"
            ? a.status === "No-show"
            : filter === "Completed" && a.status === "Completed")),
  );
}
export const calendarMinutes = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const slotTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export type PositionedAppointment = {
  appointment: Appointment;
  lane: number;
  lanes: number;
};
// Intersecting appointments share a cluster. Reuse a lane only after its previous visit ends.
export function positionCalendarAppointments(
  appointments: Appointment[],
): PositionedAppointment[] {
  const ordered = [...appointments].sort(
    (a, b) =>
      calendarMinutes(a.time) - calendarMinutes(b.time) ||
      b.duration - a.duration ||
      a.id.localeCompare(b.id),
  );
  const output: PositionedAppointment[] = [];
  let cluster: PositionedAppointment[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const row of cluster) output.push({ ...row, lanes: ends.length });
    cluster = [];
    ends = [];
    clusterEnd = -1;
  };
  for (const appointment of ordered) {
    const start = calendarMinutes(appointment.time),
      end = start + appointment.duration;
    if (start >= clusterEnd) flush();
    let lane = ends.findIndex((value) => value <= start);
    if (lane < 0) lane = ends.length;
    ends[lane] = end;
    clusterEnd = Math.max(clusterEnd, end);
    cluster.push({ appointment, lane, lanes: 1 });
  }
  flush();
  return output;
}
export function calendarHours(appointments: Appointment[]) {
  return {
    start: Math.max(
      0,
      Math.min(
        7,
        ...appointments.map((a) => Math.floor(calendarMinutes(a.time) / 60)),
      ),
    ),
    end: Math.min(
      24,
      Math.max(
        19,
        ...appointments.map((a) =>
          Math.ceil((calendarMinutes(a.time) + a.duration) / 60),
        ),
      ),
    ),
  };
}
