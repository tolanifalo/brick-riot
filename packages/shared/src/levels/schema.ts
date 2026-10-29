/**
 * Data-driven board definitions. The engine never hardcodes a level: every
 * board is a BoardDefinition that is validated and compiled into brick state.
 */
import { POWER_UP_KINDS, type PowerUpKind } from '../config/powerups';

export const BRICK_TYPES = [
  'standard',
  'reinforced',
  'explosive',
  'powerup',
  'moving',
  'indestructible',
  /** Engine-only: created by the Frost Brick ability, never in board layouts. */
  'frost',
] as const;
export type BrickType = (typeof BRICK_TYPES)[number];

/** Brick types board legends may use (frost is reserved for the ability). */
export const ENGINE_SUPPORTED_BRICK_TYPES: readonly BrickType[] = [
  'standard',
  'reinforced',
  'explosive',
  'powerup',
  'moving',
  'indestructible',
];

export const BRICK_COLORS = [
  'red',
  'orange',
  'yellow',
  'lime',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'steel',
] as const;
/** Palette key; each visual theme maps keys to concrete colours. */
export type BrickColor = (typeof BRICK_COLORS)[number];

export type CollectionId = 'classic' | 'circuit' | 'tidal' | 'void';
export type ThemeId = 'classic' | 'circuit' | 'tidal' | 'void';

export type UnlockRequirement =
  | { kind: 'none' }
  | { kind: 'boardCleared'; boardId: string }
  | { kind: 'playerLevel'; level: number };

/** Every objective implicitly requires clearing the board. */
export type MasteryObjective =
  | { id: string; kind: 'clear' }
  | { id: string; kind: 'clearUnderSeconds'; seconds: number }
  | { id: string; kind: 'noBallLost' }
  | { id: string; kind: 'minBallsRemaining'; balls: number }
  | { id: string; kind: 'minCombo'; combo: number }
  | { id: string; kind: 'minScore'; score: number };

export const MASTERY_OBJECTIVES_PER_BOARD = 5;

/**
 * Board Difficulty Rating inputs. `designerRating` is hand-assigned; the
 * calibration fields are reserved for future completion-time statistics.
 */
export interface BoardDifficultyProfile {
  designerRating: number;
  calibratedRating?: number;
  sampleSize?: number;
}

/** Horizontal oscillation: the brick slides `cells` grid cells right, then back. */
export interface BrickMotion {
  cells: number;
  /** World units per second. */
  speed: number;
}

export interface BrickLegendEntry {
  type: BrickType;
  color: BrickColor;
  /** Hit points; defaults per type when omitted. */
  hp?: number;
  /** For 'powerup' bricks: a fixed drop, or 'random' (seeded, weighted). Default 'random'. */
  powerUp?: PowerUpKind | 'random';
  /** Required for 'moving' bricks; optional for 'indestructible' (moving obstacles). */
  move?: BrickMotion;
}

export interface BoardGrid {
  cols: number;
  brickHeight: number;
  gap: number;
  /** Y of the first row's top edge. */
  top: number;
  sideMargin: number;
}

/** 1 star = clear. 2 and 3 stars = clear within these times. */
export interface StarThresholds {
  twoStarSeconds: number;
  threeStarSeconds: number;
}

export interface BoardDefinition {
  id: string;
  version: number;
  name: string;
  collection: CollectionId;
  theme: ThemeId;
  difficulty: BoardDifficultyProfile;
  unlock: UnlockRequirement;
  mastery: MasteryObjective[];
  multiplayerEligible: boolean;
  /** Estimated completion-time target; also the clear-bonus reference. */
  parTimeSeconds: number;
  /** Required for campaign boards. */
  stars?: StarThresholds;
  /** Chance (0..1) that a destroyed non-powerup brick drops a random power-up. Default 0. */
  dropChance?: number;
  grid: BoardGrid;
  /** Maps single layout characters to brick specs. '.' is always empty. */
  legend: Record<string, BrickLegendEntry>;
  /** One string per row, one character per column. */
  layout: string[];
}

export const DEFAULT_BRICK_HP: Record<BrickType, number> = {
  standard: 1,
  reinforced: 2,
  explosive: 1,
  powerup: 1,
  moving: 1,
  indestructible: 1,
  frost: 2,
};

export const MAX_BRICK_SPEED = 200;

export function isRequiredBrickType(type: BrickType): boolean {
  return type !== 'indestructible' && type !== 'frost';
}

export interface ValidateOptions {
  /** Campaign boards additionally need star thresholds and five mastery objectives. */
  campaign?: boolean;
}

export function validateBoard(board: BoardDefinition, options: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  const { grid } = board;
  if (!board.id) errors.push('board id is required');
  if (!Number.isInteger(board.version) || board.version < 1) {
    errors.push('version must be a positive integer');
  }
  if (!Number.isInteger(grid.cols) || grid.cols < 1) errors.push('grid.cols must be >= 1');
  if (grid.brickHeight <= 0) errors.push('grid.brickHeight must be > 0');
  if (grid.gap < 0) errors.push('grid.gap must be >= 0');
  if (board.parTimeSeconds <= 0) errors.push('parTimeSeconds must be > 0');
  if (board.layout.length === 0) errors.push('layout must have at least one row');
  if (board.dropChance !== undefined && !(board.dropChance >= 0 && board.dropChance <= 1)) {
    errors.push('dropChance must be between 0 and 1');
  }

  for (const [key, entry] of Object.entries(board.legend)) {
    if (key.length !== 1 || key === '.') errors.push(`legend key "${key}" must be one character other than "."`);
    if (!BRICK_TYPES.includes(entry.type)) errors.push(`legend "${key}" has unknown type "${entry.type}"`);
    else if (!ENGINE_SUPPORTED_BRICK_TYPES.includes(entry.type)) {
      errors.push(
        entry.type === 'frost'
          ? `legend "${key}" uses type "frost", which is reserved for the Frost Brick ability`
          : `legend "${key}" uses type "${entry.type}", which the engine does not implement yet`,
      );
    }
    if (!BRICK_COLORS.includes(entry.color)) errors.push(`legend "${key}" has unknown color "${entry.color}"`);
    if (entry.hp !== undefined && (!Number.isInteger(entry.hp) || entry.hp < 1)) {
      errors.push(`legend "${key}" hp must be a positive integer`);
    }
    if (entry.powerUp !== undefined) {
      if (entry.type !== 'powerup') errors.push(`legend "${key}" sets powerUp but is not a powerup brick`);
      else if (entry.powerUp !== 'random' && !POWER_UP_KINDS.includes(entry.powerUp)) {
        errors.push(`legend "${key}" has unknown powerUp "${entry.powerUp}"`);
      }
    }
    if (entry.type === 'moving' && !entry.move) errors.push(`legend "${key}" is a moving brick without "move"`);
    if (entry.move) {
      if (entry.type !== 'moving' && entry.type !== 'indestructible') {
        errors.push(`legend "${key}": only moving or indestructible bricks may move`);
      }
      if (!Number.isInteger(entry.move.cells) || entry.move.cells < 1) {
        errors.push(`legend "${key}" move.cells must be a positive integer`);
      }
      if (!(entry.move.speed > 0 && entry.move.speed <= MAX_BRICK_SPEED)) {
        errors.push(`legend "${key}" move.speed must be in (0, ${MAX_BRICK_SPEED}]`);
      }
    }
  }

  let required = 0;
  board.layout.forEach((row, r) => {
    if (row.length !== grid.cols) errors.push(`row ${r} has ${row.length} cells, expected ${grid.cols}`);
    for (let c = 0; c < row.length; c++) {
      const ch = row.charAt(c);
      if (ch === '.') continue;
      const entry = board.legend[ch];
      if (!entry) {
        errors.push(`row ${r} uses undefined legend key "${ch}"`);
        continue;
      }
      if (isRequiredBrickType(entry.type)) required++;
      if (entry.move && Number.isInteger(entry.move.cells) && entry.move.cells > 0) {
        // The brick sweeps the cells to its right; they must exist and be empty so
        // it can never overlap another brick or leave the grid.
        const end = c + entry.move.cells;
        if (end >= grid.cols) {
          errors.push(`row ${r} col ${c}: moving brick would leave the grid`);
        } else if (row.slice(c + 1, end + 1) !== '.'.repeat(entry.move.cells)) {
          errors.push(`row ${r} col ${c}: moving brick's path (cols ${c + 1}-${end}) must be empty`);
        }
      }
    }
  });
  if (required === 0) errors.push('board must contain at least one required brick');

  const ids = new Set<string>();
  for (const m of board.mastery) {
    if (ids.has(m.id)) errors.push(`duplicate mastery id "${m.id}"`);
    ids.add(m.id);
  }

  if (options.campaign) {
    if (!board.stars) errors.push('campaign boards need star thresholds');
    else if (!(board.stars.threeStarSeconds > 0 && board.stars.threeStarSeconds < board.stars.twoStarSeconds)) {
      errors.push('stars: threeStarSeconds must be > 0 and below twoStarSeconds');
    }
    if (board.mastery.length !== MASTERY_OBJECTIVES_PER_BOARD) {
      errors.push(`campaign boards need exactly ${MASTERY_OBJECTIVES_PER_BOARD} mastery objectives`);
    }
  }
  return errors;
}

export interface CompiledBrick {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: BrickType;
  color: BrickColor;
  hp: number;
  required: boolean;
  /** Horizontal travel in world units; 0 for static bricks. */
  moveRange: number;
  moveSpeed: number;
  powerUp: PowerUpKind | 'random' | null;
}

export function gridPitch(board: BoardDefinition, worldWidth: number): { x: number; y: number; width: number } {
  const { cols, brickHeight, gap, sideMargin } = board.grid;
  const width = (worldWidth - 2 * sideMargin - (cols - 1) * gap) / cols;
  return { x: width + gap, y: brickHeight + gap, width };
}

/** Converts a board's layout into positioned bricks, in row-major order. */
export function compileBoard(board: BoardDefinition, worldWidth: number): CompiledBrick[] {
  const errors = validateBoard(board);
  if (errors.length > 0) {
    throw new Error(`Invalid board "${board.id}": ${errors.join('; ')}`);
  }
  const { brickHeight, gap, top, sideMargin } = board.grid;
  const width = (worldWidth - 2 * sideMargin - (board.grid.cols - 1) * gap) / board.grid.cols;
  const bricks: CompiledBrick[] = [];
  board.layout.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const entry = board.legend[row.charAt(c)];
      if (!entry) continue;
      bricks.push({
        row: r,
        col: c,
        x: sideMargin + c * (width + gap),
        y: top + r * (brickHeight + gap),
        width,
        height: brickHeight,
        type: entry.type,
        color: entry.color,
        hp: entry.hp ?? DEFAULT_BRICK_HP[entry.type],
        required: isRequiredBrickType(entry.type),
        moveRange: entry.move ? entry.move.cells * (width + gap) : 0,
        moveSpeed: entry.move ? entry.move.speed : 0,
        powerUp: entry.type === 'powerup' ? (entry.powerUp ?? 'random') : null,
      });
    }
  });
  return bricks;
}
