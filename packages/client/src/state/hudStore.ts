import type { ActiveAbility, DebuffKind, TimedPowerUp } from '@brick-riot/shared';
import { create } from 'zustand';

export type HudPhase = 'loading' | 'ready' | 'playing' | 'won' | 'lost';

export interface HudSnapshot {
  phase: HudPhase;
  paused: boolean;
  boardName: string;
  /** 1-based campaign position. */
  levelNumber: number;
  score: number;
  lives: number;
  combo: number;
  bestCombo: number;
  /** Rounded to 100 ms so the HUD re-renders at most ~10x per second. */
  elapsedMs: number;
  bricksRemaining: number;
  bricksTotal: number;
  clearBonus: number;
  quality: 'high' | 'low';
  /**
   * Active timed power-ups as "kind:fraction" pairs joined by "|", fraction
   * quantised to 5%. A string keeps change detection cheap; see parseEffects.
   */
  effects: string;
  /** Ability energy (whole units; multiplayer only). */
  energy: number;
  energyMax: number;
  /** Abilities on cooldown as "ability:tenthsOfSecondLeft" joined by "|". */
  cooldowns: string;
  /** Own debuff as "kind:phase:tenthsLeft", or ''. */
  debuff: string;
  /** Tenths of a second of Shield left (0 = none). */
  shield: number;
  immune: boolean;
}

export const INITIAL_HUD: HudSnapshot = {
  phase: 'loading',
  paused: false,
  boardName: '',
  levelNumber: 0,
  score: 0,
  lives: 0,
  combo: 0,
  bestCombo: 0,
  elapsedMs: 0,
  bricksRemaining: 0,
  bricksTotal: 0,
  clearBonus: 0,
  quality: 'high',
  effects: '',
  energy: 0,
  energyMax: 100,
  cooldowns: '',
  debuff: '',
  shield: 0,
  immune: false,
};

/** Seconds of cooldown left per ability, from the HUD encoding. */
export function parseCooldowns(encoded: string): Partial<Record<ActiveAbility, number>> {
  const out: Partial<Record<ActiveAbility, number>> = {};
  if (!encoded) return out;
  for (const part of encoded.split('|')) {
    const [ability, tenths] = part.split(':');
    out[ability as ActiveAbility] = Number(tenths) / 10;
  }
  return out;
}

export function parseDebuff(encoded: string): { kind: DebuffKind; phase: 'pending' | 'active'; seconds: number } | null {
  if (!encoded) return null;
  const [kind, phase, tenths] = encoded.split(':');
  return { kind: kind as DebuffKind, phase: phase === 'pending' ? 'pending' : 'active', seconds: Number(tenths) / 10 };
}

/** Written by the Phaser scene, read by React. Components should select single fields. */
export const useHud = create<HudSnapshot>(() => ({ ...INITIAL_HUD }));

/** Pushes only fields that changed, so unrelated HUD components do not re-render. */
export function patchHud(next: HudSnapshot): void {
  const current = useHud.getState();
  const changed: Partial<HudSnapshot> = {};
  let dirty = false;
  for (const key of Object.keys(next) as (keyof HudSnapshot)[]) {
    if (current[key] !== next[key]) {
      (changed as Record<string, unknown>)[key] = next[key];
      dirty = true;
    }
  }
  if (dirty) useHud.setState(changed);
}

export function encodeEffects(effects: { kind: TimedPowerUp; fraction: number }[]): string {
  return effects.map((e) => `${e.kind}:${(Math.ceil(e.fraction * 20) / 20).toFixed(2)}`).join('|');
}

export function parseEffects(encoded: string): { kind: TimedPowerUp; fraction: number }[] {
  if (!encoded) return [];
  return encoded.split('|').map((part) => {
    const [kind, fraction] = part.split(':');
    return { kind: kind as TimedPowerUp, fraction: Number(fraction) };
  });
}

export function formatTime(ms: number): string {
  const totalTenths = Math.floor(ms / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`;
}
