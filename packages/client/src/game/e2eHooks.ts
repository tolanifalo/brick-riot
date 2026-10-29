import type { AutoplayMode } from '@brick-riot/shared';

/**
 * Browser-test hooks. Only compiled in when built with `--mode e2e`
 * (VITE_E2E=true in .env.e2e); production builds tree-shake this away.
 */
export const E2E_ENABLED = import.meta.env.VITE_E2E === 'true';

export interface E2ESnapshot {
  status: string;
  paused: boolean;
  paddleX: number;
  paddleWidth: number;
  balls: { x: number; y: number; attached: boolean }[];
  lives: number;
  score: number;
  boardId: string;
  tick: number;
  /** Multiplayer only: prediction checksum statistics. */
  net?: { checks: number; mismatches: number; resyncs: number; lateCommands: number; maxLateTicks: number };
  energy?: number;
  debuff?: string | null;
  shielded?: boolean;
  /** Frost Bricks currently alive. */
  frost?: number;
}

export interface E2EHooks {
  snapshot(): E2ESnapshot;
  /** Drives the paddle with the scripted autoplayer, optionally faster than real time. */
  setAutopilot(mode: AutoplayMode | 'off', speed?: number): void;
}

declare global {
  interface Window {
    __BRICK_RIOT_E2E__?: E2EHooks;
  }
}

export function installE2EHooks(hooks: E2EHooks): () => void {
  if (!E2E_ENABLED) return () => undefined;
  window.__BRICK_RIOT_E2E__ = hooks;
  return () => {
    if (window.__BRICK_RIOT_E2E__ === hooks) delete window.__BRICK_RIOT_E2E__;
  };
}
