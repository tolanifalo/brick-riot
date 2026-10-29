import type { IssueRunResponse } from '@brick-riot/shared';
import { api } from '../net/api';

/**
 * Server-issued solo runs for signed-in players. The server chooses each run's
 * seed and snapshots its upgrades, so the finished input log can be replayed
 * and verified there. One ticket per board is fetched ahead of time so a
 * restart never waits on the network; without a ticket (offline) the run is
 * still playable but cannot be recorded.
 */
const ready = new Map<string, IssueRunResponse>();
const inFlight = new Map<string, Promise<void>>();

export function prefetchRunTicket(boardId: string): Promise<void> {
  if (ready.has(boardId)) return Promise.resolve();
  const existing = inFlight.get(boardId);
  if (existing) return existing;
  const request = api<IssueRunResponse>('POST', '/api/solo/runs', { boardId })
    .then((ticket) => {
      ready.set(boardId, ticket);
    })
    .catch(() => undefined)
    .finally(() => inFlight.delete(boardId));
  inFlight.set(boardId, request);
  return request;
}

/** Takes the prepared ticket for `boardId` (and starts fetching the next one). */
export function takeRunTicket(boardId: string): IssueRunResponse | null {
  const ticket = ready.get(boardId) ?? null;
  ready.delete(boardId);
  void prefetchRunTicket(boardId);
  return ticket;
}

/** Forget tickets (sign-out / account change). */
export function clearRunTickets(): void {
  ready.clear();
}
