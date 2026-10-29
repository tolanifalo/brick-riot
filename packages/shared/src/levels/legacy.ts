import type { BoardDefinition } from './schema';

/**
 * Opening Riot v1: the Phase 1 test board, level 1 until 0.6.0.
 *
 * FROZEN. It is no longer in the campaign (it was a 3-5 minute slog for a
 * first level), but it stays as the engine's regression fixture: the Phase 1
 * golden replay fingerprints (test/golden.test.ts) run on exactly this board.
 * Never edit it.
 */
export const OPENING_RIOT_V1: BoardDefinition = {
  id: 'classic-01',
  version: 1,
  name: 'Opening Riot',
  collection: 'classic',
  theme: 'classic',
  difficulty: { designerRating: 1.5 },
  unlock: { kind: 'none' },
  mastery: [
    { id: 'classic-01-clear', kind: 'clear' },
    { id: 'classic-01-lives', kind: 'minBallsRemaining', balls: 2 },
    { id: 'classic-01-fast', kind: 'clearUnderSeconds', seconds: 210 },
    { id: 'classic-01-clean', kind: 'noBallLost' },
    { id: 'classic-01-combo', kind: 'minCombo', combo: 8 },
  ],
  multiplayerEligible: true,
  parTimeSeconds: 120,
  stars: { twoStarSeconds: 295, threeStarSeconds: 210 },
  grid: { cols: 10, brickHeight: 20, gap: 4, top: 84, sideMargin: 16 },
  legend: {
    R: { type: 'reinforced', color: 'red' },
    O: { type: 'standard', color: 'orange' },
    X: { type: 'explosive', color: 'magenta' },
    Y: { type: 'standard', color: 'yellow' },
    '#': { type: 'indestructible', color: 'steel' },
    G: { type: 'standard', color: 'lime' },
    C: { type: 'standard', color: 'cyan' },
    B: { type: 'standard', color: 'blue' },
  },
  layout: [
    '.RRRRRRRR.',
    'RRRRRRRRRR',
    'OOOXOOXOOO',
    'YYYYYYYYYY',
    'Y#YYYYYY#Y',
    'GGGGGGGGGG',
    'CCCC..CCCC',
    '.BBBBBBBB.',
  ],
};
