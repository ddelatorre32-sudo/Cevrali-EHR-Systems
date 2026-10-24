export const CLINIC_TIME_ZONE = 'America/Los_Angeles';

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const timezoneSuffix = /(?:z|[+-]\d{2}:?\d{2})$/i;
const dateOptions: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
};

function parseDate(value: string) {
  if (dateOnly.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
      ? new Date(NaN)
      : date;
  }
  // SQLite timestamps and ISO timestamps without an offset are stored in UTC.
  const timestamp = value.trim().replace(' ', 'T');
  return new Date(timezoneSuffix.test(timestamp) ? timestamp : `${timestamp}Z`);
}

export function clinicDate(now = new Date()): string {
  if (Number.isNaN(now.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function calendarDate(value: string): string {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return dateOnly.test(value) ? value : clinicDate(date);
}

export function clinicAge(dob: string, now = new Date()): number {
  const birth = calendarDate(dob);
  const today = clinicDate(now);
  if (!birth || !today) return NaN;
  return (
    Number(today.slice(0, 4)) -
    Number(birth.slice(0, 4)) -
    Number(today.slice(5) < birth.slice(5))
  );
}

export function formatClinicDate(
  value: string,
  options: Intl.DateTimeFormatOptions = dateOptions,
): string {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  return new Intl.DateTimeFormat('en-US', {
    ...options,
    // Calendar dates have no timezone. UTC retains their recorded day.
    timeZone: dateOnly.test(value) ? 'UTC' : CLINIC_TIME_ZONE,
  }).format(date);
}

export function clinicTimestampLabel(
  value: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatClinicDate(
    value,
    options ?? (dateOnly.test(value) ? dateOptions : {
      ...dateOptions,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  );
}
