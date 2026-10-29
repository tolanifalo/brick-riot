import {
  MATCH_REWARDS,
  rateEquipment,
  rateMatch,
  type EquipmentMode,
  type MatchResult,
  type Seat,
} from '@brick-riot/shared';
import type { Db, Prisma } from '../db/client';
import { isUniqueViolation } from '../http/errors';
import { CASUAL_QUEUE, PRESEASON, type Tx } from '../progression/provision';
import type { ProgressionService } from '../progression/service';
import type { MatchRecord, MatchResultRepository } from './matchResults';

type SeatResult = 'win' | 'loss' | 'draw' | 'cancelled';

export function seatResult(result: MatchResult, seat: Seat): SeatResult {
  if (result.outcome === 'cancelled') return 'cancelled';
  if (result.outcome === 'draw') return 'draw';
  return result.winnerSeat === seat ? 'win' : 'loss';
}

/**
 * PostgreSQL match results (Phase 5). Finalisation is ONE transaction:
 * the immutable match row, both participants, Quick Match rewards (ledger,
 * idempotent per match and player), the hidden casual skill estimate and the
 * casual-wins leaderboard. A second save of the same match id inserts nothing
 * (primary key) and the whole transaction rolls back, so nothing is paid twice.
 * Ranked ratings are never touched: ranked play is not live.
 */
export class PrismaMatchResultRepository implements MatchResultRepository {
  constructor(
    private readonly db: Db,
    private readonly progression: ProgressionService | null = null,
  ) {}

  async save(record: MatchRecord): Promise<'saved' | 'duplicate'> {
    const { result } = record;
    const mode = record.mode ?? 'private';
    const accounts = record.accounts ?? { A: null, B: null };
    const equipmentMode = (record.equipmentMode ?? 'casual') as EquipmentMode;
    try {
      await this.db.$transaction(async (tx) => {
        const ratings = await this.casualRatings(tx, accounts);
        await tx.match.create({
          data: {
            id: result.matchId,
            roomId: result.roomId,
            mode,
            devMode: result.devMode,
            outcome: result.outcome,
            reason: result.reason,
            winnerSeat: result.winnerSeat,
            startTick: result.startTick,
            endTick: result.endTick,
            durationTicks: result.durationTicks,
            ticksPerSecond: result.ticksPerSecond,
            equipmentMode,
            replayVerified: result.verification.replayVerified,
            startedAt: new Date(record.startedAt ?? Date.parse(result.finalizedAt)),
            endedAt: new Date(result.finalizedAt),
            record: toJson(record),
            compatibility: result.compatibility ? toJson(result.compatibility) : undefined,
            participants: {
              create: result.players.map((p) => ({
                seat: p.seat,
                userId: accounts[p.seat] ?? null,
                displayName: p.name,
                boardId: p.boardId,
                boardVersion: p.boardVersion,
                completionTick: p.completionTick,
                exhaustedTick: p.exhaustedTick,
                score: p.score,
                ballsRemaining: p.ballsRemaining,
                bricksCleared: p.bricksCleared,
                bricksTotal: p.bricksTotal,
                forfeited: p.forfeited,
                result: seatResult(result, p.seat),
                equipment: toJson(record.equipment?.[p.seat] ?? null),
                equipmentPower: record.equipment?.[p.seat] ? rateEquipment(record.equipment[p.seat], equipmentMode).power : 0,
                ratingBefore: ratings[p.seat]?.rating ?? null,
              })),
            },
          },
        });
        if (mode === 'quick' && this.eligibleForRating(record)) {
          await this.applyQuickMatchOutcome(tx, record, accounts, ratings);
        }
      });
      return 'saved';
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      throw err;
    }
  }

  /** Only clean, replay-verified, decided-on-the-board results count. */
  private eligibleForRating(record: MatchRecord): boolean {
    const r = record.result;
    return r.verification.replayVerified && !r.devMode && r.outcome !== 'cancelled' && r.reason !== 'both_disconnected';
  }

  private async casualRatings(tx: Tx, accounts: Record<Seat, string | null>) {
    const out: Partial<Record<Seat, { rating: number; deviation: number; volatility: number }>> = {};
    for (const seat of ['A', 'B'] as const) {
      const userId = accounts[seat];
      if (!userId) continue;
      const row = await tx.rating.findUnique({ where: { userId_queue_seasonId: { userId, queue: CASUAL_QUEUE, seasonId: PRESEASON } } });
      if (row) out[seat] = { rating: row.rating, deviation: row.deviation, volatility: row.volatility };
    }
    return out;
  }

  private async applyQuickMatchOutcome(
    tx: Tx,
    record: MatchRecord,
    accounts: Record<Seat, string | null>,
    ratings: Partial<Record<Seat, { rating: number; deviation: number; volatility: number }>>,
  ): Promise<void> {
    const { result } = record;
    const a = accounts.A;
    const b = accounts.B;
    // Hidden casual skill estimate (matchmaking only; never shown as a rank).
    if (a && b && ratings.A && ratings.B && a !== b) {
      const scoreA = result.outcome === 'draw' ? 0.5 : result.winnerSeat === 'A' ? 1 : 0;
      const [nextA, nextB] = rateMatch(ratings.A, ratings.B, scoreA);
      for (const [userId, next] of [[a, nextA], [b, nextB]] as const) {
        await tx.rating.update({
          where: { userId_queue_seasonId: { userId, queue: CASUAL_QUEUE, seasonId: PRESEASON } },
          data: { rating: next.rating, deviation: next.deviation, volatility: next.volatility, gamesPlayed: { increment: 1 } },
        });
      }
    }
    for (const p of result.players) {
      const userId = accounts[p.seat];
      if (!userId) continue;
      const outcome = seatResult(result, p.seat);
      if (outcome === 'win') {
        await tx.$executeRaw`
          INSERT INTO "leaderboard_entry" ("category", "boardId", "seasonId", "userId", "value", "evidenceId", "achievedAt")
          VALUES ('casual_wins', '*', ${PRESEASON}, ${userId}, 1, ${result.matchId}, now())
          ON CONFLICT ("category", "boardId", "seasonId", "userId")
          DO UPDATE SET "value" = "leaderboard_entry"."value" + 1, "evidenceId" = EXCLUDED."evidenceId", "achievedAt" = EXCLUDED."achievedAt"`;
      }
      if (p.forfeited || !this.progression) continue;
      if (!(await this.underDailyCap(tx, userId))) continue;
      const reward = outcome === 'win' ? MATCH_REWARDS.win : outcome === 'draw' ? MATCH_REWARDS.draw : MATCH_REWARDS.loss;
      await this.progression.credit(tx, userId, reward.xp, reward.coins, 'match_reward', result.matchId, `match:${result.matchId}`);
    }
  }

  private async underDailyCap(tx: Tx, userId: string): Promise<boolean> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const rewarded = await tx.ledgerEntry.count({ where: { userId, type: 'match_reward', currency: 'xp', createdAt: { gte: start } } });
    return rewarded < MATCH_REWARDS.dailyCap;
  }

  async get(matchId: string): Promise<MatchRecord | null> {
    const row = await this.db.match.findUnique({ where: { id: matchId }, select: { record: true } });
    return row ? (row.record as unknown as MatchRecord) : null;
  }

  async listRecent(limit: number): Promise<MatchResult[]> {
    const rows = await this.db.match.findMany({ orderBy: { finalizedAt: 'desc' }, take: limit, select: { record: true } });
    return rows.map((r) => (r.record as unknown as MatchRecord).result);
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
