import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db/pool.js';
import { calculateWorkingMinutesBetween, evaluateTicketSla, type SlaTicket, type TicketPriority, type TicketStatus } from './sla.service.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function holidaySet(client?: PoolClient): Promise<Set<string>> {
  const result = await (client ?? pool).query<{ holiday_date: string }>('SELECT holiday_date::text FROM holidays');
  return new Set(result.rows.map((row) => row.holiday_date));
}

async function audit(
  client: PoolClient,
  ticketId: number,
  actorId: number | null,
  actorLabel: string,
  action: string,
  details: Record<string, unknown>,
) {
  await client.query(
    'INSERT INTO audit_logs (ticket_id, actor_id, actor_label, action, details) VALUES ($1, $2, $3, $4, $5)',
    [ticketId, actorId, actorLabel, action, JSON.stringify(details)],
  );
}

async function requireUser(client: PoolClient, userId: number, role?: 'AGENT' | 'CUSTOMER') {
  const result = await client.query<{ id: number; name: string; role: 'AGENT' | 'CUSTOMER' }>(
    'SELECT id, name, role FROM users WHERE id = $1', [userId],
  );
  const user = result.rows[0];
  if (!user || (role && user.role !== role)) throw new HttpError(400, 'Invalid user for this action.');
  return user;
}

export async function autoCloseInactiveTickets(now = new Date()): Promise<void> {
  await withTransaction(async (client) => {
    const holidays = await holidaySet(client);
    const waiting = await client.query<{ id: number; waiting_since: Date }>(
      "SELECT id, waiting_since FROM tickets WHERE status = 'WAITING_ON_CUSTOMER' AND waiting_since IS NOT NULL FOR UPDATE",
    );
    for (const ticket of waiting.rows) {
      const elapsed = calculateWorkingMinutesBetween(new Date(ticket.waiting_since), now, holidays);
      if (elapsed < 2700) continue;
      await client.query(
        "UPDATE tickets SET status = 'CLOSED', waiting_since = NULL, updated_at = $2 WHERE id = $1",
        [ticket.id, now],
      );
      await audit(client, ticket.id, null, 'System', 'AUTO_CLOSED_INACTIVE', { waitingSince: ticket.waiting_since, workingMinutes: elapsed });
    }
  });
}

export async function listTickets(now = new Date()) {
  const [tickets, holidays] = await Promise.all([
    pool.query(`SELECT t.*, a.name AS assignee_name, c.name AS customer_name
      FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
      JOIN users c ON c.id = t.customer_id ORDER BY t.updated_at DESC, t.id DESC`),
    holidaySet(),
  ]);
  return tickets.rows.map((ticket) => ({
    ...ticket,
    sla: evaluateTicketSla(ticket as SlaTicket, now, holidays),
  }));
}

export async function getTicketAgentView(ticketId: number, now = new Date()) {
  const ticket = await pool.query(`SELECT t.*, a.name AS assignee_name, c.name AS customer_name
    FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
    JOIN users c ON c.id = t.customer_id WHERE t.id = $1`, [ticketId]);
  if (!ticket.rowCount) throw new HttpError(404, 'Ticket not found.');
  const [messages, notes, logs, holidays] = await Promise.all([
    pool.query(`SELECT m.*, u.name AS author_name FROM ticket_messages m
      JOIN users u ON u.id = m.author_id WHERE m.ticket_id = $1 ORDER BY m.created_at`, [ticketId]),
    pool.query(`SELECT n.*, u.name AS author_name FROM internal_notes n
      JOIN users u ON u.id = n.author_id WHERE n.ticket_id = $1 ORDER BY n.created_at`, [ticketId]),
    pool.query(`SELECT * FROM audit_logs WHERE ticket_id = $1 ORDER BY created_at, id`, [ticketId]),
    holidaySet(),
  ]);
  return {
    ...ticket.rows[0],
    sla: evaluateTicketSla(ticket.rows[0] as SlaTicket, now, holidays),
    messages: messages.rows,
    internalNotes: notes.rows,
    auditLogs: logs.rows,
  };
}

export async function getTicketCustomerView(ticketId: number, now = new Date()) {
  const [ticket, messages, holidays] = await Promise.all([
    pool.query(`SELECT t.id, t.subject, t.priority, t.status, t.customer_id, t.created_at,
        t.first_replied_at, t.resolved_at, t.waiting_since, t.paused_working_minutes,
        t.updated_at, a.name AS assignee_name
      FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id WHERE t.id = $1`, [ticketId]),
    pool.query(`SELECT m.id, m.ticket_id, m.author_role, m.body, m.created_at, u.name AS author_name
      FROM ticket_messages m JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = $1 ORDER BY m.created_at`, [ticketId]),
    holidaySet(),
  ]);
  if (!ticket.rowCount) throw new HttpError(404, 'Ticket not found.');
  return {
    ...ticket.rows[0],
    sla: evaluateTicketSla(ticket.rows[0] as SlaTicket, now, holidays),
    messages: messages.rows,
  };
}

export async function createTicket(input: { subject: string; priority: TicketPriority; customerId: number }) {
  return withTransaction(async (client) => {
    const customer = await requireUser(client, input.customerId, 'CUSTOMER');
    const inserted = await client.query(
      'INSERT INTO tickets (subject, priority, customer_id) VALUES ($1, $2, $3) RETURNING *',
      [input.subject.trim(), input.priority, customer.id],
    );
    const ticket = inserted.rows[0];
    await audit(client, ticket.id, customer.id, customer.name, 'TICKET_CREATED', { subject: ticket.subject, priority: ticket.priority });
    return ticket;
  });
}

export async function claimTicket(ticketId: number, agentId: number) {
  return withTransaction(async (client) => {
    const ticketResult = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!ticketResult.rowCount) throw new HttpError(404, 'Ticket not found.');
    if (ticketResult.rows[0].assignee_id !== null) throw new HttpError(409, 'Ticket already claimed by another agent.');
    const agent = await requireUser(client, agentId, 'AGENT');
    await client.query('UPDATE tickets SET assignee_id = $2, updated_at = NOW() WHERE id = $1', [ticketId, agentId]);
    await audit(client, ticketId, agentId, agent.name, 'TICKET_CLAIMED', { assigneeId: agentId });
    return { ...ticketResult.rows[0], assignee_id: agentId, assignee_name: agent.name };
  });
}

export async function addReply(
  ticketId: number,
  input: { authorId: number; body: string; waitForCustomer?: boolean },
) {
  return withTransaction(async (client) => {
    const ticketResult = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!ticketResult.rowCount) throw new HttpError(404, 'Ticket not found.');
    const ticket = ticketResult.rows[0];
    const author = await requireUser(client, input.authorId);
    const now = new Date();
    await client.query(
      'INSERT INTO ticket_messages (ticket_id, author_id, author_role, body) VALUES ($1, $2, $3, $4)',
      [ticketId, author.id, author.role, input.body.trim()],
    );

    if (author.role === 'AGENT') {
      const status: TicketStatus = input.waitForCustomer
        ? 'WAITING_ON_CUSTOMER'
        : ticket.status === 'WAITING_ON_CUSTOMER'
          ? (ticket.assignee_id ? 'IN_PROGRESS' : 'OPEN')
          : ticket.status;
      await client.query(
        `UPDATE tickets SET first_replied_at = COALESCE(first_replied_at, $2),
          status = $3, waiting_since = $4, updated_at = $2 WHERE id = $1`,
        [ticketId, now, status, input.waitForCustomer ? now : null],
      );
      await audit(client, ticketId, author.id, author.name, 'PUBLIC_REPLY', { authorRole: author.role, waitingForCustomer: Boolean(input.waitForCustomer) });
      if (ticket.status !== status) {
        await audit(client, ticketId, author.id, author.name, 'STATUS_CHANGED', { from: ticket.status, to: status });
      }
    } else {
      const holidays = await holidaySet(client);
      const waitMinutes = ticket.waiting_since
        ? calculateWorkingMinutesBetween(new Date(ticket.waiting_since), now, holidays)
        : 0;
      const status = ticket.assignee_id ? 'IN_PROGRESS' : 'OPEN';
      await client.query(
        `UPDATE tickets SET paused_working_minutes = paused_working_minutes + $2,
          waiting_since = NULL, status = $3, updated_at = $4 WHERE id = $1`,
        [ticketId, waitMinutes, status, now],
      );
      await audit(client, ticketId, author.id, author.name, 'PUBLIC_REPLY', { authorRole: author.role, waitMinutes, previousStatus: ticket.status, status });
      if (ticket.status !== status) await audit(client, ticketId, author.id, author.name, 'STATUS_CHANGED', { from: ticket.status, to: status });
    }
    return { success: true };
  });
}

export async function addInternalNote(ticketId: number, input: { authorId: number; body: string }) {
  return withTransaction(async (client) => {
    const ticket = await client.query('SELECT id FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!ticket.rowCount) throw new HttpError(404, 'Ticket not found.');
    const author = await requireUser(client, input.authorId, 'AGENT');
    const note = await client.query(
      'INSERT INTO internal_notes (ticket_id, author_id, body) VALUES ($1, $2, $3) RETURNING *',
      [ticketId, author.id, input.body.trim()],
    );
    await audit(client, ticketId, author.id, author.name, 'INTERNAL_NOTE_ADDED', { noteId: note.rows[0].id });
    return note.rows[0];
  });
}

export async function changePriority(ticketId: number, priority: TicketPriority, actorId: number) {
  return withTransaction(async (client) => {
    const ticket = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!ticket.rowCount) throw new HttpError(404, 'Ticket not found.');
    const actor = await requireUser(client, actorId, 'AGENT');
    const previous = ticket.rows[0].priority;
    if (previous !== priority) {
      await client.query('UPDATE tickets SET priority = $2, updated_at = NOW() WHERE id = $1', [ticketId, priority]);
      await audit(client, ticketId, actor.id, actor.name, 'PRIORITY_CHANGED', { from: previous, to: priority });
    }
    return { ...ticket.rows[0], priority };
  });
}

export async function changeStatus(ticketId: number, status: TicketStatus, actorId: number) {
  return withTransaction(async (client) => {
    const ticket = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!ticket.rowCount) throw new HttpError(404, 'Ticket not found.');
    const actor = await requireUser(client, actorId, 'AGENT');
    const previous = ticket.rows[0].status;
    if (previous !== status) {
      const now = new Date();
      await client.query(
        `UPDATE tickets SET status = $2, resolved_at = $3, waiting_since = $4, updated_at = $5 WHERE id = $1`,
        [ticketId, status, status === 'DONE' ? now : null, status === 'WAITING_ON_CUSTOMER' ? now : null, now],
      );
      await audit(client, ticketId, actor.id, actor.name, 'STATUS_CHANGED', { from: previous, to: status });
    }
    return { ...ticket.rows[0], status };
  });
}

export async function reopenTicket(ticketId: number, actorId: number, now = new Date()) {
  return withTransaction(async (client) => {
    const ticketResult = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!ticketResult.rowCount) throw new HttpError(404, 'Ticket not found.');
    const ticket = ticketResult.rows[0];
    if (ticket.status !== 'DONE' || !ticket.resolved_at) throw new HttpError(400, 'Only resolved tickets can be reopened.');
    const holidays = await holidaySet(client);
    const elapsed = calculateWorkingMinutesBetween(new Date(ticket.resolved_at), now, holidays);
    if (elapsed > 2700) throw new HttpError(400, 'The reopen window has expired. Please create a new ticket instead.');
    const actor = await requireUser(client, actorId);
    const status: TicketStatus = ticket.assignee_id ? 'IN_PROGRESS' : 'OPEN';
    await client.query('UPDATE tickets SET status = $2, resolved_at = NULL, updated_at = $3 WHERE id = $1', [ticketId, status, now]);
    await audit(client, ticketId, actor.id, actor.name, 'TICKET_REOPENED', { previousStatus: ticket.status, status, workingMinutesSinceResolution: elapsed });
    return { ...ticket, status, resolved_at: null };
  });
}