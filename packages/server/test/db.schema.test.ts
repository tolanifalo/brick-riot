import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationFiles } from '../src/db/client';
import { createTestDatabase, type TestDatabase } from './support/testDb';

/** The committed migrations apply cleanly and enforce the integrity rules. */
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

async function user(id: string) {
  await t.db.user.create({ data: { id, name: id, email: `${id}@example.test` } });
  await t.db.playerProfile.create({ data: { userId: id } });
}

describe('database schema', () => {
  it('applies every committed migration', async () => {
    expect(migrationFiles().length).toBeGreaterThanOrEqual(1);
    expect(await t.db.user.count()).toBe(0);
  });

  it('refuses negative coin balances at the database level', async () => {
    await user('u1');
    await expect(t.db.playerProfile.update({ where: { userId: 'u1' }, data: { coins: { decrement: 1 } } })).rejects.toThrow();
    expect((await t.db.playerProfile.findUniqueOrThrow({ where: { userId: 'u1' } })).coins).toBe(0);
  });

  it('rolls back a whole transaction when one step violates a constraint', async () => {
    await user('u2');
    await t.db.playerProfile.update({ where: { userId: 'u2' }, data: { coins: 100 } });
    await expect(
      t.db.$transaction(async (tx) => {
        await tx.upgradeLevel.create({ data: { userId: 'u2', upgradeId: 'paddleWidth', level: 1 } });
        await tx.playerProfile.update({ where: { userId: 'u2' }, data: { coins: { decrement: 150 } } });
      }),
    ).rejects.toThrow();
    expect(await t.db.upgradeLevel.count({ where: { userId: 'u2' } })).toBe(0);
    expect((await t.db.playerProfile.findUniqueOrThrow({ where: { userId: 'u2' } })).coins).toBe(100);
  });

  it('rejects a second ledger entry with the same idempotency key', async () => {
    await user('u3');
    const entry = { userId: 'u3', currency: 'coins' as const, amount: 5, balanceAfter: 5, type: 'solo_reward' as const, sourceEvent: 'run-1', idempotencyKey: 'run:run-1' };
    await t.db.ledgerEntry.create({ data: entry });
    await expect(t.db.ledgerEntry.create({ data: entry })).rejects.toThrow();
  });

  it('makes finalised matches immutable', async () => {
    const now = new Date();
    await t.db.match.create({
      data: {
        id: 'm1',
        roomId: 'r1',
        mode: 'private',
        devMode: false,
        outcome: 'win',
        reason: 'board_cleared',
        winnerSeat: 'A',
        startTick: 0,
        endTick: 100,
        durationTicks: 14400,
        ticksPerSecond: 120,
        equipmentMode: 'casual',
        replayVerified: true,
        startedAt: now,
        endedAt: now,
        record: {},
      },
    });
    await expect(t.db.match.update({ where: { id: 'm1' }, data: { outcome: 'draw' } })).rejects.toThrow(/finalised/);
    expect((await t.db.match.findUniqueOrThrow({ where: { id: 'm1' } })).outcome).toBe('win');
  });
});
