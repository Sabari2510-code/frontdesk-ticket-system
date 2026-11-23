import { Router } from 'express';
import { pool } from '../db/pool.js';
import { HttpError, addInternalNote, addReply, autoCloseInactiveTickets, changePriority, changeStatus, claimTicket, createTicket, getTicketAgentView, getTicketCustomerView, listTickets, reopenTicket } from '../services/ticket.service.js';

export const ticketsRouter = Router();

function asyncRoute(handler: (request: any, response: any) => Promise<unknown>) {
  return (request: any, response: any, next: any) => handler(request, response).catch(next);
}

function positiveId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid ticket ID.');
  return id;
}

ticketsRouter.use((request, response, next) => {
  autoCloseInactiveTickets().then(() => next()).catch(next);
});

ticketsRouter.get('/', asyncRoute(async (_request, response) => {
  response.json(await listTickets());
}));

ticketsRouter.post('/', asyncRoute(async (request, response) => {
  const { subject, priority, customerId } = request.body ?? {};
  if (typeof subject !== 'string' || !subject.trim() || !['HIGH', 'MEDIUM', 'LOW'].includes(priority) || !Number.isInteger(Number(customerId))) {
    throw new HttpError(400, 'subject, valid priority, and customerId are required.');
  }
  response.status(201).json(await createTicket({ subject, priority, customerId: Number(customerId) }));
}));

ticketsRouter.get('/:id/customer-view', asyncRoute(async (request, response) => {
  response.json(await getTicketCustomerView(positiveId(request.params.id)));
}));

ticketsRouter.get('/:id', asyncRoute(async (request, response) => {
  response.json(await getTicketAgentView(positiveId(request.params.id)));
}));

ticketsRouter.post('/:id/claim', asyncRoute(async (request, response) => {
  const agentId = Number(request.body?.agentId);
  if (!Number.isInteger(agentId) || agentId < 1) throw new HttpError(400, 'agentId is required.');
  response.json(await claimTicket(positiveId(request.params.id), agentId));
}));

ticketsRouter.post('/:id/replies', asyncRoute(async (request, response) => {
  const { authorId, body, waitForCustomer } = request.body ?? {};
  if (!Number.isInteger(Number(authorId)) || typeof body !== 'string' || !body.trim()) {
    throw new HttpError(400, 'authorId and body are required.');
  }
  response.status(201).json(await addReply(positiveId(request.params.id), {
    authorId: Number(authorId), body, waitForCustomer: Boolean(waitForCustomer),
  }));
}));

ticketsRouter.post('/:id/internal-notes', asyncRoute(async (request, response) => {
  const { authorId, body } = request.body ?? {};
  if (!Number.isInteger(Number(authorId)) || typeof body !== 'string' || !body.trim()) {
    throw new HttpError(400, 'authorId and body are required.');
  }
  response.status(201).json(await addInternalNote(positiveId(request.params.id), { authorId: Number(authorId), body }));
}));

ticketsRouter.patch('/:id/priority', asyncRoute(async (request, response) => {
  const { priority, actorId } = request.body ?? {};
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(priority) || !Number.isInteger(Number(actorId))) {
    throw new HttpError(400, 'Valid priority and actorId are required.');
  }
  response.json(await changePriority(positiveId(request.params.id), priority, Number(actorId)));
}));

ticketsRouter.patch('/:id/status', asyncRoute(async (request, response) => {
  const { status, actorId } = request.body ?? {};
  if (!['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'DONE', 'CLOSED'].includes(status) || !Number.isInteger(Number(actorId))) {
    throw new HttpError(400, 'Valid status and actorId are required.');
  }
  response.json(await changeStatus(positiveId(request.params.id), status, Number(actorId)));
}));

ticketsRouter.post('/:id/reopen', asyncRoute(async (request, response) => {
  const actorId = Number(request.body?.actorId);
  if (!Number.isInteger(actorId) || actorId < 1) throw new HttpError(400, 'actorId is required.');
  response.json(await reopenTicket(positiveId(request.params.id), actorId));
}));

export const usersRouter = Router();
usersRouter.get('/', asyncRoute(async (_request, response) => {
  const result = await pool.query('SELECT id, name, role, created_at FROM users ORDER BY role, name');
  response.json(result.rows);
}));

export const holidaysRouter = Router();
holidaysRouter.get('/', asyncRoute(async (_request, response) => {
  const result = await pool.query('SELECT holiday_date, label FROM holidays ORDER BY holiday_date');
  response.json(result.rows);
}));