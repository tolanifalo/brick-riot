import { POWER_UP_INFO, type PositivePowerUp } from '../config/powerups';
import { nextRandom } from '../math/rng';
import { BASE_LEGEND, GRID, masteryFor } from './classic';
import { validateBoard, type BoardDefinition, type BrickColor, type BrickLegendEntry } from './schema';

/**
 * ENDLESS LEVELS (0.6). Level N (N >= 13) is generated from N alone, so every
 * player gets the same level N, and the server can rebuild any level to
 * verify a run. Only integer-based RNG (Mulberry32) and + - * / are used:
 * no Math.exp/log/sin, whose last bits may differ between JS engines.
 *
 * Changing ANY generation rule changes existing levels: bump
 * ENDLESS_GENERATOR_VERSION (records are kept per board version).
 */
export const CLASSIC_LEVELS = 12;
export const ENDLESS_FIRST_LEVEL = 13;
export const ENDLESS_MAX_LEVEL = 9999;
export const ENDLESS_GENERATOR_VERSION = 1;

/** normal; breather = a deliberately easier level after a hard one; hard every 10th; boss every 50th. */
export type LevelTag = 'normal' | 'breather' | 'hard' | 'boss';

export function endlessId(n: number): string {
  return `endless-${n}`;
}

const ENDLESS_RE = /^endless-([1-9]\d{0,3})$/;

/** The level number of an endless id, or null (also for out-of-range numbers). */
export function endlessLevelNumber(id: string): number | null {
  const m = ENDLESS_RE.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= ENDLESS_FIRST_LEVEL && n <= ENDLESS_MAX_LEVEL ? n : null;
}

/** Level 1-12 are the hand-made CLASSIC boards; 13+ are generated. */
export function levelId(n: number): string {
  return n <= CLASSIC_LEVELS ? `classic-${String(n).padStart(2, '0')}` : endlessId(n);
}

export function levelTag(n: number): LevelTag {
  if (n % 50 === 0) return 'boss';
  if (n % 10 === 0) return 'hard';
  if (n % 10 === 1 || n % 10 === 6) return 'breather';
  return 'normal';
}

/**
 * Designer rating (1-10): starts at 4 (just above the middle of the hand-made
 * chapter) and rises steadily towards ~9, with a sawtooth: hard levels every
 * 10th, a boss every 50th, breathers after them.
 */
export function endlessRating(n: number): number {
  const k = Math.max(0, n - ENDLESS_FIRST_LEVEL);
  const base = 4 + (5 * k) / (k + 100);
  const tag = levelTag(n);
  const adj = tag === 'boss' ? 1.8 : tag === 'hard' ? 1 : tag === 'breather' ? -1 : 0;
  return Math.round(Math.min(10, Math.max(1.5, base + adj)) * 10) / 10;
}

class Rng {
  constructor(private state: number) {}
  next(): number {
    const r = nextRandom(this.state);
    this.state = r.state;
    return r.value;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

function seedFor(n: number, attempt: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0;
  return (h ^ Math.imul(ENDLESS_GENERATOR_VERSION + attempt * 7919, 0x27d4eb2d)) | 0;
}

const COLS = GRID.cols;
const HALF = COLS / 2;

type Template = (r: number, c: number, rows: number, rng: Rng) => boolean;

/** Pattern templates over HALF the columns (c = 0 outer .. 4 centre); the other half mirrors. */
const TEMPLATES: Record<string, Template> = {
  block: () => true,
  pyramid: (r, c) => HALF - 1 - c <= r,
  funnel: (r, c, rows) => HALF - 1 - c <= rows - 1 - r,
  diamond: (r, c, rows) => Math.abs(2 * r - (rows - 1)) + 2 * (HALF - 1 - c) <= rows + 1,
  stripes: (r) => r % 2 === 0,
  checker: (r, c) => (r + c) % 2 === 0,
  frame: (r, c, rows) => r === 0 || r === rows - 1 || c === 0 || (c >= 3 && r >= 2 && r <= rows - 3),
  columns: (r, c) => c % 2 === 0 || r === 0,
  arch: (r, c) => r < 2 || c <= 1,
  zigzag: (r, c) => (c + r) % 4 < 2,
  noise: (_r, _c, _rows, rng) => rng.chance(0.68),
};
const TEMPLATE_NAMES = Object.keys(TEMPLATES);

const PALETTES: readonly (readonly BrickColor[])[] = [
  ['red', 'orange', 'yellow', 'lime', 'cyan', 'blue', 'violet'],
  ['cyan', 'blue', 'violet', 'magenta'],
  ['yellow', 'orange', 'red', 'magenta'],
  ['lime', 'cyan', 'blue'],
  ['violet', 'magenta', 'red', 'orange'],
];

const ADJECTIVES = ['Neon', 'Crimson', 'Static', 'Hyper', 'Turbo', 'Electric', 'Midnight', 'Solar', 'Iron', 'Velvet', 'Chrome', 'Atomic', 'Cosmic', 'Rapid', 'Feral', 'Glitch', 'Pixel', 'Rogue', 'Savage', 'Frantic'];
const NOUNS = ['Bastion', 'Lattice', 'Cascade', 'Gauntlet', 'Arcade', 'Spire', 'Grid', 'Vault', 'Circuit', 'Avalanche', 'Hive', 'Citadel', 'Maze', 'Pinwheel', 'Reactor', 'Rampart', 'Tempest', 'Wall', 'Ziggurat', 'Pulse'];

/** Kinds random drops may produce on level n: more variety as the levels go on. */
function poolFor(n: number): PositivePowerUp[] {
  const pool: PositivePowerUp[] = ['multiball', 'wide', 'laser', 'net', 'bomb'];
  if (n >= 15) pool.push('heavy');
  if (n >= 18) pool.push('magnet');
  if (n >= 22) pool.push('nuke');
  return pool;
}

/** Share of ordinary drops that are power-downs: none at first, then rising to 30%. */
export function powerDownChanceFor(n: number): number {
  if (n < 16) return 0;
  const tag = levelTag(n);
  const base = Math.min(0.3, 0.12 + (n - 16) * 0.003);
  const adj = tag === 'breather' ? base / 2 : tag === 'boss' ? base + 0.05 : base;
  return Math.round(adj * 1000) / 1000;
}

const c5 = (v: number) => Math.max(10, Math.ceil(v / 5) * 5);

interface Cell {
  type: 'standard' | 'reinforced' | 'explosive' | 'indestructible' | 'powerup' | 'moving';
  color: BrickColor;
  hp?: number;
  powerUp?: PositivePowerUp | 'random';
  move?: { cells: number; speed: number };
}

function build(n: number, attempt: number): BoardDefinition {
  const rng = new Rng(seedFor(n, attempt));
  const tag = levelTag(n);
  const rating = endlessRating(n);
  const rows = Math.min(10, Math.max(5, 4 + Math.floor(rating * 0.55) + rng.int(0, 1) - (tag === 'breather' ? 1 : 0)));
  const template = TEMPLATES[rng.pick(TEMPLATE_NAMES)] ?? TEMPLATES.block;
  const palette = PALETTES[Math.floor((n - ENDLESS_FIRST_LEVEL) / 20) % PALETTES.length] ?? PALETTES[0] ?? ['cyan'];
  const offset = rng.int(0, palette.length - 1);

  // 1. Shape (half mask, mirrored). Too sparse -> add stripes.
  const half: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < HALF; c++) row.push(template ? template(r, c, rows, rng) : true);
    half.push(row);
  }
  const count = () => half.reduce((s, row) => s + row.filter(Boolean).length, 0) * 2;
  for (let r = 0; count() < 24 && r < rows; r += 2) half[r]?.fill(true);

  // 2. Bricks (decided per half cell so the board stays symmetric).
  const reinforcedP = Math.min(0.5, Math.max(0, (rating - 2.5) * 0.09));
  const hp3P = Math.min(0.35, Math.max(0, (rating - 5) * 0.08));
  const steelAllowed = n >= 18 && tag !== 'breather';
  let explosivesLeft = rng.int(0, rating >= 5 ? 2 : 1);
  let steelPairs = steelAllowed ? rng.int(0, Math.min(3, Math.floor(rating - 3))) : 0;
  const grid: (Cell | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const color = palette[(r + offset) % palette.length] ?? 'cyan';
    const row: (Cell | null)[] = new Array<Cell | null>(COLS).fill(null);
    let steelInRow = 0;
    const steelAbove = grid[r - 1]?.some((cell) => cell?.type === 'indestructible') ?? false;
    for (let c = 0; c < HALF; c++) {
      if (!half[r]?.[c]) continue;
      let cell: Cell;
      if (steelPairs > 0 && r > 0 && !steelAbove && steelInRow < 2 && rng.chance(0.18)) {
        cell = { type: 'indestructible', color: 'steel' };
        steelPairs--;
        steelInRow++;
      } else if (explosivesLeft > 0 && r > 0 && rng.chance(0.07)) {
        cell = { type: 'explosive', color: 'magenta' };
        explosivesLeft--;
      } else if (rng.chance(reinforcedP)) {
        cell = rng.chance(hp3P) ? { type: 'reinforced', color: 'red', hp: 3 } : { type: 'reinforced', color: 'red' };
      } else {
        cell = { type: 'standard', color };
      }
      row[c] = cell;
      row[COLS - 1 - c] = { ...cell };
    }
    grid.push(row);
  }

  // 3. Visible power-up bricks in the lower half of the shape (easy to reach), plus maybe a "?".
  const pool = poolFor(n);
  const standardCells: [number, number][] = [];
  grid.forEach((row, r) => row.forEach((cell, c) => cell?.type === 'standard' && r >= Math.floor(rows / 2) && standardCells.push([r, c])));
  const fixed = Math.min(standardCells.length, tag === 'breather' ? rng.int(2, 3) : rng.int(1, 2));
  for (let i = 0; i < fixed; i++) {
    const [r, c] = standardCells.splice(Math.floor(rng.next() * standardCells.length), 1)[0] ?? [0, 0];
    const kind = rng.pick(pool);
    const row = grid[r];
    if (row) row[c] = { type: 'powerup', color: POWER_UP_INFO[kind].color, powerUp: kind };
  }
  if (standardCells.length > 0 && rng.chance(0.5)) {
    const [r, c] = standardCells.splice(Math.floor(rng.next() * standardCells.length), 1)[0] ?? [0, 0];
    const row = grid[r];
    if (row) row[c] = { type: 'powerup', color: 'violet', powerUp: 'random' };
  }

  // 4. Moving lanes (later levels): an empty row, then sliders that sweep 3-4 empty cells.
  let lanes = 0;
  const laneSpeed = Math.min(120, 50 + Math.round(rating * 7));
  if (n >= 26 && rng.chance(Math.min(0.5, 0.2 + (n - 26) * 0.004))) {
    grid.push(new Array<Cell | null>(COLS).fill(null));
    const lane: (Cell | null)[] = new Array<Cell | null>(COLS).fill(null);
    lane[0] = { type: 'moving', color: palette[offset % palette.length] ?? 'cyan', move: { cells: 3, speed: laneSpeed } };
    lane[5] = { type: 'moving', color: palette[(offset + 1) % palette.length] ?? 'cyan', move: { cells: 3, speed: laneSpeed } };
    grid.push(lane);
    lanes++;
  }
  if (n >= 40 && tag !== 'breather' && rng.chance(0.25)) {
    grid.push(new Array<Cell | null>(COLS).fill(null));
    const gate: (Cell | null)[] = new Array<Cell | null>(COLS).fill(null);
    gate[0] = { type: 'indestructible', color: 'steel', move: { cells: 4, speed: Math.max(40, laneSpeed - 25) } };
    gate[5] = { type: 'indestructible', color: 'steel', move: { cells: 4, speed: Math.max(40, laneSpeed - 25) } };
    grid.push(gate);
    lanes++;
  }

  // 5. Legend: one character per distinct brick spec.
  const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const legend: Record<string, BrickLegendEntry> = {};
  const keyOf = new Map<string, string>();
  const layout = grid.map((row) =>
    row
      .map((cell) => {
        if (!cell) return '.';
        const spec = JSON.stringify(cell);
        let key = keyOf.get(spec);
        if (!key) {
          key = KEYS.charAt(keyOf.size);
          keyOf.set(spec, key);
          legend[key] = { ...cell } as BrickLegendEntry;
        }
        return key;
      })
      .join(''),
  );

  // 6. Times: estimated from the work the board needs (fitted to the test bot; see BALANCE_CONFIG.md).
  let hp = 0;
  let steel = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.type === 'indestructible') steel++;
      else hp += cell.hp ?? (cell.type === 'reinforced' ? 2 : 1);
    }
  }
  const estimate = ESTIMATE.base + ESTIMATE.perHp * hp + ESTIMATE.perSteel * steel + ESTIMATE.perLane * lanes;
  const three = c5(estimate * 0.85);
  // Names from the level number, not the RNG: 7 and 20 are coprime, so the 20 levels of a
  // chapter all get different adjectives (and therefore different names).
  const words = `${ADJECTIVES[(n * 7) % ADJECTIVES.length] ?? 'Neon'} ${NOUNS[(n * 3 + Math.floor(n / 20)) % NOUNS.length] ?? 'Wall'}`;
  const name = tag === 'boss' ? `Boss: ${words}` : words;
  const id = endlessId(n);
  const combo = Math.min(20, 6 + Math.floor(rating));

  return {
    id,
    version: ENDLESS_GENERATOR_VERSION,
    name,
    collection: 'classic',
    theme: 'classic',
    difficulty: { designerRating: rating },
    unlock: { kind: 'boardCleared', boardId: levelId(n - 1) },
    mastery: masteryFor(id, three, combo),
    multiplayerEligible: false,
    parTimeSeconds: c5(estimate),
    stars: { twoStarSeconds: c5(estimate * 1.2), threeStarSeconds: three },
    dropChance: tag === 'breather' ? 0.12 : tag === 'hard' || tag === 'boss' ? 0.1 : 0.08,
    powerUpPool: pool,
    powerDownChance: powerDownChanceFor(n),
    grid: GRID,
    legend: { ...BASE_LEGEND, ...legend },
    layout,
  };
}

/**
 * Clear-time estimate in seconds. From `npm run calibrate:endless` (30 levels x 5 bot
 * seeds, generator v1): least squares gave base 19, 1.05 s per hit point, ~16 s per
 * steel cell (two outlier boards) and a meaningless negative lane term (few samples).
 * Rounded to moderate values; bot times vary 2-3x by layout, so stars are approximate.
 */
export const ESTIMATE = { base: 18, perHp: 1, perSteel: 8, perLane: 10 };

const cache = new Map<number, BoardDefinition>();

/**
 * The board for endless level n (13..9999). Pure and deterministic; results
 * are cached. Throws for numbers out of range.
 */
export function generateLevel(n: number): BoardDefinition {
  if (!Number.isInteger(n) || n < ENDLESS_FIRST_LEVEL || n > ENDLESS_MAX_LEVEL) throw new Error(`no endless level ${n}`);
  const hit = cache.get(n);
  if (hit) return hit;
  for (let attempt = 0; attempt < 8; attempt++) {
    const board = build(n, attempt);
    if (validateBoard(board, { campaign: true }).length === 0) {
      if (cache.size >= 256) cache.delete(cache.keys().next().value ?? n);
      cache.set(n, board);
      return board;
    }
  }
  throw new Error(`endless level ${n} could not be generated`);
}
