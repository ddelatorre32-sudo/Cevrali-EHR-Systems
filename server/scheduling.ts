import { z } from 'zod';

export const schedulingDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a valid calendar date');
export type CalendarView = 'day' | 'week' | 'month' | 'list';
const asDate = (value: string) => new Date(`${value}T12:00:00Z`);
const key = (value: Date) => value.toISOString().slice(0, 10);
export function addCalendarDays(value: string, days: number) {
  const d = asDate(value);
  d.setUTCDate(d.getUTCDate() + days);
  return key(d);
}
export function startOfCalendarWeek(value: string) {
  const day = asDate(value).getUTCDay();
  return addCalendarDays(value, -((day + 6) % 7));
}
export function calendarDates(start: string, count: number) {
  return Array.from({ length: count }, (_, i) => addCalendarDays(start, i));
}
export function calendarRange(view: CalendarView, value: string) {
  const start =
    view === 'week'
      ? startOfCalendarWeek(value)
      : view === 'month'
        ? startOfCalendarWeek(value.slice(0, 7) + '-01')
        : value;
  return {
    start,
    end: addCalendarDays(
      start,
      view === 'month' ? 41 : view === 'week' ? 6 : 0,
    ),
  };
}
export function moveCalendarDate(
  view: CalendarView,
  value: string,
  direction: number,
) {
  if (view !== 'month')
    return addCalendarDays(value, direction * (view === 'week' ? 7 : 1));
  const d = asDate(value),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + direction);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return key(d);
}
export function calendarDateLabel(
  value: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  },
) {
  return new Intl.DateTimeFormat('en-US', {
    ...options,
    timeZone: 'UTC',
  }).format(asDate(value));
}
export function readAppointmentRange(
  query: Record<string, unknown>,
  today: string,
) {
  const input = z
    .object({
      date: schedulingDate.optional(),
      start: schedulingDate.optional(),
      end: schedulingDate.optional(),
    })
    .parse(query);
  if (input.start !== undefined || input.end !== undefined) {
    if (!input.start || !input.end || input.date)
      throw Object.assign(
        new Error('Supply start and end together, without date'),
        { status: 400 },
      );
    const days =
      (asDate(input.end).getTime() - asDate(input.start).getTime()) / 86400000;
    if (days < 0 || days > 41)
      throw Object.assign(
        new Error('Calendar range must contain 1 to 42 days'),
        { status: 400 },
      );
    return { start: input.start, end: input.end };
  }
  const date = input.date || today;
  return { start: date, end: date };
}
