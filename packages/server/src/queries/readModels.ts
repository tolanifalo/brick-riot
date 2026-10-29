import {
  getMatchBoard,
  type LeaderboardCategoryId,
  type LeaderboardPage,
  type LeaderboardRow,
  type MatchHistoryEntry,
  type Page,
} from '@brick-riot/shared';
import type { Db } from '../db/client';
import { ApiError } from '../http/errors';
import { PRESEASON } from '../progression/provision';
import type { MatchRecord } from '../persistence/matchResults';

const CATEGORIES: readonly LeaderboardCategoryId[] = ['solo_time', 'solo_score', 'mastery', 'casual_wins'];
const PER_BOARD: readonly LeaderboardCategoryId[] = ['solo_time', 'solo_score'];

/** Read-only queries for leaderboards, match history and balance telemetry. */
export class ReadModels {
  constructor(private readonly db: Db) {}

  /**
   * Leaderboards list verified results only (server-replayed solo runs or
   * finalised matches) of active accounts with a verified email. Each player
   * appears once per category (primary key), with their best value.
   */
  async leaderboard(
    rawCategory: unknown,
    rawBoardId: unknown,
    rawPage: unknown,
    rawPageSize: unknown,
    viewerId: string | null,
  ): Promise<LeaderboardPage> {
    if (typeof rawCategory !== 'string' || !(CATEGORIES as readonly string[]).includes(rawCategory)) throw new ApiError(400, 'unknown_category');
    const category = rawCategory as LeaderboardCategoryId;
    let boardId = '*';
    if (PER_BOARD.includes(category)) {
      if (typeof rawBoardId !== 'string' || !getMatchBoard(rawBoardId)) throw new ApiError(400, 'unknown_board');
      boardId = rawBoardId;
    }
    const page = clampInt(rawPage, 1, 1, 10_000);
    const pageSize = clampInt(rawPageSize, 20, 1, 50);
    const lowerIsBetter = category === 'solo_time';
    const where = { category, boardId, seasonId: PRESEASON, user: { emailVerified: true, status: 'active' as const } };
    const [total, rows] = await Promise.all([
      this.db.leaderboardEntry.count({ where }),
      this.db.leaderboardEntry.findMany({
        where,
        orderBy: [{ value: lowerIsBetter ? 'asc' : 'desc' }, { achievedAt: 'asc' }, { userId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { name: true } } },
      }),
    ]);
    const toRow = (r: (typeof rows)[number], rank: number): LeaderboardRow => ({
      rank,
      playerId: r.userId,
      name: r.user.name,
      value: r.value,
      achievedAt: r.achievedAt.toISOString(),
    });
    let me: LeaderboardRow | null = null;
    if (viewerId) {
      const mine = await this.db.leaderboardEntry.findFirst({ where: { ...where, userId: viewerId }, include: { user: { select: { name: true } } } });
      if (mine) {
        const better = await this.db.leaderboardEntry.count({
          where: {
            ...where,
            OR: [
              { value: lowerIsBetter ? { lt: mine.value } : { gt: mine.value } },
              { value: mine.value, achievedAt: { lt: mine.achievedAt } },
            ],
          },
        });
        me = toRow(mine, better + 1);
      }
    }
    return {
      category,
      boardId: boardId === '*' ? null : boardId,
      seasonId: PRESEASON,
      rows: rows.map((r, i) => toRow(r, (page - 1) * pageSize + i + 1)),
      page,
      pageSize,
      total,
      me,
    };
  }

  /** The signed-in player's own matches, newest first (cursor pagination). */
  async history(userId: string, rawCursor: unknown, rawLimit: unknown): Promise<Page<MatchHistoryEntry>> {
    const limit = clampInt(rawLimit, 20, 1, 50);
    let cursor: { matchId: string; seat: string } | undefined;
    if (typeof rawCursor === 'string' && rawCursor) {
      const [matchId, seat] = rawCursor.split(':');
      if (!matchId || (seat !== 'A' && seat !== 'B')) throw new ApiError(400, 'bad_cursor');
      cursor = { matchId, seat };
    }
    const mine = await this.db.matchParticipant.findMany({
      where: { userId },
      orderBy: [{ match: { finalizedAt: 'desc' } }, { matchId: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { matchId_seat: cursor }, skip: 1 } : {}),
      include: { match: { include: { participants: true } } },
    });
    const items = mine.slice(0, limit).map((p): MatchHistoryEntry => {
      const opp = p.match.participants.find((o) => o.seat !== p.seat);
      return {
        matchId: p.matchId,
        mode: p.match.mode,
        endedAt: p.match.endedAt.toISOString(),
        result: p.result as MatchHistoryEntry['result'],
        reason: p.match.reason,
        myBoardId: p.boardId,
        opponentName: opp?.displayName ?? '?',
        opponentBoardId: opp?.boardId ?? '?',
        myCompletionTick: p.completionTick,
        opponentCompletionTick: opp?.completionTick ?? null,
        myScore: p.score,
        opponentScore: opp?.score ?? 0,
        replayVerified: p.match.replayVerified,
      };
    });
    const last = mine[limit - 1];
    return { items, next: mine.length > limit && last ? `${last.matchId}:${last.seat}` : null };
  }

  /**
   * Full match details (result and verification), for its participants only.
   * Others get 'not_found' so match ids cannot be probed.
   */
  async matchDetail(userId: string, matchId: string): Promise<{ result: MatchRecord['result']; mode: string; equipmentMode: string }> {
    const match = await this.db.match.findFirst({
      where: { id: matchId, participants: { some: { userId } } },
      select: { record: true, mode: true, equipmentMode: true },
    });
    if (!match) throw new ApiError(404, 'not_found');
    const record = match.record as unknown as MatchRecord;
    return { result: record.result, mode: match.mode, equipmentMode: match.equipmentMode };
  }

  /**
   * Multiplayer balance telemetry from finalised, replay-verified matches
   * (aggregates only, no player data): clear times and spread per board
   * version, win rates per board pairing, draw frequency, and results by
   * equipment-power gap. Feeds human calibration of board compatibility.
   */
  async boardTelemetry() {
    const perBoard = await this.db.$queryRaw<
      { boardId: string; boardVersion: number; entries: bigint; clears: bigint; medianTicks: number | null; p25Ticks: number | null; p75Ticks: number | null; stddevTicks: number | null; exhausted: bigint }[]
    >`
      SELECT p."boardId", p."boardVersion",
             count(*) AS entries,
             count(p."completionTick") AS clears,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY p."completionTick") AS "medianTicks",
             percentile_cont(0.25) WITHIN GROUP (ORDER BY p."completionTick") AS "p25Ticks",
             percentile_cont(0.75) WITHIN GROUP (ORDER BY p."completionTick") AS "p75Ticks",
             stddev_samp(p."completionTick") AS "stddevTicks",
             count(p."exhaustedTick") AS exhausted
      FROM "match_participant" p JOIN "match" m ON m."id" = p."matchId"
      WHERE m."replayVerified" AND NOT m."devMode" AND m."outcome" <> 'cancelled'
      GROUP BY p."boardId", p."boardVersion"
      ORDER BY p."boardId", p."boardVersion"`;
    const pairings = await this.db.$queryRaw<{ boardA: string; boardB: string; matches: bigint; winsA: bigint; winsB: bigint; draws: bigint }[]>`
      SELECT a."boardId" AS "boardA", b."boardId" AS "boardB",
             count(*) AS matches,
             count(*) FILTER (WHERE a."result" = 'win') AS "winsA",
             count(*) FILTER (WHERE b."result" = 'win') AS "winsB",
             count(*) FILTER (WHERE a."result" = 'draw') AS draws
      FROM "match_participant" a
      JOIN "match_participant" b ON b."matchId" = a."matchId" AND b."seat" > a."seat"
      JOIN "match" m ON m."id" = a."matchId"
      WHERE m."replayVerified" AND NOT m."devMode" AND m."outcome" <> 'cancelled'
      GROUP BY a."boardId", b."boardId"
      ORDER BY matches DESC`;
    const equipment = await this.db.$queryRaw<{ gapBucket: number; matches: bigint; strongerWins: bigint; draws: bigint }[]>`
      SELECT LEAST(abs(a."equipmentPower" - b."equipmentPower") / 10, 5) * 10 AS "gapBucket",
             count(*) AS matches,
             count(*) FILTER (WHERE (a."equipmentPower" > b."equipmentPower" AND a."result" = 'win')
                                OR (b."equipmentPower" > a."equipmentPower" AND b."result" = 'win')) AS "strongerWins",
             count(*) FILTER (WHERE a."result" = 'draw') AS draws
      FROM "match_participant" a
      JOIN "match_participant" b ON b."matchId" = a."matchId" AND b."seat" > a."seat"
      JOIN "match" m ON m."id" = a."matchId"
      WHERE m."replayVerified" AND NOT m."devMode" AND m."outcome" <> 'cancelled'
      GROUP BY 1 ORDER BY 1`;
    const n = (v: bigint | number | null) => (v === null ? null : Number(v));
    return {
      note: 'Human match data. Board compatibility thresholds remain provisional until enough samples exist.',
      boards: perBoard.map((r) => ({
        boardId: r.boardId,
        boardVersion: r.boardVersion,
        entries: n(r.entries),
        clears: n(r.clears),
        exhausted: n(r.exhausted),
        medianClearSeconds: r.medianTicks === null ? null : Number(r.medianTicks) / 120,
        iqrSeconds: r.p25Ticks === null || r.p75Ticks === null ? null : (Number(r.p75Ticks) - Number(r.p25Ticks)) / 120,
        stddevSeconds: r.stddevTicks === null ? null : Number(r.stddevTicks) / 120,
      })),
      pairings: pairings.map((r) => ({ boardA: r.boardA, boardB: r.boardB, matches: n(r.matches), winsA: n(r.winsA), winsB: n(r.winsB), draws: n(r.draws) })),
      equipmentGap: equipment.map((r) => ({ gapAtLeast: Number(r.gapBucket), matches: n(r.matches), strongerWins: n(r.strongerWins), draws: n(r.draws) })),
    };
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const v = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
