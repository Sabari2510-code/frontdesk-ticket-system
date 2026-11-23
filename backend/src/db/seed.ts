import { pool, withTransaction } from './pool.js';

const agents = [
  'Meera Nair', 'Arjun Rao', 'Priya Shah', 'Kabir Mehta', 'Ananya Iyer',
  'Rohan Das', 'Ishita Sen', 'Dev Patel', 'Neha Kulkarni',
];
const customers = ['Northstar Labs', 'Bluebird Retail', 'Cedar & Stone', 'Lumen Health'];

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftWorkingDays(value: Date, count: number, holidays: Set<string>) {
  const date = new Date(value);
  let shifted = 0;
  while (shifted < count) {
    date.setUTCDate(date.getUTCDate() - 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(dateKey(date))) shifted += 1;
  }
  return date;
}

async function ensureTicket(input: {
  subject: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'DONE';
  customerId: number;
  assigneeId: number | null;
  createdAt: Date;
  waitingSince?: Date | null;
  resolvedAt?: Date | null;
  message: string;
}) {
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM tickets WHERE subject = $1 AND customer_id = $2 ORDER BY id LIMIT 1',
    [input.subject, input.customerId],
  );
  let ticketId = existing.rows[0]?.id;
  if (ticketId) {
    await pool.query(
      `UPDATE tickets SET priority = $2, status = $3, assignee_id = $4, created_at = $5,
        waiting_since = $6, resolved_at = $7, updated_at = NOW() WHERE id = $1`,
      [ticketId, input.priority, input.status, input.assigneeId, input.createdAt,
        input.waitingSince ?? null, input.resolvedAt ?? null],
    );
  } else {
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO tickets (subject, priority, status, customer_id, assignee_id, created_at, waiting_since, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.subject, input.priority, input.status, input.customerId, input.assigneeId, input.createdAt,
        input.waitingSince ?? null, input.resolvedAt ?? null],
    );
    ticketId = inserted.rows[0].id;
    await pool.query(
      `INSERT INTO audit_logs (ticket_id, actor_label, action, details)
       VALUES ($1, 'System', 'TICKET_CREATED', $2)`,
      [ticketId, JSON.stringify({ subject: input.subject, seeded: true })],
    );
  }
  const messageExists = await pool.query('SELECT 1 FROM ticket_messages WHERE ticket_id = $1 LIMIT 1', [ticketId]);
  if (!messageExists.rowCount) {
    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, author_id, author_role, body) VALUES ($1, $2, $3, $4)',
      [ticketId, input.customerId, 'CUSTOMER', input.message],
    );
  }
}

async function seed() {
  await withTransaction(async (client) => {
    for (const [holidayDate, label] of [
      ['2026-01-26', 'Republic Day'],
      ['2026-08-15', 'Independence Day'],
      ['2026-10-20', 'Diwali'],
      ['2026-12-25', 'Christmas'],
    ]) {
      await client.query(
        'INSERT INTO holidays (holiday_date, label) VALUES ($1, $2) ON CONFLICT (holiday_date) DO UPDATE SET label = EXCLUDED.label',
        [holidayDate, label],
      );
    }
    for (const name of [...agents, ...customers]) {
      const role = agents.includes(name) ? 'AGENT' : 'CUSTOMER';
      await client.query(
        'INSERT INTO users (name, role) VALUES ($1, $2) ON CONFLICT (name, role) DO NOTHING',
        [name, role],
      );
    }
  });

  const userRows = await pool.query<{ id: number; name: string; role: string }>('SELECT id, name, role FROM users');
  const userId = (name: string) => {
    const user = userRows.rows.find((row) => row.name === name);
    if (!user) throw new Error(`Seed user not found: ${name}`);
    return user.id;
  };
  const holidayRows = await pool.query<{ holiday_date: string }>('SELECT holiday_date::text FROM holidays');
  const holidays = new Set(holidayRows.rows.map((row) => row.holiday_date));
  const now = new Date();
  const friday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceFriday = (friday.getUTCDay() - 5 + 7) % 7 || 7;
  friday.setUTCDate(friday.getUTCDate() - daysSinceFriday);
  friday.setUTCHours(18, 0, 0, 0);

  const overdueCreated = shiftWorkingDays(now, 3, holidays);
  overdueCreated.setUTCHours(10, 0, 0, 0);
  const waitingCreated = shiftWorkingDays(now, 2, holidays);
  waitingCreated.setUTCHours(10, 0, 0, 0);
  const waitingSince = shiftWorkingDays(now, 1, holidays);
  waitingSince.setUTCHours(15, 30, 0, 0);
  const recentResolution = shiftWorkingDays(now, 2, holidays);
  recentResolution.setUTCHours(16, 0, 0, 0);
  const oldResolution = shiftWorkingDays(now, 7, holidays);
  oldResolution.setUTCHours(16, 0, 0, 0);
  const recentCreated = new Date(recentResolution.getTime() - 2 * 60 * 60_000);
  const oldCreated = new Date(oldResolution.getTime() - 3 * 60 * 60_000);

  await ensureTicket({
    subject: 'Payment capture failing for renewal orders', priority: 'HIGH', status: 'OPEN',
    customerId: userId('Northstar Labs'), assigneeId: userId('Meera Nair'), createdAt: overdueCreated,
    message: 'Renewal payments are failing with a capture timeout since this morning. Could you investigate?',
  });
  await ensureTicket({
    subject: 'Dashboard export requested after business hours', priority: 'MEDIUM', status: 'OPEN',
    customerId: userId('Bluebird Retail'), assigneeId: null, createdAt: friday,
    message: 'Our weekly dashboard export is missing the regional breakdown. We sent this after the team had signed off.',
  });
  await ensureTicket({
    subject: 'Need confirmation of account owner email', priority: 'LOW', status: 'WAITING_ON_CUSTOMER',
    customerId: userId('Cedar & Stone'), assigneeId: userId('Priya Shah'), createdAt: waitingCreated,
    waitingSince, message: 'Please update the account owner email for our workspace.',
  });
  await ensureTicket({
    subject: 'Mobile sign-in loop resolved', priority: 'MEDIUM', status: 'DONE',
    customerId: userId('Lumen Health'), assigneeId: userId('Arjun Rao'), createdAt: recentCreated,
    resolvedAt: recentResolution, message: 'The mobile app returns to sign-in after the verification code is accepted.',
  });
  await ensureTicket({
    subject: 'Historical invoice download resolved', priority: 'LOW', status: 'DONE',
    customerId: userId('Northstar Labs'), assigneeId: userId('Meera Nair'), createdAt: oldCreated,
    resolvedAt: oldResolution, message: 'We cannot download invoices older than six months from billing history.',
  });
  await ensureTicket({
    subject: 'Webhook delivery retries delayed', priority: 'HIGH', status: 'IN_PROGRESS',
    customerId: userId('Bluebird Retail'), assigneeId: userId('Kabir Mehta'), createdAt: waitingCreated,
    message: 'Webhook retries are taking several minutes to arrive at our endpoint.',
  });

  console.log('Seeded 9 agents, 4 customers, festival holidays, and 6 sample tickets.');
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());