import { sanitizeName, type Loadout, type UpgradeLevels } from '@brick-riot/shared';
import type { Services } from '../services';

/** Server-verified facts about the account behind a seat (loaded at join time). */
export interface SeatAccount {
  userId: string;
  name: string;
  level: number;
  unlockedBoardIds: string[];
  ownedAbilities: string[];
  loadout: Loadout;
  upgrades: UpgradeLevels;
}

/** Loads everything a match needs about an account, from the database only. */
export async function loadSeatAccount(services: Services, userId: string): Promise<SeatAccount | null> {
  const { db, progression } = services;
  if (!db || !progression) return null;
  const user = await db.user.findFirst({
    where: { id: userId, status: 'active' },
    select: { name: true, boardUnlocks: { select: { boardId: true } }, abilities: { select: { abilityId: true } } },
  });
  if (!user) return null;
  const equipment = await progression.verifiedEquipment(userId);
  return {
    userId,
    name: sanitizeName(user.name),
    level: equipment.level,
    unlockedBoardIds: user.boardUnlocks.map((u) => u.boardId),
    ownedAbilities: user.abilities.map((a) => a.abilityId),
    loadout: equipment.loadout ?? { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' },
    upgrades: equipment.upgrades,
  };
}
