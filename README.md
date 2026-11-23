# Frontdesk

Frontdesk is a customer-support ticket workspace for Arvo Systems' nine-agent team. It uses Express and TypeScript with PostgreSQL parameterized SQL, plus an Angular agent workspace and customer portal simulator.

## Prerequisites

- Node.js 20.19+ and npm
- PostgreSQL 14+

## Local Setup

1. Create a database named `frontdesk` (for example, `createdb frontdesk`).
2. Apply the schema from the repository root:

   ```sh
   psql -d frontdesk -f backend/schema.sql
   ```

3. Copy `.env.example` to `.env` and set `DATABASE_URL` for your PostgreSQL user and password. Backend scripts load this root `.env` automatically.
4. Install dependencies:

   ```sh
   npm install
   ```

5. Seed the agents, customers, holidays, and sample tickets:

   ```sh
   npm run seed -w backend
   ```

6. Start the API and Angular app in separate terminals from the repository root:

   ```sh
   npm run dev:backend
   npm run dev:frontend
   ```

   Open `http://localhost:4200`. The Angular development server proxies `/api` to Express at `http://localhost:3000`.

To run checks, use `npm run build:backend`, `npm run test:backend`, `npm run build:frontend`, or `npm run build`.

## SLA Rules

Working time is Monday through Friday, 09:30–18:30 UTC, excluding dates in `holidays`. The pure interval calculator intersects each date's working window with the requested interval. While waiting for a customer, elapsed working time is paused from `waiting_since`; completed waits are accumulated in `paused_working_minutes`. Priority changes apply the new target to net elapsed working time since ticket creation, so a priority escalation can make an existing ticket late immediately.

The seed includes an overdue HIGH ticket, a Friday 18:00 ticket, a waiting ticket, and DONE tickets resolved two and seven working days ago. The Friday sample is not counted during the weekend.

## Safeguards

- **INC-0291:** Claiming locks the ticket row with `SELECT ... FOR UPDATE`; a second claimant gets HTTP 409.
- **INC-0304:** Public replies use `ticket_messages`; private notes use the separate `internal_notes` table. Customer view queries only ticket metadata and public messages.
- **INC-0318:** State changes and notes write audit entries within their database transaction. A PostgreSQL trigger rejects audit-log updates and deletes.

Waiting tickets are lazily auto-closed at 2,700 working minutes when the ticket API is accessed. DONE tickets can be reopened through 2,700 working minutes after resolution; later attempts return HTTP 400 and direct customers to create a new ticket.

This scaffold uses a user switcher for local evaluation, not authentication. Production deployment should add authenticated identity, authorization, a configured business timezone, and operational migrations/backups.