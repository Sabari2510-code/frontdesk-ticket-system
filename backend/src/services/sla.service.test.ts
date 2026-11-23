import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWorkingMinutesBetween, evaluateTicketSla } from './sla.service.js';

const date = (value: string) => new Date(`${value}Z`);

test('counts only work-hour overlap and excludes weekends and holidays', () => {
  const minutes = calculateWorkingMinutesBetween(
    date('2026-11-20T17:30:00'),
    date('2026-11-23T10:30:00'),
    new Set(),
  );
  assert.equal(minutes, 120);
  assert.equal(calculateWorkingMinutesBetween(
    date('2026-11-20T09:30:00'),
    date('2026-11-23T18:30:00'),
    new Set(['2026-11-23']),
  ), 540);
});

test('subtracts paused and active customer wait time from net elapsed', () => {
  const result = evaluateTicketSla({
    priority: 'HIGH',
    status: 'WAITING_ON_CUSTOMER',
    created_at: date('2026-11-23T09:30:00'),
    first_replied_at: date('2026-11-23T10:00:00'),
    resolved_at: null,
    waiting_since: date('2026-11-23T10:30:00'),
    paused_working_minutes: 15,
  }, date('2026-11-23T11:00:00'), new Set());

  assert.equal(result.netElapsedWorkingMinutes, 45);
  assert.equal(result.isPaused, true);
});

test('does not apply later customer pauses retroactively to first-reply SLA', () => {
  const result = evaluateTicketSla({
    priority: 'HIGH',
    status: 'IN_PROGRESS',
    created_at: date('2026-11-23T09:30:00'),
    first_replied_at: date('2026-11-23T12:00:00'),
    resolved_at: date('2026-11-23T13:30:00'),
    waiting_since: null,
    paused_working_minutes: 60,
  }, date('2026-11-23T13:30:00'), new Set());

  assert.equal(result.isFirstReplyLate, true);
});