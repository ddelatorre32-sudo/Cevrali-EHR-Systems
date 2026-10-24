import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clinicAge,
  clinicDate,
  clinicTimestampLabel,
  formatClinicDate,
} from '../src/clinic-dates';

test('calendar-only dates retain their recorded day in every browser timezone', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Pacific/Kiritimati', 'America/Adak']) {
      process.env.TZ = timezone;
      assert.equal(formatClinicDate('2026-01-01'), 'Jan 1, 2026');
      assert.equal(formatClinicDate('2024-02-29', { weekday: 'long' }), 'Thursday');
      assert.equal(clinicTimestampLabel('2026-01-01'), 'Jan 1, 2026');
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('UTC, SQLite and explicitly offset timestamps display the same Pacific day', () => {
  for (const timestamp of [
    '2026-01-01T07:30:00Z',
    '2026-01-01 07:30:00',
    '2026-01-01T07:30:00',
    '2026-01-01T09:30:00+02:00',
    '2025-12-31T23:30:00-08:00',
  ]) {
    assert.equal(formatClinicDate(timestamp), 'Dec 31, 2025');
    assert.match(clinicTimestampLabel(timestamp), /Dec 31, 2025, 11:30 PM PST/);
  }
  assert.equal(formatClinicDate('2026-01-01T08:00:00Z'), 'Jan 1, 2026');
});

test('clinic timestamps respect both daylight saving transitions', () => {
  assert.match(clinicTimestampLabel('2026-03-08T09:59:00Z'), /1:59 AM PST/);
  assert.match(clinicTimestampLabel('2026-03-08T10:00:00Z'), /3:00 AM PDT/);
  assert.match(clinicTimestampLabel('2026-11-01T08:30:00Z'), /1:30 AM PDT/);
  assert.match(clinicTimestampLabel('2026-11-01T09:30:00Z'), /1:30 AM PST/);
});

test('clinic day and age change at Pacific midnight instead of browser midnight', () => {
  const before = new Date('2026-10-21T06:59:59Z');
  const midnight = new Date('2026-10-21T07:00:00Z');
  assert.equal(clinicDate(before), '2026-10-20');
  assert.equal(clinicDate(midnight), '2026-10-21');
  assert.equal(clinicAge('2000-10-21', before), 25);
  assert.equal(clinicAge('2000-10-21', midnight), 26);
  assert.equal(clinicAge('2000-10-21T05:00:00Z', before), 26);
  assert.equal(clinicAge('2024-02-29', new Date('2025-02-28T20:00:00Z')), 0);
  assert.equal(clinicAge('2024-02-29', new Date('2025-03-01T20:00:00Z')), 1);
});

test('format options retain clinic timezone and invalid dates do not crash the UI', () => {
  assert.equal(formatClinicDate('2026-01-01T07:30:00Z', {
    weekday: 'long', timeZone: 'UTC',
  }), 'Wednesday');
  assert.equal(clinicTimestampLabel('2026-01-01T07:30:00Z', {
    hour: 'numeric', minute: '2-digit',
  }), '11:30 PM');
  assert.equal(formatClinicDate('2026-02-30'), 'Invalid Date');
  assert.equal(formatClinicDate('invalid'), 'Invalid Date');
  assert.equal(clinicDate(new Date(NaN)), '');
  assert.ok(Number.isNaN(clinicAge('invalid')));
});
