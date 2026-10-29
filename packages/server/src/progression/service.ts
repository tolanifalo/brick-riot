import {
  applyRunResult,
  buildPlayerConfig,
  CAMPAIGN_BOARDS,
  createEmptyBoardProgress,
  createEmptyProgress,
  decodeInputLog,
  encodeInputLog,
  getCampaignBoard,
  isAbilityUnlocked,
  isBoardUnlocked,
  levelForXp,
  loadoutPower,
  maxLevel,
  nextLevelCost,
  NO_UPGRADES,
  parseSave,
  rateEquipment,
  replayRun,
  sanitizeUpgradeLevels,
  summarizeRun,
  UPGRADE_IDS,
  validateLoadout,
  type AbilityId,
  type BoardProgress,
  type EncodedRun,
  type Equipment,
  type EquipmentView,
  type FinishRunResponse,
  type ImportSummary,
  type IssueRunResponse,
  type Loadout,
  type PlayerProgress,
  type ProfileView,
  type ProgressView,
  type PublicProfileView,
  type PurchaseResponse,
  type RunOutcome,
  type RunSummary,
  type StarRating,
  type UpgradeId,
  type UpgradeLevels,
} from '@brick-riot/shared';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '../db/client';
import { ApiError, isUniqueViolation } from '../http/errors';
import { grantLevelAbilities, levelOf, PRESEASON, type Tx } from './provision';

const RUN_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_RUNS_PER_MINUTE = 20;
const TICK_MS = 1000 / 120;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

interface StoredRunResult {
  summary: RunSummary;
  outcome: RunOutcome;
}

/**
 * SERVER-AUTHORITATIVE progression. Every change to XP, coins, unlocks,
 * mastery, equipment and records happens here, inside a database transaction,
 * tied to a verified event (a replayed solo run or a finalised match) and
 * written to the ledger under a unique idempotency key.
 */
export class ProgressionService {
  constructor(private readonly db: Db) {}

  // ---- Profiles ---------------------------------------------------------------

  async profile(userId: string): Promise<ProfileView> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        boardProgress: true,
        boardUnlocks: true,
        abilities: true,
        loadout: true,
        upgrades: true,
        importedRecords: true,
        localImport: true,
      },
    });
    if (!user || !user.profile) throw new ApiError(404, 'not_found');
    const upgrades = upgradesFromRows(user.upgrades);
    const loadout = loadoutFromRow(user.loadout);
    return {
      account: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      },
      progress: progressView(user.profile.xp, user.profile.coins),
      boards: user.boardProgress.map((b) => ({
        boardId: b.boardId,
        attempts: b.attempts,
        completions: b.completions,
        bestScore: b.bestScore,
        bestTimeMs: b.bestTimeTicks === null ? null : Math.round(b.bestTimeTicks * TICK_MS),
        bestStars: clampStars(b.bestStars),
        mastery: b.masteryDone,
      })),
      unlockedBoardIds: user.boardUnlocks.map((u) => u.boardId),
      importedRecords: user.importedRecords.map((r) => ({
        boardId: r.boardId,
        completions: r.completions,
        bestScore: r.bestScore,
        bestTimeMs: r.bestTimeMs,
        bestStars: clampStars(r.bestStars),
      })),
      equipment: equipmentView(user.abilities.map((a) => a.abilityId as AbilityId), loadout, upgrades),
      settings: { reducedEffects: (user.profile.settings as { reducedEffects?: unknown })?.reducedEffects === true },
      localImport: user.localImport
        ? { importedAt: user.localImport.importedAt.toISOString(), summary: user.localImport.summary as unknown as ImportSummary }
        : null,
      stats: await this.stats(userId),
    };
  }

  async publicProfile(userId: string): Promise<PublicProfileView> {
    const user = await this.db.user.findFirst({
      where: { id: userId, status: 'active' },
      select: { id: true, name: true, createdAt: true, profile: { select: { xp: true } }, boardProgress: { select: { completions: true, masteryDone: true } } },
    });
    if (!user || !user.profile) throw new ApiError(404, 'not_found');
    return {
      id: user.id,
      name: user.name,
      level: levelOf(user.profile.xp),
      memberSince: user.createdAt.toISOString(),
      boardsCleared: user.boardProgress.filter((b) => b.completions > 0).length,
      masteryCount: user.boardProgress.reduce((n, b) => n + b.masteryDone.length, 0),
      stats: await this.stats(userId),
    };
  }

  private async stats(userId: string) {
    const rows = await this.db.matchParticipant.findMany({ where: { userId }, select: { result: true, match: { select: { mode: true } } } });
    const quick = rows.filter((r) => r.match.mode === 'quick');
    return {
      casualMatches: quick.filter((r) => r.result !== 'cancelled').length,
      casualWins: quick.filter((r) => r.result === 'win').length,
      casualDraws: quick.filter((r) => r.result === 'draw').length,
      privateMatches: rows.filter((r) => r.match.mode === 'private' && r.result !== 'cancelled').length,
    };
  }

  async setSettings(userId: string, settings: { reducedEffects: boolean }): Promise<void> {
    await this.db.playerProfile.update({ where: { userId }, data: { settings: { reducedEffects: settings.reducedEffects === true } } });
  }

  // ---- Solo runs ----------------------------------------------------------------

  /** Starts a verifiable solo run: the server chooses the seed and snapshots the equipment. */
  async issueRun(userId: string, boardId: unknown): Promise<IssueRunResponse> {
    const board = typeof boardId === 'string' ? getCampaignBoard(boardId) : undefined;
    if (!board) throw new ApiError(400, 'unknown_board');
    const unlocked = await this.db.boardUnlock.findUnique({ where: { userId_boardId: { userId, boardId: board.id } } });
    if (!unlocked) throw new ApiError(403, 'board_locked');
    const recent = await this.db.soloRun.count({ where: { userId, issuedAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent >= MAX_RUNS_PER_MINUTE) throw new ApiError(429, 'too_many_runs');
    const upgrades = upgradesFromRows(await this.db.upgradeLevel.findMany({ where: { userId } }));
    const run = await this.db.soloRun.create({
      data: { id: randomUUID(), userId, boardId: board.id, boardVersion: board.version, seed: randomInt(1, 0x7fffffff), upgrades },
    });
    return { runId: run.id, seed: run.seed, boardId: board.id, boardVersion: board.version, upgrades };
  }

  /**
   * Replays a submitted input log with the server's seed and equipment, then
   * applies the verified result exactly once. Re-submitting a recorded run
   * returns the stored outcome and changes nothing.
   */
  async finishRun(userId: string, runId: string, encodedInputs: unknown): Promise<FinishRunResponse> {
    const run = await this.db.soloRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw new ApiError(404, 'unknown_run');
    if (run.status === 'verified') return this.storedResult(userId, run.summary);
    if (run.status !== 'issued') throw new ApiError(409, run.status === 'expired' ? 'expired' : 'rejected');
    if (Date.now() - run.issuedAt.getTime() > RUN_TTL_MS) {
      await this.db.soloRun.updateMany({ where: { id: run.id, status: 'issued' }, data: { status: 'expired' } });
      throw new ApiError(409, 'expired');
    }
    const board = getCampaignBoard(run.boardId);
    if (!board || board.version !== run.boardVersion) throw new ApiError(409, 'board_changed');
    const decoded = decodeInputLog(encodedInputs);
    if (!decoded.ok) throw new ApiError(400, decoded.error);

    const upgrades = sanitizeUpgradeLevels(run.upgrades);
    const state = replayRun(board, run.seed, decoded.inputs, buildPlayerConfig({ loadout: null, upgrades }, 'solo'));
    const summary = summarizeRun(state);
    if (summary.status !== 'won' && summary.status !== 'lost') throw new ApiError(400, 'unfinished');
    const finishedAt = new Date();
    const evidence = gzipSync(Buffer.from(JSON.stringify(encodeInputLog(decoded.inputs))));

    try {
      return await this.db.$transaction(async (tx) => {
        // Claim the run: only one submission can move it out of 'issued'.
        const claimed = await tx.soloRun.updateMany({ where: { id: run.id, status: 'issued' }, data: { status: 'verified', submittedAt: finishedAt } });
        if (claimed.count !== 1) throw new ApiError(409, 'duplicate_submission');

        const profile = await tx.playerProfile.findUniqueOrThrow({ where: { userId } });
        const progress = await this.progressSnapshot(tx, userId, profile.xp, profile.coins);
        const applied = applyRunResult(progress, board, CAMPAIGN_BOARDS, {
          runId: run.id,
          summary,
          verified: true,
          finishedAt: finishedAt.toISOString(),
        });
        const { outcome } = applied;
        const record = applied.progress.boards[board.id] ?? createEmptyBoardProgress(board.id);
        const previousBestTicks = (await tx.soloBoardProgress.findUnique({ where: { userId_boardId: { userId, boardId: board.id } } }))?.bestTimeTicks ?? null;
        const bestTimeTicks = outcome.newBestTime ? state.elapsedTicks : previousBestTicks;
        await tx.soloBoardProgress.upsert({
          where: { userId_boardId: { userId, boardId: board.id } },
          create: boardRow(userId, record, bestTimeTicks, finishedAt),
          update: boardRow(userId, record, bestTimeTicks, finishedAt),
        });

        const updated = await this.credit(tx, userId, outcome.xp, outcome.coins, 'solo_reward', run.id, `solo:${run.id}`);
        await this.refreshUnlocks(tx, userId, updated.xp);

        if (outcome.won) await this.recordSoloLeaderboards(tx, userId, board.id, state.elapsedTicks, summary.score, run.id);

        const stored: StoredRunResult = { summary, outcome };
        await tx.soloRun.update({
          where: { id: run.id },
          data: { summary: stored as object, inputs: evidence, xpAwarded: outcome.xp, coinsAwarded: outcome.coins },
        });
        return { duplicate: false, outcome, summary, progress: progressView(updated.xp, updated.coins) };
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate_submission') {
        const again = await this.db.soloRun.findUnique({ where: { id: run.id } });
        if (again?.status === 'verified' && again.summary) return this.storedResult(userId, again.summary);
        throw new ApiError(409, 'duplicate_submission');
      }
      throw err;
    }
  }

  /** The compact input log stored as evidence for a verified run. */
  async runEvidence(runId: string): Promise<EncodedRun[] | null> {
    const run = await this.db.soloRun.findUnique({ where: { id: runId }, select: { inputs: true } });
    if (!run?.inputs) return null;
    return JSON.parse(gunzipSync(Buffer.from(run.inputs)).toString('utf8')) as EncodedRun[];
  }

  private async storedResult(userId: string, stored: unknown): Promise<FinishRunResponse> {
    const profile = await this.db.playerProfile.findUniqueOrThrow({ where: { userId } });
    const { summary, outcome } = stored as StoredRunResult;
    return { duplicate: true, outcome: { ...outcome, duplicate: true }, summary, progress: progressView(profile.xp, profile.coins) };
  }

  /** Verified solo progress in the shape the shared reward rules expect. */
  private async progressSnapshot(tx: Tx, userId: string, xp: number, coins: number): Promise<PlayerProgress> {
    const rows = await tx.soloBoardProgress.findMany({ where: { userId } });
    const progress = createEmptyProgress(new Date().toISOString());
    progress.xp = xp;
    progress.coins = coins;
    for (const r of rows) {
      progress.boards[r.boardId] = {
        boardId: r.boardId,
        attempts: r.attempts,
        completions: r.completions,
        bestScore: r.bestScore ?? 0,
        bestTimeMs: r.bestTimeTicks === null ? null : Math.round(r.bestTimeTicks * TICK_MS),
        bestStars: clampStars(r.bestStars),
        mastery: [...r.masteryDone],
        firstClearedAt: r.firstClearedAt?.toISOString() ?? null,
        lastPlayedAt: r.lastPlayedAt?.toISOString() ?? null,
      };
    }
    return progress;
  }

  /**
   * Adds XP/coins (both may be 0) and writes ledger entries under one
   * idempotency key. A replayed key violates the ledger's unique index and
   * aborts the whole transaction, so a reward can never be paid twice.
   */
  async credit(
    tx: Tx,
    userId: string,
    xp: number,
    coins: number,
    type: 'solo_reward' | 'match_reward',
    sourceEvent: string,
    idempotencyKey: string,
  ): Promise<{ xp: number; coins: number }> {
    const profile = await tx.playerProfile.update({
      where: { userId },
      data: { xp: { increment: xp }, coins: { increment: coins } },
    });
    const level = levelOf(profile.xp);
    if (level !== profile.level) await tx.playerProfile.update({ where: { userId }, data: { level } });
    // Abilities owned by level (idempotent: only missing grants are inserted).
    if (xp > 0) await grantLevelAbilities(tx, userId, level);
    const entries = [
      ...(xp > 0 ? [{ currency: 'xp' as const, amount: xp, balanceAfter: profile.xp }] : []),
      ...(coins > 0 ? [{ currency: 'coins' as const, amount: coins, balanceAfter: profile.coins }] : []),
    ];
    for (const e of entries) {
      await tx.ledgerEntry.create({ data: { userId, type, sourceEvent, idempotencyKey, ...e } });
    }
    return { xp: profile.xp, coins: profile.coins };
  }

  /** Board unlocks from verified clears, imported (casual) clears and level. Never revokes. */
  private async refreshUnlocks(tx: Tx, userId: string, xp: number): Promise<string[]> {
    const progress = createEmptyProgress(new Date().toISOString());
    progress.xp = xp;
    const verified = await tx.soloBoardProgress.findMany({ where: { userId, completions: { gt: 0 } }, select: { boardId: true, completions: true } });
    const imported = await tx.importedRecord.findMany({ where: { userId, completions: { gt: 0 } }, select: { boardId: true, completions: true } });
    for (const r of [...verified, ...imported]) {
      progress.boards[r.boardId] = { ...createEmptyBoardProgress(r.boardId), completions: r.completions };
    }
    const unlocked = CAMPAIGN_BOARDS.filter((b) => isBoardUnlocked(b, progress));
    const result = await tx.boardUnlock.createMany({
      data: unlocked.map((b) => ({ userId, boardId: b.id, boardVersion: b.version, source: 'progression' as const })),
      skipDuplicates: true,
    });
    return result.count > 0 ? unlocked.map((b) => b.id) : [];
  }

  /** Best verified time (lower wins), best score, and total mastery: one row per player and category. */
  private async recordSoloLeaderboards(tx: Tx, userId: string, boardId: string, ticks: number, score: number, runId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "leaderboard_entry" ("category", "boardId", "seasonId", "userId", "value", "evidenceId", "achievedAt")
      VALUES ('solo_time', ${boardId}, ${PRESEASON}, ${userId}, ${ticks}, ${runId}, now())
      ON CONFLICT ("category", "boardId", "seasonId", "userId")
      DO UPDATE SET "value" = EXCLUDED."value", "evidenceId" = EXCLUDED."evidenceId", "achievedAt" = EXCLUDED."achievedAt"
      WHERE "leaderboard_entry"."value" > EXCLUDED."value"`;
    await tx.$executeRaw`
      INSERT INTO "leaderboard_entry" ("category", "boardId", "seasonId", "userId", "value", "evidenceId", "achievedAt")
      VALUES ('solo_score', ${boardId}, ${PRESEASON}, ${userId}, ${score}, ${runId}, now())
      ON CONFLICT ("category", "boardId", "seasonId", "userId")
      DO UPDATE SET "value" = EXCLUDED."value", "evidenceId" = EXCLUDED."evidenceId", "achievedAt" = EXCLUDED."achievedAt"
      WHERE "leaderboard_entry"."value" < EXCLUDED."value"`;
    const rows = await tx.soloBoardProgress.findMany({ where: { userId }, select: { masteryDone: true } });
    const mastery = rows.reduce((n, r) => n + r.masteryDone.length, 0);
    if (mastery > 0) {
      await tx.$executeRaw`
        INSERT INTO "leaderboard_entry" ("category", "boardId", "seasonId", "userId", "value", "evidenceId", "achievedAt")
        VALUES ('mastery', '*', ${PRESEASON}, ${userId}, ${mastery}, ${runId}, now())
        ON CONFLICT ("category", "boardId", "seasonId", "userId")
        DO UPDATE SET "value" = EXCLUDED."value", "evidenceId" = EXCLUDED."evidenceId", "achievedAt" = EXCLUDED."achievedAt"
        WHERE "leaderboard_entry"."value" < EXCLUDED."value"`;
    }
  }

  // ---- Workshop -------------------------------------------------------------------

  /**
   * Buys one upgrade level. Atomic and idempotent per (player, idempotency key):
   * the same key returns the original purchase without charging again; a
   * concurrent second purchase of the same level fails as stale.
   */
  async purchase(userId: string, rawUpgradeId: unknown, rawExpectedLevel: unknown, idempotencyKey: unknown): Promise<PurchaseResponse> {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError(400, 'bad_idempotency_key');
    if (typeof rawUpgradeId !== 'string' || !(UPGRADE_IDS as readonly string[]).includes(rawUpgradeId)) throw new ApiError(400, 'unknown_upgrade');
    const upgradeId = rawUpgradeId as UpgradeId;
    if (typeof rawExpectedLevel !== 'number' || !Number.isInteger(rawExpectedLevel) || rawExpectedLevel < 0) throw new ApiError(400, 'stale_level');
    const expectedLevel = rawExpectedLevel;

    const replay = await this.findPurchase(userId, idempotencyKey);
    if (replay) return replay;

    try {
      return await this.db.$transaction(async (tx) => {
        const row = await tx.upgradeLevel.findUnique({ where: { userId_upgradeId: { userId, upgradeId } } });
        const current = row?.level ?? 0;
        if (current !== expectedLevel) throw new ApiError(409, 'stale_level');
        if (current >= maxLevel(upgradeId)) throw new ApiError(409, 'max_level');
        const cost = nextLevelCost(upgradeId, current);
        if (cost === null) throw new ApiError(409, 'max_level');

        // Conditional debit: the row lock serialises concurrent purchases and
        // the WHERE re-checks the balance, so coins can never go below zero.
        const debited = await tx.playerProfile.updateMany({ where: { userId, coins: { gte: cost } }, data: { coins: { decrement: cost } } });
        if (debited.count !== 1) throw new ApiError(409, 'insufficient_coins');

        if (row) {
          const bumped = await tx.upgradeLevel.updateMany({ where: { userId, upgradeId, level: current }, data: { level: current + 1 } });
          if (bumped.count !== 1) throw new ApiError(409, 'stale_level');
        } else {
          await tx.upgradeLevel.create({ data: { userId, upgradeId, level: 1 } });
        }
        const purchase = await tx.purchase.create({
          data: { userId, upgradeId, fromLevel: current, toLevel: current + 1, cost, idempotencyKey },
        });
        const profile = await tx.playerProfile.findUniqueOrThrow({ where: { userId } });
        await tx.ledgerEntry.create({
          data: {
            userId,
            currency: 'coins',
            amount: -cost,
            balanceAfter: profile.coins,
            type: 'upgrade_purchase',
            sourceEvent: purchase.id,
            idempotencyKey: `purchase:${idempotencyKey}`,
          },
        });
        await this.refreshEquipmentPower(tx, userId);
        return { purchaseId: purchase.id, upgradeId, level: current + 1, cost, coins: profile.coins, replayed: false };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a race: either the same key (return the original) or the same level (stale).
        const original = await this.findPurchase(userId, idempotencyKey);
        if (original) return original;
        throw new ApiError(409, 'stale_level');
      }
      throw err;
    }
  }

  private async findPurchase(userId: string, idempotencyKey: string): Promise<PurchaseResponse | null> {
    const p = await this.db.purchase.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (!p) return null;
    const profile = await this.db.playerProfile.findUniqueOrThrow({ where: { userId } });
    return { purchaseId: p.id, upgradeId: p.upgradeId as UpgradeId, level: p.toLevel, cost: p.cost, coins: profile.coins, replayed: true };
  }

  // ---- Loadout and verified equipment -------------------------------------------------

  /** Saves a loadout after checking slots, budget, level unlocks AND server-recorded ownership. */
  async setLoadout(userId: string, raw: unknown): Promise<EquipmentView> {
    const profile = await this.db.playerProfile.findUniqueOrThrow({ where: { userId } });
    const check = validateLoadout(raw, levelOf(profile.xp));
    if (!check.ok) throw new ApiError(400, check.error);
    const owned = new Set((await this.db.ownedAbility.findMany({ where: { userId } })).map((a) => a.abilityId));
    for (const id of [check.loadout.offensive, check.loadout.defensive, check.loadout.passive]) {
      if (!owned.has(id)) throw new ApiError(403, 'not_owned');
    }
    return this.db.$transaction(async (tx) => {
      await tx.loadout.update({ where: { userId }, data: { ...check.loadout } });
      await this.refreshEquipmentPower(tx, userId);
      return this.equipmentIn(tx, userId);
    });
  }

  /** Server-verified equipment for a match (never client claims). */
  async verifiedEquipment(userId: string): Promise<Equipment & { level: number }> {
    const [loadoutRow, upgradeRows, profile] = await Promise.all([
      this.db.loadout.findUnique({ where: { userId } }),
      this.db.upgradeLevel.findMany({ where: { userId } }),
      this.db.playerProfile.findUniqueOrThrow({ where: { userId } }),
    ]);
    const level = levelOf(profile.xp);
    const owned = new Set((await this.db.ownedAbility.findMany({ where: { userId } })).map((a) => a.abilityId));
    let loadout = loadoutFromRow(loadoutRow);
    const ownsAll = [loadout.offensive, loadout.defensive, loadout.passive].every((id) => owned.has(id) && isAbilityUnlocked(id, level));
    if (!ownsAll || !validateLoadout(loadout, level).ok) loadout = loadoutFromRow(null);
    return { loadout, upgrades: upgradesFromRows(upgradeRows), level };
  }

  private async equipmentIn(tx: Tx, userId: string): Promise<EquipmentView> {
    const [abilities, loadoutRow, upgradeRows] = await Promise.all([
      tx.ownedAbility.findMany({ where: { userId } }),
      tx.loadout.findUnique({ where: { userId } }),
      tx.upgradeLevel.findMany({ where: { userId } }),
    ]);
    return equipmentView(abilities.map((a) => a.abilityId as AbilityId), loadoutFromRow(loadoutRow), upgradesFromRows(upgradeRows));
  }

  private async refreshEquipmentPower(tx: Tx, userId: string): Promise<void> {
    const view = await this.equipmentIn(tx, userId);
    await tx.loadout.update({ where: { userId }, data: { equipmentPower: view.equipmentPower } });
  }

  // ---- Guest progress import ------------------------------------------------------------

  /**
   * One-time import of a LOCAL (unverifiable) save. Policy (see ACCOUNTS.md):
   * imports board unlocks, personal records (marked unverified), settings and
   * a valid preferred loadout. Never imports XP, coins, upgrades, mastery
   * rewards or history, because none of them can be verified.
   */
  async importLocal(userId: string, raw: unknown): Promise<ImportSummary> {
    if (typeof raw !== 'string' || raw.length === 0) throw new ApiError(400, 'empty_save');
    if (raw.length > 512 * 1024) throw new ApiError(413, 'too_large');
    const parsed = parseSave(raw, { now: new Date().toISOString() });
    if (parsed.kind !== 'ok') throw new ApiError(400, parsed.kind === 'empty' ? 'empty_save' : 'invalid_save');
    const local = parsed.progress;
    const saveHash = createHash('sha256').update(raw).digest('hex');

    const records = Object.values(local.boards)
      .filter((b) => b.completions > 0 && getCampaignBoard(b.boardId))
      .map((b) => ({
        userId,
        boardId: b.boardId,
        completions: Math.min(b.completions, 10_000),
        bestScore: b.bestScore > 0 ? Math.min(b.bestScore, 100_000_000) : null,
        bestTimeMs: b.bestTimeMs,
        bestStars: b.bestStars,
      }));

    try {
      return await this.db.$transaction(async (tx) => {
        const profile = await tx.playerProfile.findUniqueOrThrow({ where: { userId } });
        const before = new Set((await tx.boardUnlock.findMany({ where: { userId } })).map((u) => u.boardId));
        await tx.importedRecord.createMany({ data: records, skipDuplicates: true });

        // Unlocks from imported clears count for casual access only.
        const progress = createEmptyProgress(new Date().toISOString());
        progress.xp = profile.xp;
        const verified = await tx.soloBoardProgress.findMany({ where: { userId, completions: { gt: 0 } } });
        for (const r of [...verified, ...records]) progress.boards[r.boardId] = { ...createEmptyBoardProgress(r.boardId), completions: r.completions };
        const unlocked = CAMPAIGN_BOARDS.filter((b) => isBoardUnlocked(b, progress) && !before.has(b.id));
        await tx.boardUnlock.createMany({
          data: unlocked.map((b) => ({ userId, boardId: b.id, boardVersion: b.version, source: 'import' as const })),
          skipDuplicates: true,
        });

        await tx.playerProfile.update({ where: { userId }, data: { settings: { reducedEffects: local.settings.reducedEffects } } });

        const owned = new Set((await tx.ownedAbility.findMany({ where: { userId } })).map((a) => a.abilityId));
        const loadoutOk =
          validateLoadout(local.loadout, levelOf(profile.xp)).ok &&
          [local.loadout.offensive, local.loadout.defensive, local.loadout.passive].every((id) => owned.has(id));
        if (loadoutOk) await tx.loadout.update({ where: { userId }, data: { ...local.loadout } });

        const summary: ImportSummary = {
          boardsUnlocked: unlocked.map((b) => b.id),
          recordsImported: records.length,
          settingsImported: true,
          loadoutImported: loadoutOk,
          notImported: {
            xp: local.xp,
            coins: local.coins,
            upgradeLevels: UPGRADE_IDS.reduce((n, id) => n + local.upgrades[id], 0),
            masteryObjectives: Object.values(local.boards).reduce((n, b) => n + b.mastery.length, 0),
            historyEntries: local.history.length,
          },
        };
        await tx.localImport.create({ data: { userId, saveHash, summary: summary as object } });
        return summary;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, 'already_imported');
      throw err;
    }
  }
}

// ---- helpers ----------------------------------------------------------------------------

export function progressView(xp: number, coins: number): ProgressView {
  const info = levelForXp(xp);
  return { xp, level: info.level, xpIntoLevel: info.xpIntoLevel, xpForNext: info.xpForNext, coins };
}

function clampStars(n: number): StarRating {
  return (n >= 3 ? 3 : n <= 0 ? 0 : n) as StarRating;
}

function upgradesFromRows(rows: { upgradeId: string; level: number }[]): UpgradeLevels {
  const raw: Record<string, number> = {};
  for (const r of rows) raw[r.upgradeId] = r.level;
  return sanitizeUpgradeLevels({ ...NO_UPGRADES, ...raw });
}

function loadoutFromRow(row: { offensive: string; defensive: string; passive: string } | null): Loadout {
  const check = row ? validateLoadout({ offensive: row.offensive, defensive: row.defensive, passive: row.passive }, Number.MAX_SAFE_INTEGER) : null;
  return check?.ok ? check.loadout : { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' };
}

function equipmentView(owned: AbilityId[], loadout: Loadout, upgrades: UpgradeLevels): EquipmentView {
  return {
    ownedAbilities: owned,
    loadout,
    upgrades,
    loadoutPower: loadoutPower(loadout),
    equipmentPower: rateEquipment({ loadout, upgrades }, 'casualUpgrades').power,
  };
}

function boardRow(userId: string, b: BoardProgress, bestTimeTicks: number | null, now: Date) {
  return {
    userId,
    boardId: b.boardId,
    attempts: b.attempts,
    completions: b.completions,
    bestScore: b.completions > 0 ? b.bestScore : null,
    bestTimeTicks,
    bestStars: b.bestStars,
    bestCombo: 0,
    masteryDone: b.mastery,
    firstClearedAt: b.firstClearedAt ? new Date(b.firstClearedAt) : null,
    lastPlayedAt: now,
  };
}
