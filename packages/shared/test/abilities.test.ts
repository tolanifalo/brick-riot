import { describe, expect, it } from 'vitest';
import { AbilityArbiter } from '../src/abilities/arbiter';
import { ABILITY_DEFINITIONS, ABILITY_RULES, secondsToTicks } from '../src/abilities/definitions';
import { buildPlayerConfig } from '../src/abilities/equipment';
import { DEFAULT_LOADOUT, type Loadout } from '../src/abilities/loadout';
import { BALANCE, SIM } from '../src/config/balance';
import type { BoardDefinition } from '../src/levels/schema';
import type { Seat } from '../src/multiplayer/config';
import { stateChecksum } from '../src/sim/checksum';
import { replayRun } from '../src/sim/replay';
import { Simulation } from '../src/sim/simulation';
import type { SimEvent, TickInput } from '../src/sim/types';
import { NO_UPGRADES } from '../src/upgrades/upgrades';
import { testBoard } from './helpers';

const LOCKOUT = secondsToTicks(ABILITY_RULES.openingLockoutSeconds);
const DELAY = ABILITY_RULES.applyDelayTicks;
const IMMUNITY = secondsToTicks(ABILITY_RULES.immunitySeconds);

/** A board with lots of bricks up top and open space below. */
const arena = (): BoardDefinition =>
  testBoard(['RRRRRRRRRR', 'SSSSSSSSSS', 'SSSSSSSSSS'], { grid: { cols: 10, brickHeight: 20, gap: 4, top: 60, sideMargin: 16 } });

const ATTACKER: Loadout = { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' };

/** Two simulations driven through the arbiter exactly like the server engine does. */
class Duel {
  tick = 0;
  readonly sims: Record<Seat, Simulation>;
  readonly arbiter: AbilityArbiter;
  readonly events: Record<Seat, SimEvent[]> = { A: [], B: [] };
  readonly logs: Record<Seat, TickInput[]> = { A: [], B: [] };
  /** Per-seat input override (default: paddle follows the lowest descending ball, launch when serving). */
  policy: Partial<Record<Seat, (sim: Simulation) => TickInput>> = {};

  constructor(loadouts: Partial<Record<Seat, Loadout>> = {}, board: BoardDefinition = arena(), startEnergy?: number) {
    const la = loadouts.A ?? ATTACKER;
    const lb = loadouts.B ?? ATTACKER;
    const config = (l: Loadout) => {
      const cfg = buildPlayerConfig({ loadout: l, upgrades: NO_UPGRADES }, 'casual');
      return startEnergy === undefined ? cfg : { ...cfg, energy: { ...cfg.energy, start: startEnergy } };
    };
    this.sims = {
      A: new Simulation(board, { seed: 3, config: config(la) }),
      B: new Simulation(board, { seed: 4, config: config(lb) }),
    };
    this.arbiter = new AbilityArbiter({ A: la, B: lb });
  }

  private defaultInput(sim: Simulation): TickInput {
    const balls = sim.state.balls.filter((b) => !b.attached);
    const ball = balls.sort((a, b) => b.y - a.y)[0];
    return { targetX: ball ? ball.x : null, axis: 0, launch: sim.state.status === 'ready' };
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.tick++;
      for (const seat of ['A', 'B'] as const) {
        const sim = this.sims[seat];
        const input = this.policy[seat]?.(sim) ?? this.defaultInput(sim);
        const ext = this.arbiter.take(seat, this.tick);
        const full = ext ? { ...input, ext } : input;
        if (!sim.isOver) {
          this.logs[seat].push(full);
          this.events[seat].push(...sim.step(full));
        }
      }
    }
  }

  use(seat: Seat, ability: string) {
    return this.arbiter.request(seat, ability, this.sims, this.tick);
  }

  /** Steps until both sides are past the lockout with energy to spare. */
  ready(energy = 100): void {
    this.step(LOCKOUT + 1);
    for (const s of Object.values(this.sims)) s.state.energy10 = energy * 10;
  }

  land(): void {
    this.step(DELAY + 1);
  }
}

const has = (events: SimEvent[], type: SimEvent['type']) => events.some((e) => e.type === type);

describe('energy', () => {
  it('starts at the configured amount and is earned only from brick damage, destruction and combos', () => {
    const d = new Duel();
    expect(d.sims.A.state.energy10).toBe(ABILITY_RULES.startEnergy * 10);
    // Idle paddle movement earns nothing.
    d.policy.A = (sim) => ({ targetX: (sim.state.tick * 7) % 480, axis: 0, launch: false });
    d.step(240);
    expect(d.sims.A.state.energy10).toBe(ABILITY_RULES.startEnergy * 10);
  });

  it('awards damage, destroy and combo-milestone energy, capped at the maximum', () => {
    const cfg = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES }, 'casual');
    const sim = new Simulation(testBoard(['RSSSSSSSSS']), { seed: 1, config: cfg });
    sim.state.status = 'playing';
    const before = sim.state.energy10;
    const ball = sim.state.balls[0];
    if (!ball) throw new Error('ball');
    Object.assign(ball, { attached: false, x: 40, y: 200, vx: 0, vy: -430 });
    for (let i = 0; i < 30; i++) sim.step({ targetX: null, axis: 0, launch: false });
    // One hit on the reinforced brick: damage energy only.
    expect(sim.state.energy10 - before).toBe(BALANCE.energy.perDamage * 10);
    sim.state.energy10 = 995;
    Object.assign(ball, { x: 40, y: 200, vx: 0, vy: -430 });
    for (let i = 0; i < 30; i++) sim.step({ targetX: null, axis: 0, launch: false });
    expect(sim.state.energy10).toBe(1000);
  });

  it('Energy Accelerator multiplies gains by 1.2', () => {
    const base = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES }, 'casual');
    const fast = buildPlayerConfig({ loadout: { ...DEFAULT_LOADOUT, passive: 'accelerator' }, upgrades: NO_UPGRADES }, 'casual');
    const gain = (cfg: typeof base) => {
      const sim = new Simulation(testBoard(['SSSSSSSSSS']), { seed: 1, config: cfg });
      sim.state.status = 'playing';
      const ball = sim.state.balls[0];
      if (!ball) throw new Error('ball');
      Object.assign(ball, { attached: false, x: 40, y: 200, vx: 0, vy: -430 });
      const start = sim.state.energy10;
      for (let i = 0; i < 30; i++) sim.step({ targetX: null, axis: 0, launch: false });
      return sim.state.energy10 - start;
    };
    expect(gain(fast)).toBe(Math.round(gain(base) * ABILITY_RULES.acceleratorMultiplier));
  });

  it('solo play has no energy rules attached (config unchanged)', () => {
    expect(buildPlayerConfig({ loadout: null, upgrades: NO_UPGRADES }, 'solo')).toBe(BALANCE);
  });
});

describe('arbiter validation', () => {
  it('refuses abilities that are not equipped, malformed names, and anything without enough energy', () => {
    const d = new Duel();
    d.ready(10);
    expect(d.use('A', 'frost')).toMatchObject({ accepted: false, reason: 'not_equipped' });
    expect(d.use('A', 'nuke')).toMatchObject({ accepted: false, reason: 'malformed' });
    expect(d.use('A', 'emp')).toMatchObject({ accepted: false, reason: 'insufficient_energy' });
  });

  it('enforces the opening lockout for attacks but allows defence', () => {
    const d = new Duel();
    d.step(10);
    d.sims.A.state.energy10 = 1000;
    expect(d.use('A', 'emp')).toMatchObject({ accepted: false, reason: 'opening_lockout' });
    expect(d.use('A', 'shield')).toMatchObject({ accepted: true });
  });

  it('rejections cost nothing; acceptance reserves energy so it cannot be double-spent', () => {
    const d = new Duel();
    d.ready(45);
    const before = d.sims.A.state.energy10;
    expect(d.use('A', 'emp').accepted).toBe(true);
    // 45 energy, EMP reserved 40: Shield (35) cannot also be afforded.
    expect(d.use('A', 'shield')).toMatchObject({ accepted: false, reason: 'insufficient_energy' });
    expect(d.use('A', 'emp')).toMatchObject({ accepted: false, reason: 'already_pending' });
    expect(d.sims.A.state.energy10).toBe(before);
    d.land();
    expect(d.sims.A.state.energy10).toBeLessThanOrEqual(before - 400 + 100);
    expect(has(d.events.A, 'abilityUsed')).toBe(true);
  });

  it('enforces cooldowns', () => {
    const d = new Duel();
    d.ready();
    d.use('A', 'shield');
    d.land();
    d.sims.A.state.energy10 = 1000;
    expect(d.use('A', 'shield')).toMatchObject({ accepted: false });
    d.step(secondsToTicks(ABILITY_DEFINITIONS.shield.cooldownSeconds));
    d.sims.A.state.shieldUntil = 0;
    expect(d.use('A', 'shield').accepted).toBe(true);
  });

  it('refuses attacks on a target that is waiting to launch', () => {
    const d = new Duel();
    d.policy.B = () => ({ targetX: null, axis: 0, launch: false });
    d.ready();
    expect(d.sims.B.state.status).toBe('ready');
    expect(d.use('A', 'emp')).toMatchObject({ accepted: false, reason: 'target_awaiting_launch' });
  });
});

describe('EMP Pulse', () => {
  it('suspends paddle power-ups for 2 s without touching movement, then restores them and grants immunity', () => {
    const d = new Duel();
    d.ready();
    const b = d.sims.B.state;
    b.effects.wide = 1000;
    b.effects.laser = 1000;
    d.step(2);
    const wide = b.paddle.width;
    expect(wide).toBeGreaterThan(BALANCE.paddle.width);
    expect(d.use('A', 'emp')).toMatchObject({ accepted: true, blocked: false });
    d.land();
    // Wait out any safety deferral, then check the jam.
    for (let i = 0; i < 240 && b.debuff?.phase !== 'active'; i++) d.step();
    expect(b.debuff).toMatchObject({ kind: 'emp', phase: 'active' });
    d.step(1);
    expect(b.paddle.width).toBe(BALANCE.paddle.width);
    const wideLeft = b.effects.wide;
    d.step(30);
    expect(b.effects.wide).toBe(wideLeft); // paused, not drained
    // Movement still works while jammed.
    const x = b.paddle.x;
    d.policy.B = () => ({ targetX: x > 240 ? 60 : 420, axis: 0, launch: false });
    d.step(10);
    expect(b.paddle.x).not.toBe(x);
    d.policy.B = undefined;
    d.step(secondsToTicks(2));
    expect(b.debuff).toBeNull();
    expect(b.paddle.width).toBe(wide);
    expect(b.immuneUntil).toBeGreaterThan(d.tick);
    expect(d.events.B.some((e) => e.type === 'debuffEnded' && e.reason === 'expired')).toBe(true);
  });

  it('immunity refuses new attacks until it ends', () => {
    const d = new Duel();
    d.ready();
    d.use('A', 'emp');
    d.land();
    d.step(secondsToTicks(4));
    expect(d.sims.B.state.debuff).toBeNull();
    d.sims.A.state.cooldowns.emp = 0;
    expect(d.use('A', 'emp')).toMatchObject({ accepted: false, reason: 'target_immune' });
    d.step(IMMUNITY);
    expect(d.use('A', 'emp').accepted).toBe(true);
  });
});

describe('Shrink Ray', () => {
  const shrinker: Loadout = { offensive: 'shrink', defensive: 'cleanse', passive: 'quickRelaunch' };

  it('shrinks the paddle 15% for 3 s and restores it exactly', () => {
    const d = new Duel({ A: shrinker });
    d.ready();
    const b = d.sims.B.state;
    const width = b.paddle.width;
    expect(d.use('A', 'shrink').accepted).toBe(true);
    d.land();
    for (let i = 0; i < 240 && b.debuff?.phase !== 'active'; i++) d.step();
    d.step(1);
    expect(b.paddle.width).toBeCloseTo(width * ABILITY_RULES.shrinkFactor, 9);
    d.step(secondsToTicks(3));
    expect(b.paddle.width).toBe(width);
  });

  it('waits for a safe moment: never shrinks while a ball is about to reach the paddle', () => {
    const d = new Duel({ A: shrinker });
    d.ready();
    const b = d.sims.B;
    d.use('A', 'shrink');
    d.step(DELAY);
    // Put B's ball just above the paddle, descending.
    const ball = b.state.balls.find((x) => !x.attached);
    if (!ball) throw new Error('ball');
    Object.assign(ball, { x: b.state.paddle.x, y: b.state.paddle.y - 60, vx: 0, vy: 430 });
    d.step(1);
    expect(b.state.debuff).toMatchObject({ kind: 'shrink', phase: 'pending' });
    expect(b.state.paddle.width).toBe(BALANCE.paddle.width);
  });

  it('never goes below the safe minimum width', () => {
    const cfg = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES }, 'casual');
    const sim = new Simulation(arena(), { seed: 1, config: { ...cfg, paddle: { ...cfg.paddle, width: 64 } } });
    sim.step({ targetX: null, axis: 0, launch: false, ext: [{ k: 'debuff', kind: 'shrink', ticks: 300, immunityTicks: 0, factor: 0.5, hp: 0 }] });
    sim.step({ targetX: null, axis: 0, launch: false });
    expect(sim.state.paddle.width).toBe(cfg.sabotage.minPaddleWidth);
  });
});

describe('Frost Brick', () => {
  const froster: Loadout = { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' };

  it('spawns a 2-hit obstacle in open space below every brick, never required, clear of balls', () => {
    const d = new Duel({ A: froster });
    d.ready();
    const b = d.sims.B.state;
    const required = b.requiredRemaining;
    expect(d.use('A', 'frost').accepted).toBe(true);
    d.land();
    const frost = b.bricks.find((x) => x.type === 'frost');
    expect(frost).toBeDefined();
    if (!frost) return;
    expect(frost).toMatchObject({ required: false, hp: 2 });
    expect(b.requiredRemaining).toBe(required);
    const lowestBrick = Math.max(...b.bricks.filter((x) => x.type !== 'frost').map((x) => x.y + x.height));
    expect(frost.y).toBeGreaterThan(lowestBrick);
    expect(frost.y + frost.height).toBeLessThanOrEqual(b.paddle.y - BALANCE.sabotage.frostMinClearance);
    for (const ball of b.balls) {
      const inside = ball.x > frost.x && ball.x < frost.x + frost.width && ball.y > frost.y && ball.y < frost.y + frost.height;
      expect(inside).toBe(false);
    }
  });

  it('expires after 5 s and then grants immunity', () => {
    const d = new Duel({ A: froster });
    d.ready();
    d.use('A', 'frost');
    d.land();
    const frost = d.sims.B.state.bricks.find((x) => x.type === 'frost');
    d.step(secondsToTicks(5) + 2);
    expect(frost?.alive).toBe(false);
    expect(d.sims.B.state.debuff).toBeNull();
    expect(d.sims.B.state.immuneUntil).toBeGreaterThan(d.tick);
  });

  it('shatters after two hits without awarding score, combo or energy', () => {
    const d = new Duel({ A: froster });
    d.ready();
    d.use('A', 'frost');
    d.land();
    const b = d.sims.B;
    const frost = b.state.bricks.find((x) => x.type === 'frost');
    if (!frost) throw new Error('no frost');
    const score = b.state.score;
    const energy = b.state.energy10;
    for (let hit = 0; hit < 2; hit++) {
      const ball = b.state.balls.find((x) => !x.attached);
      if (!ball) throw new Error('ball');
      Object.assign(ball, { x: frost.x + frost.width / 2, y: frost.y + frost.height + 20, vx: 0, vy: -430 });
      b.step({ targetX: null, axis: 0, launch: false });
      b.step({ targetX: null, axis: 0, launch: false });
      b.step({ targetX: null, axis: 0, launch: false });
      b.step({ targetX: null, axis: 0, launch: false });
      b.step({ targetX: null, axis: 0, launch: false });
      b.step({ targetX: null, axis: 0, launch: false });
    }
    expect(frost.alive).toBe(false);
    expect(b.state.debuff).toBeNull();
    expect(b.state.score).toBe(score);
    expect(b.state.energy10).toBe(energy);
  });

  it('is refused (free) when the target board has no open space', () => {
    const full = testBoard(
      ['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS'],
      { grid: { cols: 10, brickHeight: 20, gap: 4, top: 20, sideMargin: 16 } },
    );
    const d = new Duel({ A: froster }, full);
    d.ready();
    const energy = d.sims.A.state.energy10;
    expect(d.use('A', 'frost')).toMatchObject({ accepted: false, reason: 'no_space' });
    d.land();
    expect(d.sims.A.state.energy10).toBeGreaterThanOrEqual(energy);
    expect(d.sims.A.state.cooldowns.frost).toBe(0);
  });
});

describe('Shield and Cleanse', () => {
  it('Shield blocks the next attack: attacker pays, shield is consumed, no debuff', () => {
    const d = new Duel();
    d.ready();
    expect(d.use('B', 'shield').accepted).toBe(true);
    d.land();
    expect(d.sims.B.state.shieldUntil).toBeGreaterThan(d.tick);
    const energy = d.sims.A.state.energy10;
    expect(d.use('A', 'emp')).toMatchObject({ accepted: true, blocked: true });
    d.land();
    expect(d.sims.B.state.debuff).toBeNull();
    expect(d.sims.B.state.shieldUntil).toBe(0);
    expect(has(d.events.B, 'attackBlocked')).toBe(true);
    expect(d.sims.A.state.energy10).toBeLessThan(energy);
    expect(d.sims.A.state.cooldowns.emp).toBeGreaterThan(d.tick);
  });

  it('a shield requested before an attack blocks it even if it rises later in the same window', () => {
    const d = new Duel();
    d.ready();
    d.use('B', 'shield');
    d.step(5);
    expect(d.use('A', 'emp')).toMatchObject({ accepted: true, blocked: true });
  });

  it('one shield blocks only one attack', () => {
    const shrinker: Loadout = { offensive: 'shrink', defensive: 'shield', passive: 'quickRelaunch' };
    const d = new Duel({ A: ATTACKER, B: shrinker });
    d.ready();
    d.use('B', 'shield');
    d.land();
    expect(d.use('A', 'emp')).toMatchObject({ blocked: true });
    // While that block is pending, the shield is already promised.
    const second = new Duel();
    second.ready();
    second.use('B', 'shield');
    second.land();
    second.use('A', 'emp');
    second.sims.A.state.cooldowns.emp = 0;
    expect(second.use('A', 'emp')).toMatchObject({ accepted: false, reason: 'already_pending' });
  });

  it('Cleanse removes the active debuff, restores the paddle and starts immunity', () => {
    const shrinker: Loadout = { offensive: 'shrink', defensive: 'cleanse', passive: 'quickRelaunch' };
    const d = new Duel({ A: shrinker, B: { offensive: 'emp', defensive: 'cleanse', passive: 'quickRelaunch' } });
    d.ready();
    const width = d.sims.B.state.paddle.width;
    d.use('A', 'shrink');
    d.land();
    for (let i = 0; i < 240 && d.sims.B.state.debuff?.phase !== 'active'; i++) d.step();
    d.step(1);
    expect(d.sims.B.state.paddle.width).toBeLessThan(width);
    expect(d.use('B', 'cleanse').accepted).toBe(true);
    d.land();
    expect(d.sims.B.state.debuff).toBeNull();
    expect(d.sims.B.state.paddle.width).toBe(width);
    expect(d.events.B.some((e) => e.type === 'debuffEnded' && e.reason === 'cleansed')).toBe(true);
    expect(d.sims.B.state.immuneUntil).toBeGreaterThan(d.tick);
  });

  it('Cleanse with nothing to remove is refused and free', () => {
    const d = new Duel({ B: { offensive: 'emp', defensive: 'cleanse', passive: 'quickRelaunch' } });
    d.ready();
    const energy = d.sims.B.state.energy10;
    expect(d.use('B', 'cleanse')).toMatchObject({ accepted: false, reason: 'nothing_to_cleanse' });
    expect(d.sims.B.state.energy10).toBe(energy);
  });

  it('a target already under (or about to receive) a debuff cannot be attacked again', () => {
    const d = new Duel();
    d.ready();
    d.use('A', 'emp');
    const b = new Duel();
    b.ready();
    // B attacks A while A attacks B: both resolve independently (different targets).
    expect(b.use('A', 'emp').accepted).toBe(true);
    expect(b.use('B', 'emp').accepted).toBe(true);
    b.sims.A.state.cooldowns.emp = 0;
    expect(d.use('A', 'emp')).toMatchObject({ accepted: false });
  });
});

describe('relaunch delay and passives', () => {
  it('after a lost ball, launch is refused for 1 s (0.5 s with Quick Relaunch)', () => {
    const delayFor = (loadout: Loadout) => {
      const cfg = buildPlayerConfig({ loadout, upgrades: NO_UPGRADES }, 'casual');
      const sim = new Simulation(arena(), { seed: 2, config: cfg });
      sim.step({ targetX: null, axis: 0, launch: true });
      const ball = sim.state.balls[0];
      if (!ball) throw new Error('ball');
      Object.assign(ball, { x: 30, y: SIM.worldHeight - 3, vx: 0, vy: 430 });
      for (let i = 0; i < 10 && sim.state.status !== 'ready'; i++) sim.step({ targetX: 400, axis: 0, launch: false });
      expect(sim.state.status).toBe('ready');
      let waited = 0;
      while (sim.state.status === 'ready' && waited < 1000) {
        sim.step({ targetX: null, axis: 0, launch: true });
        waited++;
      }
      return waited;
    };
    const slow = delayFor({ ...DEFAULT_LOADOUT, passive: 'precision' });
    const quick = delayFor(DEFAULT_LOADOUT);
    expect(slow).toBe(secondsToTicks(ABILITY_RULES.relaunchDelaySeconds));
    expect(quick).toBe(secondsToTicks(ABILITY_RULES.quickRelaunchSeconds));
  });

  it('Precision Aim sends the same contact offset out at a wider angle', () => {
    const angle = (passive: Loadout['passive']) => {
      const cfg = buildPlayerConfig({ loadout: { ...DEFAULT_LOADOUT, passive }, upgrades: NO_UPGRADES }, 'casual');
      const sim = new Simulation(arena(), { seed: 2, config: cfg });
      sim.state.status = 'playing';
      const ball = sim.state.balls[0];
      if (!ball) throw new Error('ball');
      Object.assign(ball, { attached: false, x: sim.state.paddle.x + 20, y: sim.state.paddle.y - 40, vx: 0, vy: 430 });
      for (let i = 0; i < 20; i++) sim.step({ targetX: null, axis: 0, launch: false });
      return Math.abs(ball.vx / ball.vy);
    };
    expect(angle('precision')).toBeGreaterThan(angle('quickRelaunch') * 1.1);
  });
});

describe('determinism with abilities', () => {
  it('replays each applied log (including server commands) to the identical state', () => {
    // Natural energy only (no manual state edits), so the logs are complete.
    const d = new Duel({ A: { offensive: 'frost', defensive: 'shield', passive: 'accelerator' } }, arena(), 100);
    d.step(LOCKOUT + 1);
    expect(d.use('B', 'shield').accepted).toBe(true);
    d.step(60);
    expect(d.use('A', 'frost')).toMatchObject({ accepted: true, blocked: true });
    d.step(DELAY + 900);
    expect(has(d.events.B, 'attackBlocked')).toBe(true);
    for (const seat of ['A', 'B'] as const) {
      const replayed = replayRun(d.sims[seat].board, seat === 'A' ? 3 : 4, d.logs[seat], d.sims[seat].config);
      expect(stateChecksum(replayed)).toBe(stateChecksum(d.sims[seat].state));
    }
  });
});
