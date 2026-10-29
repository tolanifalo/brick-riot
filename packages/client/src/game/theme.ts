import type { BrickColor, ThemeId } from '@brick-riot/shared';

export interface VisualTheme {
  id: ThemeId;
  background: number;
  gridLine: number;
  rail: number;
  dangerLine: number;
  paddleBody: number;
  paddleCap: number;
  ball: number;
  ballGlow: number;
  bricks: Record<BrickColor, number>;
}

export const CLASSIC_THEME: VisualTheme = {
  id: 'classic',
  background: 0x0a0d1c,
  gridLine: 0x151b36,
  rail: 0xff2e88,
  dangerLine: 0xff3b4e,
  paddleBody: 0xf4f6ff,
  paddleCap: 0x19d3e6,
  ball: 0xffffff,
  ballGlow: 0xffd60a,
  bricks: {
    red: 0xff3b4e,
    orange: 0xff8a1f,
    yellow: 0xffd60a,
    lime: 0x6ee02a,
    cyan: 0x19d3e6,
    blue: 0x3d7bff,
    violet: 0x9b5cff,
    magenta: 0xff2fb2,
    steel: 0x8a94a8,
  },
};

const THEMES: Partial<Record<ThemeId, VisualTheme>> = { classic: CLASSIC_THEME };

/** Other collections fall back to CLASSIC until their themes ship. */
export function getTheme(id: ThemeId): VisualTheme {
  return THEMES[id] ?? CLASSIC_THEME;
}

export function shade(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (c: number) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}
