import {
  ABILITY_DEFINITIONS,
  CAMPAIGN_BOARDS,
  DEFAULT_LOADOUT,
  levelForXp,
  type AbilityId,
} from '@brick-riot/shared';
import type { Db, Prisma } from '../db/client';

export type Tx = Prisma.TransactionClient;

/** The casual matchmaking skill estimate lives in this queue/season. */
export const CASUAL_QUEUE = 'casual';
export const PRESEASON = 'preseason';

/** Abilities unlocked by a player level. */
export function abilitiesForLevel(level: number): AbilityId[] {
  return (Object.keys(ABILITY_DEFINITIONS) as AbilityId[]).filter((id) => ABILITY_DEFINITIONS[id].unlockLevel <= level);
}

/**
 * Creates everything a new account starts with. Idempotent: safe to call on
 * every login, and concurrently.
 */
export async function provisionPlayer(db: Db, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.playerProfile.upsert({ where: { userId }, create: { userId }, update: {} });
    const first = CAMPAIGN_BOARDS[0];
    if (first) {
      await tx.boardUnlock.createMany({
        data: [{ userId, boardId: first.id, boardVersion: first.version, source: 'default' }],
        skipDuplicates: true,
      });
    }
    await grantLevelAbilities(tx, userId, 1);
    await tx.loadout.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_LOADOUT },
      update: {},
    });
    await tx.rating.createMany({ data: [{ userId, queue: CASUAL_QUEUE, seasonId: PRESEASON }], skipDuplicates: true });
  });
}

/** Grants abilities up to `level` (never removes any). */
export async function grantLevelAbilities(tx: Tx, userId: string, level: number): Promise<void> {
  await tx.ownedAbility.createMany({
    data: abilitiesForLevel(level).map((abilityId) => ({ userId, abilityId, source: 'level' })),
    skipDuplicates: true,
  });
}

export const levelOf = (xp: number) => levelForXp(xp).level;
