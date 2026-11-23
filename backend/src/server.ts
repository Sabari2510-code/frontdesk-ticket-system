import cors from 'cors';
import express from 'express';
import { pool } from './db/pool.js';
import { holidaysRouter, ticketsRouter, usersRouter } from './routes/tickets.routes.js';
import { HttpError } from './services/ticket.service.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:4200' }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
app.use('/api/tickets', ticketsRouter);
app.use('/api/users', usersRouter);
app.use('/api/holidays', holidaysRouter);
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  response.status(500).json({ error: 'An unexpected server error occurred.' });
});

const server = app.listen(port, () => console.log(`Frontdesk API listening on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => void pool.end()));
}