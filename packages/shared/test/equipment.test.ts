import { describe, expect, it } from 'vitest';
import { ABILITY_RULES } from '../src/abilities/definitions';
import {
  buildPlayerConfig,
  CASUAL_UPGRADE_POWER_CAP,
  compareEquipment,
  effectiveUpgrades,
  rateEquipment,
} from '../src/abilities/equipment';
import { DEFAULT_LOADOUT, loadoutPower, validateLoadout } from '../src/abilities/loadout';
import { BALANCE } from '../src/config/balance';
import { createEmptyProgress, MIGRATIONS, parseSave, SAVE_FORMAT, serializeProgress } from '../src/progress/save';
import { Simulation } from '../src/sim/simulation';
import {
  maxLevel,
  NO_UPGRADES,
  purchaseUpgrade,
  UPGRADE_IDS,
  UPGRADES,
  upgradeEffect,
  type UpgradeLevels,
} from '../src/upgrades/upgrades';
import { testBoard } from './helpers';

const MAXED: UpgradeLevels = { paddleControl: 5, paddleWidth: 5, ballPower: 3, magnetDuration: 3, startingEnergy: 4 };

describe('loadouts', () => {
  it('the default beginner loadout is valid at level 1', () => {
    expect(validateLoadout(DEFAULT_LOADOUT, 1)).toEqual({ ok: true, loadout: DEFAULT_LOADOUT });
    expect(loadoutPower(DEFAULT_LOADOUT)).toBeLessThanOrEqual(ABILITY_RULES.loadoutBudget);
  });

  it('rejects malformed loadouts and abilities in the wrong slot', () => {
    expect(validateLoadout(null, 99)).toEqual({ ok: false, error: 'malformed' });
    expect(validateLoadout({ offensive: 'shield', defensive: 'emp', passive: 'precision' }, 99)).toEqual({ ok: false, error: 'wrong_slot' });
    expect(validateLoadout({ offensive: 'emp', defensive: 'shield' }, 99)).toEqual({ ok: false, error: 'malformed' });
  });

  it('enforces unlock levels except in dev rooms', () => {
    const frost = { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' };
    expect(validateLoadout(frost, 1)).toEqual({ ok: false, error: 'locked' });
    expect(validateLoadout(frost, 5).ok).toBe(true);
    expect(validateLoadout(frost, 1, { ignoreUnlocks: true }).ok).toBe(true);
  });

  it('enforces the power budget, even in dev rooms', () => {
    const heavy = { offensive: 'frost', defensive: 'shield', passive: 'accelerator' }; // 40 + 25 + 25 = 90
    expect(validateLoadout(heavy, 99)).toEqual({ ok: false, error: 'over_budget' });
    expect(validateLoadout(heavy, 99, { ignoreUnlocks: true })).toEqual({ ok: false, error: 'over_budget' });
  });
});

describe('upgrades', () => {
  it('every upgrade has rising costs and diminishing, capped effects', () => {
    for (const id of UPGRADE_IDS) {
      const u = UPGRADES[id];
      expect(u.costs.length).toBe(u.effects.length);
      for (let i = 1; i < u.costs.length; i++) {
        expect(u.costs[i]).toBeGreaterThan(u.costs[i - 1] ?? 0);
        const step = (u.effects[i] ?? 0) - (u.effects[i - 1] ?? 0);
        const prev = (u.effects[i - 1] ?? 0) - (i >= 2 ? (u.effects[i - 2] ?? 0) : 0);
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThanOrEqual(prev + 1e-9);
      }
      expect(upgradeEffect(id, 99)).toBe(u.effects[u.effects.length - 1]);
    }
  });

  it('buys one level atomically and rejects insufficient coins, max level and stale double-submits', () => {
    const p = createEmptyProgress('t');
    p.coins = 200;
    expect(purchaseUpgrade(p, 'paddleWidth', 0)).toMatchObject({ ok: true, cost: 150, level: 1 });
    const bought = purchaseUpgrade(p, 'paddleWidth', 0);
    if (!bought.ok) throw new Error('purchase failed');
    expect(bought.progress.coins).toBe(50);
    expect(bought.progress.upgrades.paddleWidth).toBe(1);
    expect(p.coins).toBe(200); // input untouched
    // A second submit for the same level (double click) is refused.
    expect(purchaseUpgrade(bought.progress, 'paddleWidth', 0)).toEqual({ ok: false, error: 'stale_level' });
    expect(purchaseUpgrade(bought.progress, 'paddleWidth', 1)).toEqual({ ok: false, error: 'insufficient_coins' });
    expect(purchaseUpgrade(bought.progress, 'nope', 0)).toEqual({ ok: false, error: 'unknown_upgrade' });
    const maxed = { ...bought.progress, coins: 1e6, upgrades: { ...NO_UPGRADES, magnetDuration: maxLevel('magnetDuration') } };
    expect(purchaseUpgrade(maxed, 'magnetDuration', 3)).toEqual({ ok: false, error: 'max_level' });
  });

  it('coins never go negative', () => {
    const p = createEmptyProgress('t');
    p.coins = 149;
    expect(purchaseUpgrade(p, 'paddleWidth', 0).ok).toBe(false);
  });

  it('upgrades change the actual simulation config in solo', () => {
    const cfg = buildPlayerConfig({ loadout: null, upgrades: MAXED }, 'solo');
    expect(cfg.paddle.width).toBeCloseTo(BALANCE.paddle.width * 1.1, 9);
    expect(cfg.paddle.keyboardSpeed).toBeCloseTo(BALANCE.paddle.keyboardSpeed * 1.2, 9);
    expect(cfg.ball.armorCharge).toBe(0.36);
    expect(cfg.powerUps.definitions.magnet.durationSeconds).toBe(BALANCE.powerUps.definitions.magnet.durationSeconds + 4.5);
    // BALANCE itself is never mutated.
    expect(BALANCE.paddle.width).toBe(88);
    const sim = new Simulation(testBoard(['S']), { config: cfg });
    expect(sim.state.paddle.width).toBeCloseTo(96.8, 9);
  });

  it('Ball Power adds bonus damage to multi-hit bricks deterministically', () => {
    const hits = (upgrades: UpgradeLevels) => {
      const sim = new Simulation(testBoard(['RRRRRRRRRR']), { seed: 1, config: buildPlayerConfig({ loadout: null, upgrades }, 'solo') });
      sim.state.status = 'playing';
      let contacts = 0;
      const brick = sim.state.bricks[4];
      const ball = sim.state.balls[0];
      if (!brick || !ball) throw new Error('setup');
      ball.attached = false;
      while (brick.alive && contacts < 10) {
        Object.assign(ball, { x: brick.x + brick.width / 2, y: brick.y + 60, vx: 0, vy: -430 });
        for (let i = 0; i < 30; i++) sim.step({ targetX: null, axis: 0, launch: false });
        contacts++;
      }
      return contacts;
    };
    expect(hits(NO_UPGRADES)).toBe(2);
    // Level 3 (0.36 charge per hit) never needs more contacts and sometimes fewer.
    expect(hits({ ...NO_UPGRADES, ballPower: 3 })).toBeLessThanOrEqual(2);
  });

  it('starting energy applies in multiplayer, capped at the maximum', () => {
    const cfg = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: MAXED }, 'casualUpgrades');
    expect(cfg.energy.start).toBeGreaterThan(ABILITY_RULES.startEnergy);
    expect(cfg.energy.start).toBeLessThanOrEqual(ABILITY_RULES.maxEnergy);
  });
});

describe('equipment policy by mode', () => {
  it('casual multiplayer ignores upgrades entirely; ranked too', () => {
    const casual = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: MAXED }, 'casual');
    expect(casual.paddle.width).toBe(BALANCE.paddle.width);
    expect(buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: MAXED }, 'ranked').paddle.width).toBe(BALANCE.paddle.width);
    expect(effectiveUpgrades(MAXED, 'ranked')).toEqual(NO_UPGRADES);
  });

  it('casual upgrade rooms trim upgrades to the power cap', () => {
    const trimmed = effectiveUpgrades(MAXED, 'casualUpgrades');
    const rating = rateEquipment({ loadout: null, upgrades: MAXED }, 'casualUpgrades');
    expect(rating.power).toBeLessThanOrEqual(CASUAL_UPGRADE_POWER_CAP);
    expect(Object.values(trimmed).some((v) => v > 0)).toBe(true);
  });
});

describe('Equipment Power Rating', () => {
  it('is computed only from definitions (loadout + applicable upgrades), never XP', () => {
    const r = rateEquipment({ loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES }, 'casual');
    expect(r.power).toBe(loadoutPower(DEFAULT_LOADOUT));
    expect(r.verified).toBe(false);
    const withUpgrades = rateEquipment({ loadout: DEFAULT_LOADOUT, upgrades: MAXED }, 'casualUpgrades');
    expect(withUpgrades.power).toBeGreaterThan(r.power);
    // In a casual (no-upgrade) room the same upgrades add nothing.
    expect(rateEquipment({ loadout: DEFAULT_LOADOUT, upgrades: MAXED }, 'casual').power).toBe(r.power);
  });

  it('flags uneven equipment, and never calls unverified gear ranked-eligible', () => {
    const light = rateEquipment({ loadout: { offensive: 'emp', defensive: 'cleanse', passive: 'quickRelaunch' }, upgrades: NO_UPGRADES }, 'casualUpgrades');
    const heavy = rateEquipment({ loadout: { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' }, upgrades: MAXED }, 'casualUpgrades');
    const cmp = compareEquipment(light, heavy);
    expect(cmp.even).toBe(false);
    expect(cmp.gap).toBe(heavy.power - light.power);
    expect(compareEquipment(light, light)).toMatchObject({ even: true, rankedEligible: false });
  });
});

describe('save format v2', () => {
  it('migrates a Phase 2/3 (v1) save, keeping progress and adding defaults', () => {
    const v1 = JSON.stringify({
      format: SAVE_FORMAT,
      version: 1,
      savedAt: 't',
      data: { xp: 900, coins: 333, boards: {}, history: [], appliedRunIds: ['r1'] },
    });
    const result = parseSave(v1);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.migratedFrom).toBe(1);
    expect(result.progress).toMatchObject({ version: 2, xp: 900, coins: 333, appliedRunIds: ['r1'] });
    expect(result.progress.upgrades).toEqual(NO_UPGRADES);
    expect(result.progress.loadout).toEqual(DEFAULT_LOADOUT);
    expect(result.progress.settings.reducedEffects).toBe(false);
    expect(typeof MIGRATIONS[1]).toBe('function');
  });

  it('persists upgrades, loadout and settings, and repairs tampered values', () => {
    const p = createEmptyProgress('t');
    p.upgrades = { ...NO_UPGRADES, paddleWidth: 3 };
    p.loadout = { offensive: 'shrink', defensive: 'cleanse', passive: 'precision' };
    p.settings.reducedEffects = true;
    const back = parseSave(serializeProgress(p, 't'));
    expect(back.kind === 'ok' && back.progress.upgrades.paddleWidth).toBe(3);
    expect(back.kind === 'ok' && back.progress.loadout).toEqual(p.loadout);
    expect(back.kind === 'ok' && back.progress.settings.reducedEffects).toBe(true);

    const tampered = JSON.parse(serializeProgress(p, 't')) as { data: Record<string, unknown> };
    tampered.data['upgrades'] = { paddleWidth: 999, ballPower: -4 };
    tampered.data['loadout'] = { offensive: 'frost', defensive: 'shield', passive: 'accelerator' }; // over budget
    const repaired = parseSave(JSON.stringify(tampered));
    if (repaired.kind !== 'ok') throw new Error(repaired.kind);
    expect(repaired.progress.upgrades.paddleWidth).toBe(maxLevel('paddleWidth'));
    expect(repaired.progress.upgrades.ballPower).toBe(0);
    expect(repaired.progress.loadout).toEqual(DEFAULT_LOADOUT);
  });
});
