import { otherSeat, SEATS, type Seat } from '../multiplayer/config';
import type { Simulation } from '../sim/simulation';
import type { ExternalCommand } from '../sim/types';
import {
  ABILITY_DEFINITIONS,
  ABILITY_RULES,
  isActiveAbility,
  isOffensive,
  secondsToTicks,
  type ActiveAbility,
  type OffensiveAbility,
} from './definitions';
import type { Loadout } from './loadout';

export type AbilityRejectReason =
  | 'malformed'
  | 'duplicate_seq'
  | 'rate_limited'
  | 'not_equipped'
  | 'not_playing'
  | 'insufficient_energy'
  | 'cooldown'
  | 'already_pending'
  | 'opening_lockout'
  | 'target_finished'
  | 'target_awaiting_launch'
  | 'target_debuffed'
  | 'target_immune'
  | 'no_space'
  | 'already_active'
  | 'nothing_to_cleanse';

export interface AbilityDecision {
  seat: Seat;
  ability: ActiveAbility;
  accepted: boolean;
  reason?: AbilityRejectReason;
  /** Tick at which the effects apply (accepted only). */
  applyTick?: number;
  /** Offensive and accepted: the target's Shield absorbed it. */
  blocked?: boolean;
}

interface Scheduled {
  tick: number;
  command: ExternalCommand;
}

/**
 * Server-authoritative ability arbiter. Every activation is checked here
 * against both players' simulation states plus everything already
 * scheduled, then turned into mechanical commands applied `applyDelayTicks`
 * later. Only the commands enter the simulations (and their replay logs).
 *
 * Interaction rules (tested; see GAME_DESIGN.md):
 * - Rejected requests cost nothing (no energy, no cooldown).
 * - Offensive: refused during the opening lockout, if the attacker has no
 *   balls left or the match is over for either side, if the target is waiting
 *   to launch, already has (or is about to get) a debuff, or is immune when
 *   it would land. Frost also needs open space on the target's board.
 * - Shield: if the target's shield is up when the attack lands (including a
 *   shield scheduled to rise before then), the attack is BLOCKED. The attacker
 *   still pays energy and cooldown; the shield is consumed.
 * - Cleanse: only if a debuff will still be active when it applies.
 * - Order: requests are resolved in the order given (the server sorts each
 *   batch by request tick, then seat A before B).
 */
export class AbilityArbiter {
  private readonly scheduled: Record<Seat, Scheduled[]> = { A: [], B: [] };

  constructor(
    private readonly loadouts: Record<Seat, Loadout>,
    private readonly rules = ABILITY_RULES,
  ) {}

  /** Resolves one request at match tick `now` (both simulations are at `now`). */
  request(seat: Seat, ability: unknown, sims: Record<Seat, Simulation>, now: number): AbilityDecision {
    if (!isActiveAbility(ability)) return { seat, ability: 'emp', accepted: false, reason: 'malformed' };
    const reject = (reason: AbilityRejectReason): AbilityDecision => ({ seat, ability, accepted: false, reason });
    const loadout = this.loadouts[seat];
    if (loadout.offensive !== ability && loadout.defensive !== ability) return reject('not_equipped');

    const self = sims[seat];
    const s = self.state;
    if (self.isOver) return reject('not_playing');
    const def = ABILITY_DEFINITIONS[ability];
    const cost10 = def.energyCost * 10;
    const applyTick = now + this.rules.applyDelayTicks;
    if (this.pending(seat).some((p) => p.command.k === 'spend' && p.command.ability === ability)) return reject('already_pending');
    if (s.cooldowns[ability] > now) return reject('cooldown');
    if (s.energy10 - this.reserved(seat) < cost10) return reject('insufficient_energy');

    const spend: ExternalCommand = {
      k: 'spend',
      ability,
      cost10,
      readyTick: applyTick + secondsToTicks(def.cooldownSeconds),
    };

    if (isOffensive(ability)) {
      if (now < secondsToTicks(this.rules.openingLockoutSeconds)) return reject('opening_lockout');
      const target = otherSeat(seat);
      const t = sims[target];
      const ts = t.state;
      if (t.isOver) return reject('target_finished');
      if (ts.status === 'ready') return reject('target_awaiting_launch');
      if (ts.debuff !== null || this.pending(target).some((p) => p.command.k === 'debuff')) return reject('target_debuffed');
      if (ts.immuneUntil > applyTick) return reject('target_immune');
      if (ability === 'frost' && t.frostCell() === null) return reject('no_space');

      const blocked = this.shieldUpAt(target, ts.shieldUntil, applyTick);
      this.schedule(seat, applyTick, spend);
      this.schedule(target, applyTick, blocked ? { k: 'block', ability } : this.debuffCommand(ability));
      return { seat, ability, accepted: true, applyTick, blocked };
    }

    if (ability === 'shield') {
      if (this.shieldUpAt(seat, s.shieldUntil, applyTick) || this.pending(seat).some((p) => p.command.k === 'shield')) {
        return reject('already_active');
      }
      this.schedule(seat, applyTick, spend);
      this.schedule(seat, applyTick, { k: 'shield', untilTick: applyTick + secondsToTicks(def.durationSeconds) });
      return { seat, ability, accepted: true, applyTick };
    }

    // Cleanse: a debuff must still be active when it lands.
    const d = s.debuff;
    const activeUntil = d ? (d.phase === 'active' ? now + d.remaining : Number.POSITIVE_INFINITY) : -1;
    const incoming = this.pending(seat).some((p) => p.command.k === 'debuff' && p.tick <= applyTick);
    if (!(activeUntil > applyTick || incoming)) return reject('nothing_to_cleanse');
    this.schedule(seat, applyTick, spend);
    this.schedule(seat, applyTick, { k: 'cleanse', immunityTicks: secondsToTicks(this.rules.immunitySeconds) });
    return { seat, ability, accepted: true, applyTick };
  }

  private debuffCommand(ability: OffensiveAbility): ExternalCommand {
    const def = ABILITY_DEFINITIONS[ability];
    return {
      k: 'debuff',
      kind: ability,
      ticks: secondsToTicks(def.durationSeconds),
      immunityTicks: secondsToTicks(this.rules.immunitySeconds),
      factor: ability === 'shrink' ? this.rules.shrinkFactor : 1,
      hp: ability === 'frost' ? this.rules.frostHp : 0,
    };
  }

  /** Is `seat`'s shield up at `tick`, and not already promised to block another attack? */
  private shieldUpAt(seat: Seat, shieldUntil: number, tick: number): boolean {
    const pending = this.pending(seat);
    if (pending.some((p) => p.command.k === 'block')) return false;
    const scheduledShield = pending.find((p) => p.command.k === 'shield' && p.tick <= tick);
    const until = scheduledShield && scheduledShield.command.k === 'shield' ? scheduledShield.command.untilTick : shieldUntil;
    return until > tick;
  }

  private schedule(seat: Seat, tick: number, command: ExternalCommand): void {
    this.scheduled[seat].push({ tick, command });
  }

  private pending(seat: Seat): Scheduled[] {
    return this.scheduled[seat];
  }

  /** Energy already promised to scheduled (not yet applied) activations. */
  private reserved(seat: Seat): number {
    return this.scheduled[seat].reduce((n, p) => n + (p.command.k === 'spend' ? p.command.cost10 : 0), 0);
  }

  /** Removes and returns the commands for `seat` at `tick`, in scheduling order. */
  take(seat: Seat, tick: number): ExternalCommand[] | undefined {
    const list = this.scheduled[seat];
    const due = list.filter((p) => p.tick === tick).map((p) => p.command);
    if (due.length === 0) return undefined;
    this.scheduled[seat] = list.filter((p) => p.tick !== tick);
    return due;
  }

  /** Not-yet-applied commands for a seat (sent to a client on resync). */
  upcoming(seat: Seat): { tick: number; commands: ExternalCommand[] }[] {
    const byTick = new Map<number, ExternalCommand[]>();
    for (const p of this.scheduled[seat]) byTick.set(p.tick, [...(byTick.get(p.tick) ?? []), p.command]);
    return [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, commands]) => ({ tick, commands }));
  }

  /** Drops everything scheduled for a player whose simulation has ended. */
  clear(seat: Seat): void {
    this.scheduled[seat] = [];
  }

  static seats(): readonly Seat[] {
    return SEATS;
  }
}
