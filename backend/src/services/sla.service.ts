export type TicketPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'DONE' | 'CLOSED';

export interface SlaTicket {
  priority: TicketPriority;
  status: TicketStatus;
  created_at: Date | string;
  first_replied_at: Date | string | null;
  resolved_at: Date | string | null;
  waiting_since: Date | string | null;
  paused_working_minutes: number;
}

const SLA_TARGETS: Record<TicketPriority, { firstReply: number; resolution: number }> = {
  HIGH: { firstReply: 120, resolution: 540 },
  MEDIUM: { firstReply: 270, resolution: 1620 },
  LOW: { firstReply: 540, resolution: 2700 },
};

const MINUTES_PER_DAY = 540;
const OPEN_MINUTE_UTC = 9 * 60 + 30;
const CLOSE_MINUTE_UTC = 18 * 60 + 30;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function calculateWorkingMinutesBetween(start: Date, end: Date, holidayDates: Set<string>): number {
  if (end <= start) return 0;

  let totalMinutes = 0;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

  while (day <= lastDay) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidayDates.has(dateKey(day))) {
      const workStart = new Date(day);
      workStart.setUTCHours(9, 30, 0, 0);
      const workEnd = new Date(day);
      workEnd.setUTCHours(18, 30, 0, 0);
      const overlapStart = Math.max(start.getTime(), workStart.getTime());
      const overlapEnd = Math.min(end.getTime(), workEnd.getTime());
      if (overlapEnd > overlapStart) totalMinutes += (overlapEnd - overlapStart) / 60_000;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }

  return Math.floor(totalMinutes);
}

export function evaluateTicketSla(
  ticket: SlaTicket,
  now: Date,
  holidayDates: Set<string>,
) {
  const targets = SLA_TARGETS[ticket.priority];
  const createdAt = new Date(ticket.created_at);
  const elapsedEnd = ticket.resolved_at ? new Date(ticket.resolved_at) : now;
  const elapsedWorkingMinutes = calculateWorkingMinutesBetween(createdAt, elapsedEnd, holidayDates);
  const activeWaitMinutes = ticket.status === 'WAITING_ON_CUSTOMER' && ticket.waiting_since
    ? calculateWorkingMinutesBetween(new Date(ticket.waiting_since), now, holidayDates)
    : 0;
  const netElapsedWorkingMinutes = Math.max(
    0,
    elapsedWorkingMinutes - ticket.paused_working_minutes - activeWaitMinutes,
  );
  const firstReplyElapsed = ticket.first_replied_at
    ? calculateWorkingMinutesBetween(createdAt, new Date(ticket.first_replied_at), holidayDates)
    : netElapsedWorkingMinutes;
  const isFirstReplyLate = firstReplyElapsed > targets.firstReply;
  const isResolutionLate = netElapsedWorkingMinutes > targets.resolution;
  const nextTarget = ticket.first_replied_at ? targets.resolution : targets.firstReply;

  return {
    netElapsedWorkingMinutes,
    firstReplyTargetMinutes: targets.firstReply,
    resolveTargetMinutes: targets.resolution,
    isFirstReplyLate,
    isResolutionLate,
    isLate: isFirstReplyLate || isResolutionLate,
    remainingWorkingMinutes: Math.max(0, nextTarget - netElapsedWorkingMinutes),
    isPaused: activeWaitMinutes > 0 || ticket.status === 'WAITING_ON_CUSTOMER',
  };
}

export const SLA_WORKING_MINUTES_PER_DAY = MINUTES_PER_DAY;