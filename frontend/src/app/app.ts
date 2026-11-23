import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

type Role = 'AGENT' | 'CUSTOMER';
type Priority = 'HIGH' | 'MEDIUM' | 'LOW';
type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'DONE' | 'CLOSED';
type QueueFilter = 'ALL' | 'LATE' | 'WAITING' | 'UNASSIGNED' | 'DONE';

interface User {
  id: number;
  name: string;
  role: Role;
}

interface Sla {
  netElapsedWorkingMinutes: number;
  firstReplyTargetMinutes: number;
  resolveTargetMinutes: number;
  isFirstReplyLate: boolean;
  isResolutionLate: boolean;
  isLate: boolean;
  remainingWorkingMinutes: number;
  isPaused: boolean;
}

interface Ticket {
  id: number;
  subject: string;
  priority: Priority;
  status: Status;
  assignee_id: number | null;
  customer_id: number;
  assignee_name?: string | null;
  customer_name?: string;
  created_at: string;
  first_replied_at: string | null;
  resolved_at: string | null;
  waiting_since: string | null;
  paused_working_minutes: number;
  sla: Sla;
}

interface Message {
  id: number;
  body: string;
  created_at: string;
  author_name: string;
  author_role?: Role;
}

interface Note extends Message {}

interface AuditLog {
  id: number;
  actor_label: string;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

interface TicketDetail extends Ticket {
  messages: Message[];
  internalNotes?: Note[];
  auditLogs?: AuditLog[];
}

@Component({
  selector: 'app-root',
  imports: [FormsModule, JsonPipe, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly http = inject(HttpClient);
  readonly users = signal<User[]>([]);
  readonly tickets = signal<Ticket[]>([]);
  readonly selectedTicket = signal<TicketDetail | null>(null);
  readonly selectedId = signal<number | null>(null);
  readonly agentId = signal<number | null>(null);
  readonly customerId = signal<number | null>(null);
  readonly mode = signal<'AGENT' | 'CUSTOMER'>('AGENT');
  readonly filter = signal<QueueFilter>('ALL');
  readonly replyBody = signal('');
  readonly noteBody = signal('');
  readonly waitForCustomer = signal(false);
  readonly errorMessage = signal('');
  readonly busy = signal(false);
  readonly filters: { key: QueueFilter; label: string }[] = [
    { key: 'ALL', label: 'All' },
    { key: 'LATE', label: 'Late / Overdue' },
    { key: 'WAITING', label: 'Waiting on customer' },
    { key: 'UNASSIGNED', label: 'Unassigned' },
    { key: 'DONE', label: 'Done / Closed' },
  ];
  readonly agents = computed(() => this.users().filter((user) => user.role === 'AGENT'));
  readonly customers = computed(() => this.users().filter((user) => user.role === 'CUSTOMER'));
  readonly visibleTickets = computed(() => {
    let rows = this.tickets();
    if (this.mode() === 'CUSTOMER') rows = rows.filter((ticket) => ticket.customer_id === this.customerId());
    switch (this.filter()) {
      case 'LATE': return rows.filter((ticket) => ticket.sla.isLate && !['DONE', 'CLOSED'].includes(ticket.status));
      case 'WAITING': return rows.filter((ticket) => ticket.status === 'WAITING_ON_CUSTOMER');
      case 'UNASSIGNED': return rows.filter((ticket) => ticket.assignee_id === null);
      case 'DONE': return rows.filter((ticket) => ['DONE', 'CLOSED'].includes(ticket.status));
      default: return rows;
    }
  });
  readonly timeline = computed(() => {
    const ticket = this.selectedTicket();
    if (!ticket) return [];
    return [
      ...ticket.messages.map((item) => ({ ...item, kind: 'message' as const })),
      ...(ticket.internalNotes ?? []).map((item) => ({ ...item, kind: 'note' as const })),
    ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  });

  async ngOnInit() {
    try {
      const users = await firstValueFrom(this.http.get<User[]>('/api/users'));
      this.users.set(users);
      this.agentId.set(users.find((user) => user.role === 'AGENT')?.id ?? null);
      this.customerId.set(users.find((user) => user.role === 'CUSTOMER')?.id ?? null);
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  async refresh() {
    const rows = await firstValueFrom(this.http.get<Ticket[]>('/api/tickets'));
    this.tickets.set(rows);
    const nextId = this.selectedId() ?? rows[0]?.id ?? null;
    if (nextId && rows.some((ticket) => ticket.id === nextId)) await this.openTicket(nextId);
    else {
      this.selectedId.set(null);
      this.selectedTicket.set(null);
    }
  }

  async openTicket(id: number) {
    this.selectedId.set(id);
    try {
      const path = this.mode() === 'AGENT' ? `/api/tickets/${id}` : `/api/tickets/${id}/customer-view`;
      this.selectedTicket.set(await firstValueFrom(this.http.get<TicketDetail>(path)));
      this.errorMessage.set('');
    } catch (error) {
      this.showError(error);
    }
  }

  async setMode(mode: 'AGENT' | 'CUSTOMER') {
    this.mode.set(mode);
    this.filter.set('ALL');
    await this.refresh();
  }

  async selectUser(value: string) {
    if (this.mode() === 'AGENT') this.agentId.set(Number(value));
    else this.customerId.set(Number(value));
    await this.refresh();
  }

  async claim() {
    const ticket = this.selectedTicket();
    const agentId = this.agentId();
    if (!ticket || !agentId) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/tickets/${ticket.id}/claim`, { agentId }));
      await this.refresh();
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy.set(false);
    }
  }

  async changePriority(priority: Priority) {
    const ticket = this.selectedTicket();
    const actorId = this.agentId();
    if (!ticket || !actorId) return;
    try {
      await firstValueFrom(this.http.patch(`/api/tickets/${ticket.id}/priority`, { priority, actorId }));
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  async markDone() {
    const ticket = this.selectedTicket();
    const actorId = this.agentId();
    if (!ticket || !actorId) return;
    try {
      await firstValueFrom(this.http.patch(`/api/tickets/${ticket.id}/status`, { status: 'DONE', actorId }));
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  async reopen() {
    const ticket = this.selectedTicket();
    const actorId = this.customerId();
    if (!ticket || !actorId) return;
    try {
      await firstValueFrom(this.http.post(`/api/tickets/${ticket.id}/reopen`, { actorId }));
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  async sendReply() {
    const ticket = this.selectedTicket();
    const authorId = this.mode() === 'AGENT' ? this.agentId() : this.customerId();
    const body = this.replyBody().trim();
    if (!ticket || !authorId || !body) return;
    try {
      await firstValueFrom(this.http.post(`/api/tickets/${ticket.id}/replies`, {
        authorId, body, waitForCustomer: this.mode() === 'AGENT' && this.waitForCustomer(),
      }));
      this.replyBody.set('');
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  async addNote() {
    const ticket = this.selectedTicket();
    const authorId = this.agentId();
    const body = this.noteBody().trim();
    if (!ticket || !authorId || !body) return;
    try {
      await firstValueFrom(this.http.post(`/api/tickets/${ticket.id}/internal-notes`, { authorId, body }));
      this.noteBody.set('');
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  slaLabel(ticket: Ticket) {
    if (ticket.sla.isPaused) return 'PAUSED · WAITING ON CUSTOMER';
    if (ticket.sla.isLate) return 'LATE';
    return `ON TRACK · ${(ticket.sla.remainingWorkingMinutes / 60).toFixed(1)}h left`;
  }

  formatDate(value: string) {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  private showError(error: unknown) {
    const response = error as { error?: { error?: string }; status?: number };
    const message = response?.error?.error ?? (response?.status === 409
      ? 'Ticket already claimed by another agent. Refreshing the queue.'
      : 'Could not complete the request. Check that the API and database are running.');
    this.errorMessage.set(message);
    if (response?.status === 409) void this.refresh();
  }
}
