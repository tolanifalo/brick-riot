import type { BrickColor, BrickType } from '@brick-riot/shared';
import type Phaser from 'phaser';
import { shade, type VisualTheme } from './theme';

/** Textures are drawn at 2x world size and displayed at world size, for crisp high-DPI output. */
export const TEX_SCALE = 2;

export type BrickVariant =
  | 'plain'
  | 'reinforced'
  | 'cracked'
  | 'explosive'
  | 'indestructible'
  | 'powerup'
  | 'moving'
  | 'movingSteel'
  | 'frost'
  | 'frostCracked';

export function brickVariant(type: BrickType, hp: number, maxHp: number, moving = false): BrickVariant {
  switch (type) {
    case 'frost':
      return hp < maxHp ? 'frostCracked' : 'frost';
    case 'reinforced':
      return hp < maxHp ? 'cracked' : 'reinforced';
    case 'explosive':
      return 'explosive';
    case 'indestructible':
      return moving ? 'movingSteel' : 'indestructible';
    case 'powerup':
      return 'powerup';
    case 'moving':
      return 'moving';
    default:
      return 'plain';
  }
}

function drawChevrons(g: Phaser.GameObjects.Graphics, W: number, H: number, color: number): void {
  const cy = H / 2;
  const s = Math.min(H * 0.28, 8);
  g.lineStyle(3, color, 0.95);
  for (const dir of [-1, 1]) {
    const x = W / 2 + dir * W * 0.3;
    g.beginPath();
    g.moveTo(x - dir * s, cy - s);
    g.lineTo(x, cy);
    g.lineTo(x - dir * s, cy + s);
    g.strokePath();
  }
}

export function ensureBrickTexture(
  scene: Phaser.Scene,
  theme: VisualTheme,
  color: BrickColor,
  variant: BrickVariant,
  width: number,
  height: number,
): string {
  const W = Math.round(width * TEX_SCALE);
  const H = Math.round(height * TEX_SCALE);
  const key = `brick:${theme.id}:${color}:${variant}:${W}x${H}`;
  if (scene.textures.exists(key)) return key;

  const base = theme.bricks[color];
  const g = scene.add.graphics();
  const b = 2;
  const innerW = W - 2 * b;
  const innerH = H - 2 * b;
  g.fillStyle(shade(base, -0.55));
  g.fillRect(0, 0, W, H);
  g.fillStyle(base);
  g.fillRect(b, b, innerW, innerH);
  g.fillStyle(shade(base, 0.38));
  g.fillRect(b, b, innerW, Math.round(innerH * 0.3));
  g.fillStyle(shade(base, -0.28));
  const shadeH = Math.round(innerH * 0.22);
  g.fillRect(b, H - b - shadeH, innerW, shadeH);
  g.fillStyle(0xffffff, 0.7);
  g.fillRect(b + 3, b + 3, Math.round(innerW * 0.2), 3);

  const dark = shade(base, -0.6);
  switch (variant) {
    case 'reinforced':
    case 'cracked': {
      g.lineStyle(3, dark, 0.85);
      g.strokeRect(b + 6, b + 6, innerW - 12, innerH - 12);
      g.fillStyle(shade(base, 0.6));
      for (const [x, y] of [
        [b + 6, b + 6],
        [W - b - 6, b + 6],
        [b + 6, H - b - 6],
        [W - b - 6, H - b - 6],
      ] as const) {
        g.fillCircle(x, y, 2.5);
      }
      if (variant === 'cracked') {
        g.lineStyle(3, dark, 1);
        g.beginPath();
        g.moveTo(W * 0.38, b);
        g.lineTo(W * 0.46, H * 0.38);
        g.lineTo(W * 0.4, H * 0.62);
        g.lineTo(W * 0.52, H - b);
        g.moveTo(W * 0.46, H * 0.38);
        g.lineTo(W * 0.62, H * 0.5);
        g.strokePath();
      }
      break;
    }
    case 'explosive': {
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(innerH * 0.42, 14);
      g.fillStyle(0x1a0716);
      g.fillTriangle(cx - r - 3, cy, cx, cy - r - 3, cx + r + 3, cy);
      g.fillTriangle(cx - r - 3, cy, cx, cy + r + 3, cx + r + 3, cy);
      g.fillStyle(0xffd60a);
      g.fillTriangle(cx - r, cy, cx, cy - r, cx + r, cy);
      g.fillTriangle(cx - r, cy, cx, cy + r, cx + r, cy);
      g.fillStyle(0x1a0716);
      g.fillCircle(cx, cy, r * 0.32);
      g.fillStyle(dark, 0.9);
      for (let x = b + 4; x < W * 0.28; x += 10) g.fillRect(x, b + 4, 4, innerH - 8);
      for (let x = W - b - 8; x > W * 0.72; x -= 10) g.fillRect(x, b + 4, 4, innerH - 8);
      break;
    }
    case 'indestructible':
    case 'movingSteel': {
      g.lineStyle(2, shade(base, -0.45), 0.55);
      for (let x = -H; x < W; x += 9) {
        g.lineBetween(x, H - b, x + H, b);
      }
      g.lineStyle(2, shade(base, -0.65), 1);
      g.strokeRect(b + 1, b + 1, innerW - 2, innerH - 2);
      g.fillStyle(shade(base, 0.55));
      g.fillCircle(b + 6, H / 2, 3);
      g.fillCircle(W - b - 6, H / 2, 3);
      if (variant === 'movingSteel') drawChevrons(g, W, H, 0xffd60a);
      break;
    }
    case 'powerup': {
      // A white star-burst diamond: "this brick drops something".
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(innerH * 0.4, 13);
      g.fillStyle(shade(base, -0.55));
      g.fillTriangle(cx - r - 3, cy, cx, cy - r - 3, cx + r + 3, cy);
      g.fillTriangle(cx - r - 3, cy, cx, cy + r + 3, cx + r + 3, cy);
      g.fillStyle(0xffffff);
      g.fillTriangle(cx - r, cy, cx, cy - r, cx + r, cy);
      g.fillTriangle(cx - r, cy, cx, cy + r, cx + r, cy);
      g.fillStyle(base);
      g.fillCircle(cx, cy, r * 0.3);
      break;
    }
    case 'moving':
      drawChevrons(g, W, H, shade(base, -0.6));
      break;
    case 'frost':
    case 'frostCracked': {
      // Pale ice slab with a six-armed snowflake: an obstacle, not a target.
      g.fillStyle(0xe8fbff, 0.55);
      g.fillRect(b, b, innerW, innerH);
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(innerH * 0.4, 13);
      g.lineStyle(3, 0x0a3a52, 0.95);
      for (const [dx, dy] of [
        [1, 0],
        [0.5, 0.87],
        [-0.5, 0.87],
      ] as const) {
        g.lineBetween(cx - dx * r, cy - dy * r, cx + dx * r, cy + dy * r);
      }
      g.lineStyle(2, 0xffffff, 0.9);
      g.strokeRect(b + 1, b + 1, innerW - 2, innerH - 2);
      if (variant === 'frostCracked') {
        g.lineStyle(3, 0x0a3a52, 1);
        g.beginPath();
        g.moveTo(W * 0.2, b);
        g.lineTo(W * 0.3, H * 0.5);
        g.lineTo(W * 0.24, H - b);
        g.moveTo(W * 0.78, b);
        g.lineTo(W * 0.7, H * 0.45);
        g.lineTo(W * 0.8, H - b);
        g.strokePath();
      }
      break;
    }
    case 'plain':
      break;
  }
  g.generateTexture(key, W, H);
  g.destroy();
  return key;
}

export function ensurePaddleTexture(scene: Phaser.Scene, theme: VisualTheme, width: number, height: number): string {
  const W = Math.round(width * TEX_SCALE);
  const H = Math.round(height * TEX_SCALE);
  const key = `paddle:${theme.id}:${W}x${H}`;
  if (scene.textures.exists(key)) return key;
  const g = scene.add.graphics();
  const r = H / 2;
  g.fillStyle(shade(theme.paddleCap, -0.55));
  g.fillRoundedRect(0, 0, W, H, r);
  g.fillStyle(theme.paddleBody);
  g.fillRoundedRect(2, 2, W - 4, H - 4, r - 2);
  const capW = Math.round(W * 0.17);
  g.fillStyle(theme.paddleCap);
  g.fillRoundedRect(2, 2, capW, H - 4, { tl: r - 2, bl: r - 2, tr: 0, br: 0 });
  g.fillRoundedRect(W - 2 - capW, 2, capW, H - 4, { tl: 0, bl: 0, tr: r - 2, br: r - 2 });
  g.fillStyle(0xffffff, 0.95);
  g.fillRect(capW + 6, 5, W - 2 * capW - 12, 3);
  g.fillStyle(shade(theme.paddleBody, -0.35));
  g.fillRect(capW + 2, H - 8, W - 2 * capW - 4, 3);
  g.fillRect(W / 2 - 1, 9, 2, H - 18);
  g.generateTexture(key, W, H);
  g.destroy();
  return key;
}

/** Falling power-up capsule: a coloured pill with the power-up's glyph. */
export function ensureCapsuleTexture(
  scene: Phaser.Scene,
  kind: string,
  glyph: string,
  color: number,
  width: number,
  height: number,
): string {
  const key = `capsule:${kind}`;
  if (scene.textures.exists(key)) return key;
  const W = Math.round(width * TEX_SCALE);
  const H = Math.round(height * TEX_SCALE);
  const tex = scene.textures.createCanvas(key, W, H);
  if (!tex) return key;
  const ctx = tex.getContext();
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  const pill = (inset: number) => {
    const r = (H - inset * 2) / 2;
    ctx.beginPath();
    ctx.moveTo(inset + r, inset);
    ctx.lineTo(W - inset - r, inset);
    ctx.arc(W - inset - r, H / 2, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(inset + r, H - inset);
    ctx.arc(inset + r, H / 2, r, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
  };
  ctx.fillStyle = hex(shade(color, -0.6));
  pill(0);
  ctx.fill();
  ctx.fillStyle = hex(color);
  pill(3);
  ctx.fill();
  ctx.fillStyle = hex(shade(color, 0.45));
  ctx.fillRect(H / 2, 6, W - H, 4);
  ctx.fillStyle = '#0a0d1c';
  ctx.font = `${Math.round(H * 0.62)}px Bungee, Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, W / 2, H / 2 + 1);
  tex.refresh();
  return key;
}

/** Shared effect textures: ball, glows, particle spark, shockwave ring. */
export function ensureCommonTextures(scene: Phaser.Scene, ballRadius: number): void {
  const make = (key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void) => {
    if (scene.textures.exists(key)) return;
    const g = scene.add.graphics();
    draw(g);
    g.generateTexture(key, w, h);
    g.destroy();
  };

  const br = ballRadius * TEX_SCALE;
  make('ball', br * 2 + 2, br * 2 + 2, (g) => {
    g.fillStyle(0xffffff);
    g.fillCircle(br + 1, br + 1, br);
    g.fillStyle(0xdfe6ff);
    g.fillCircle(br + 3, br + 3, br * 0.62);
    g.fillStyle(0xffffff);
    g.fillCircle(br - 2, br - 2, br * 0.42);
  });

  make('glow', 96, 96, (g) => {
    for (let i = 24; i > 0; i--) {
      g.fillStyle(0xffffff, 0.035);
      g.fillCircle(48, 48, i * 2);
    }
  });

  make('dot', 16, 16, (g) => {
    g.fillStyle(0xffffff);
    g.fillCircle(8, 8, 8);
  });

  make('spark', 6, 6, (g) => {
    g.fillStyle(0xffffff);
    g.fillRect(0, 0, 6, 6);
  });

  make('ring', 128, 128, (g) => {
    g.lineStyle(6, 0xffffff, 1);
    g.strokeCircle(64, 64, 60);
  });

  make('bolt', 6, 28, (g) => {
    g.fillStyle(0xffffff);
    g.fillRect(1, 0, 4, 28);
  });

  make('cannon', 12, 14, (g) => {
    g.fillStyle(0x1a0716);
    g.fillRect(0, 0, 12, 14);
    g.fillStyle(0xff3b4e);
    g.fillRect(2, 2, 8, 12);
    g.fillStyle(0xffffff);
    g.fillRect(4, 0, 4, 4);
  });
}
