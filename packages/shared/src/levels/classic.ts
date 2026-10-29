import type { BoardDefinition, BrickLegendEntry, MasteryObjective, StarThresholds } from './schema';

/**
 * CLASSIC collection: the 12-board solo campaign. Each board introduces or
 * combines one idea. Times (par, stars, mastery) were calibrated from
 * scripted playtests; see BALANCE_CONFIG.md and test/campaign.test.ts.
 */

const BASE_LEGEND = {
  R: { type: 'reinforced', color: 'red' },
  H: { type: 'reinforced', color: 'red', hp: 3 },
  O: { type: 'standard', color: 'orange' },
  Y: { type: 'standard', color: 'yellow' },
  G: { type: 'standard', color: 'lime' },
  C: { type: 'standard', color: 'cyan' },
  B: { type: 'standard', color: 'blue' },
  V: { type: 'standard', color: 'violet' },
  X: { type: 'explosive', color: 'magenta' },
  P: { type: 'powerup', color: 'violet' },
  '#': { type: 'indestructible', color: 'steel' },
} as const satisfies Record<string, BrickLegendEntry>;

const GRID = { cols: 10, brickHeight: 20, gap: 4, top: 84, sideMargin: 16 } as const;

interface CampaignSpec {
  n: number;
  name: string;
  rating: number;
  par: number;
  stars: StarThresholds;
  /** Mastery: clear-under target (seconds) and combo target. */
  targetSeconds: number;
  combo: number;
  layout: string[];
  legend?: Record<string, BrickLegendEntry>;
  dropChance?: number;
}

const idOf = (n: number) => `classic-${String(n).padStart(2, '0')}`;

function masteryFor(id: string, targetSeconds: number, combo: number): MasteryObjective[] {
  return [
    { id: `${id}-clear`, kind: 'clear' },
    { id: `${id}-lives`, kind: 'minBallsRemaining', balls: 2 },
    { id: `${id}-fast`, kind: 'clearUnderSeconds', seconds: targetSeconds },
    { id: `${id}-clean`, kind: 'noBallLost' },
    { id: `${id}-combo`, kind: 'minCombo', combo },
  ];
}

function campaignBoard(spec: CampaignSpec): BoardDefinition {
  const id = idOf(spec.n);
  return {
    id,
    version: 1,
    name: spec.name,
    collection: 'classic',
    theme: 'classic',
    difficulty: { designerRating: spec.rating },
    unlock: spec.n === 1 ? { kind: 'none' } : { kind: 'boardCleared', boardId: idOf(spec.n - 1) },
    mastery: masteryFor(id, spec.targetSeconds, spec.combo),
    multiplayerEligible: true,
    parTimeSeconds: spec.par,
    stars: spec.stars,
    ...(spec.dropChance !== undefined ? { dropChance: spec.dropChance } : {}),
    grid: GRID,
    legend: { ...BASE_LEGEND, ...spec.legend },
    layout: spec.layout,
  };
}

/**
 * Level 1. Its layout, legend, grid and par time are frozen: they are covered
 * by the Phase 1 golden replay fingerprints (test/golden.test.ts).
 */
export const CLASSIC_01: BoardDefinition = {
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

/** Two armoured towers with a channel between them; first power-up bricks. */
export const CLASSIC_02 = campaignBoard({
  n: 2,
  name: 'Twin Pillars',
  rating: 2,
  par: 90,
  stars: { twoStarSeconds: 105, threeStarSeconds: 75 },
  targetSeconds: 75,
  combo: 8,
  dropChance: 0.04,
  layout: [
    'BBBB..BBBB',
    'BRRB..BRRB',
    'BRRB..BRRB',
    'BRPB..BPRB',
    'BRRB..BRRB',
    'BBBB..BBBB',
    '..........',
    'YYY.YY.YYY',
  ],
});

/** A downward V: angled shots into the arms, explosive heart at the point. */
export const CLASSIC_03 = campaignBoard({
  n: 3,
  name: 'Chevron',
  rating: 2.5,
  par: 75,
  stars: { twoStarSeconds: 90, threeStarSeconds: 50 },
  targetSeconds: 50,
  combo: 10,
  dropChance: 0.05,
  layout: [
    'RR......RR',
    'ORR....RRO',
    'YORR..RROY',
    '.YORRRROY.',
    '..YOXXOY..',
    '...YPPY...',
    '....GG....',
  ],
});

/** A steel vault entered through one narrow corridor: a precision shot. */
export const CLASSIC_04 = campaignBoard({
  n: 4,
  name: 'Corridor',
  rating: 3,
  par: 195,
  stars: { twoStarSeconds: 225, threeStarSeconds: 120 },
  targetSeconds: 120,
  combo: 12,
  dropChance: 0.05,
  layout: [
    'YYYYYYYYYY',
    '#YYOOOOYY#',
    '#OOXOOXOO#',
    '#CCCPCCCC#',
    '####..####',
    '..........',
    '.RR.RR.RR.',
  ],
});

/** A checkerboard of armour: the ball rattles through the gaps. */
export const CLASSIC_05 = campaignBoard({
  n: 5,
  name: 'Lattice',
  rating: 3.5,
  par: 55,
  stars: { twoStarSeconds: 60, threeStarSeconds: 40 },
  targetSeconds: 40,
  combo: 8,
  dropChance: 0.06,
  layout: [
    'R.R.R.R.R.',
    '.Y.Y.Y.Y.Y',
    'R.R.P.R.R.',
    '.Y.Y.Y.Y.Y',
    'R.R.R.R.R.',
    '.C.C.P.C.C',
    'G.G.G.G.G.',
  ],
});

/** Asymmetric: a diagonal fuse of explosives; light the bottom end. */
export const CLASSIC_06 = campaignBoard({
  n: 6,
  name: 'Fuse Line',
  rating: 4,
  par: 185,
  stars: { twoStarSeconds: 215, threeStarSeconds: 105 },
  targetSeconds: 105,
  combo: 20,
  dropChance: 0.05,
  layout: [
    'RRRRRRRRRR',
    'YYYYYYYYXY',
    'YYYYYYYXYY',
    'GGGGGGXGGG',
    'GGGGGXGGGG',
    'CCCCXCCCCC',
    'CCCXCCCCCC',
    '......####',
  ],
});

/** Triple-armoured walls around a loaded core, with a single gate. */
export const CLASSIC_07 = campaignBoard({
  n: 7,
  name: 'Fortress',
  rating: 4.5,
  par: 130,
  stars: { twoStarSeconds: 150, threeStarSeconds: 85 },
  targetSeconds: 85,
  combo: 10,
  dropChance: 0.06,
  layout: [
    '..HHHHHH..',
    '.HH....HH.',
    '#H.OXXO.H#',
    '#H.OPPO.H#',
    '#H.OOOO.H#',
    '.HH....HH.',
    '..HH..HH..',
  ],
});

/** Moving bricks: two sliding lanes guard the upper rows. */
export const CLASSIC_08 = campaignBoard({
  n: 8,
  name: 'Slipstream',
  rating: 5,
  par: 75,
  stars: { twoStarSeconds: 85, threeStarSeconds: 60 },
  targetSeconds: 60,
  combo: 8,
  dropChance: 0.06,
  legend: {
    M: { type: 'moving', color: 'cyan', move: { cells: 4, speed: 70 } },
    N: { type: 'moving', color: 'blue', move: { cells: 3, speed: 95 } },
  },
  layout: [
    'OOOOOOOOOO',
    'OOPOOOOPOO',
    'YYYYYYYYYY',
    'M....M....',
    '..........',
    '.N....N...',
    '..........',
    'GGG.GG.GGG',
  ],
});

/** Asymmetric steel staircase: rebounds off the steps open the upper left. */
export const CLASSIC_09 = campaignBoard({
  n: 9,
  name: 'Staircase',
  rating: 5.5,
  par: 320,
  stars: { twoStarSeconds: 365, threeStarSeconds: 225 },
  targetSeconds: 225,
  combo: 10,
  dropChance: 0.06,
  layout: [
    'CCCCCCCCC#',
    'BBBBBBBB#.',
    'BBBBBBB#..',
    'VVVVVP#...',
    'VVVVV#....',
    'XGGG#.....',
    'GGG#......',
    'PG#.......',
  ],
});

/** Moving steel gates sweep in front of an armoured bank. */
export const CLASSIC_10 = campaignBoard({
  n: 10,
  name: 'Gatekeeper',
  rating: 6,
  par: 135,
  stars: { twoStarSeconds: 155, threeStarSeconds: 95 },
  targetSeconds: 95,
  combo: 10,
  dropChance: 0.07,
  legend: {
    K: { type: 'indestructible', color: 'steel', move: { cells: 4, speed: 60 } },
  },
  layout: [
    'RRRRRRRRRR',
    'ROOOOOOOOR',
    'ROXOPOOXOR',
    'RRRRRRRRRR',
    '..........',
    'K....K....',
    '..........',
    'YY.YYYY.YY',
  ],
});

/** An explosive core in an armoured shell, ringed by sliding lanes. */
export const CLASSIC_11 = campaignBoard({
  n: 11,
  name: 'Reactor',
  rating: 6.5,
  par: 85,
  stars: { twoStarSeconds: 100, threeStarSeconds: 55 },
  targetSeconds: 55,
  combo: 15,
  dropChance: 0.04,
  legend: {
    M: { type: 'moving', color: 'violet', move: { cells: 4, speed: 80 } },
    N: { type: 'moving', color: 'cyan', move: { cells: 3, speed: 110 } },
  },
  layout: [
    'HHHHHHHHHH',
    'M....M....',
    'HHHHHHHHHH',
    'H.X.PP.X.H',
    'H.O.XX.O.H',
    'HHH....HHH',
    '..........',
    '.N....N...',
    'YY......YY',
  ],
});

/** Everything at once: armour, steel, explosives, sliding lanes and gates. */
export const CLASSIC_12 = campaignBoard({
  n: 12,
  name: 'Riot Finale',
  rating: 7.5,
  par: 255,
  stars: { twoStarSeconds: 295, threeStarSeconds: 150 },
  targetSeconds: 150,
  combo: 12,
  dropChance: 0.08,
  legend: {
    M: { type: 'moving', color: 'cyan', move: { cells: 4, speed: 85 } },
    K: { type: 'indestructible', color: 'steel', move: { cells: 4, speed: 65 } },
  },
  layout: [
    'HHHHHHHHHH',
    'H#XOPPOX#H',
    'HOOOOOOOOH',
    '#RRRRRRRR#',
    '..........',
    'M....M....',
    '..........',
    'K....K....',
    '..........',
    'YGB#..#BGY',
  ],
});

export const CLASSIC_BOARDS: readonly BoardDefinition[] = [
  CLASSIC_01,
  CLASSIC_02,
  CLASSIC_03,
  CLASSIC_04,
  CLASSIC_05,
  CLASSIC_06,
  CLASSIC_07,
  CLASSIC_08,
  CLASSIC_09,
  CLASSIC_10,
  CLASSIC_11,
  CLASSIC_12,
];

export const CAMPAIGN_BOARDS = CLASSIC_BOARDS;

export function getCampaignBoard(id: string): BoardDefinition | undefined {
  return CAMPAIGN_BOARDS.find((b) => b.id === id);
}
