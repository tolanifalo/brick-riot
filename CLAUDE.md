# CLAUDE.md: BRICK RIOT

Competitive arcade brick-breaker. The master spec was given in the first session;
phase plan in DEVELOPMENT_ROADMAP.md. **Work one phase at a time. Do not start the
next phase until the current one is playable and verified.**

## Environment
- Windows + PowerShell. Node is a portable install at
  `%LOCALAPPDATA%\Programs\node-v24.22.1-win-x64` (on the user PATH; in tool shells you
  may need `$env:Path = "$env:LOCALAPPDATA\Programs\node-v24.22.1-win-x64;$env:Path"`).
- Git is a portable MinGit at `%LOCALAPPDATA%\Programs\MinGit\cmd\git.exe` (not on
  PATH in tool shells). Never commit or push on the user's behalf without being asked.
- Accounts need PostgreSQL: `npm run db:start` (embedded-postgres, 127.0.0.1:5433,
  writes `packages/server/.env`). Tests start their own throwaway instances.

## Commands (repo root)
`npm run check` (lint + typecheck + test + build) must pass before reporting work as
done. `npm run e2e` runs browser tests (single worker; slow under software WebGL).

## Rules
- **Gameplay rules live only in `packages/shared`.** Phaser code renders and forwards
  input; it never decides outcomes. The server must be able to replay everything.
- Keep the sim deterministic: no `Math.random`, `Date`, or `Math.sin/cos/tan`
  in the step path. Use the seeded RNG streams and `TRIG` literals. Iterate
  collections in stable id order.
- `test/golden.test.ts` freezes Phase 1 replays of Opening Riot. **Never update those
  snapshots to make a test pass.** New engine features must be no-ops for boards that
  don't use them. Opening Riot's layout, legend, grid and par are frozen.
- After changing a campaign board or anything that affects clear times, run
  `npm run calibrate -w @brick-riot/shared` and update the board's par/stars and
  BALANCE_CONFIG.md. Never claim a board is beatable without the playtest test passing.
- Progression rules (stars, rewards, mastery, unlocks, save format) live in
  `shared/src/progress` as pure functions. The client only loads/saves through
  `ProgressRepository`. A save-format change needs `SAVE_VERSION` + a migration + a test.
- Local progress is never authoritative; don't route it into competitive features.
- E2E hooks (`window.__BRICK_RIOT_E2E__`) must stay behind `E2E_ENABLED` so production
  builds exclude them.
- Tunables go in `BalanceConfig` (and BALANCE_CONFIG.md), not inline constants.
- Boards are data (`BoardDefinition`). New brick types: add to `BRICK_TYPES`,
  implement in the sim, then add to `ENGINE_SUPPORTED_BRICK_TYPES`.
- Never trust the client for wins, currency or ranked results.
- UI must not fake features: unbuilt items are disabled and labelled "Unavailable".
- Strict TS, no `any`/`@ts-ignore`/eslint-disable to silence errors. Every gameplay
  change gets a Vitest test.
- Keep docs aligned with reality (README, ARCHITECTURE, GAME_DESIGN, BALANCE_CONFIG,
  BOARD_COMPATIBILITY, TESTING, REAL_DEVICE_TEST_PLAN, CHANGELOG, ROADMAP).
- **Multiplayer authority**: the server (`MatchEngine` + `MatchRoom`) decides
  everything. Clients send intentions only. Never add a client message that sets
  scores, bricks, lives, positions, completion or results. Every new message needs
  validation, rate limiting and a forged-message test.
- Race rules live in `MatchEngine.evaluate` and are unit-tested per rule; changing a
  rule means changing GAME_DESIGN.md and its tests.
- Multiplayer must stay replay-verifiable: anything that changes a player's simulation
  (future sabotage effects) goes through the applied input log.
- Board compatibility thresholds and multiplayer board stats are PROVISIONAL
  (bot-estimated). Never mark them `human-playtest` without real playtest data.
- No real client-side outcome: the local "clear" is only a prediction. Show results
  only from the server's `result` message.
- **Abilities (Phase 4)**:
  - All ability logic lives in the shared simulation (`applyExternal`, debuff state) and
    `AbilityArbiter`. Never add a second effect engine on the server or client.
  - Effects reach a simulation only as `TickInput.ext` commands scheduled by the
    arbiter. They must be no-ops for solo/golden replays.
  - Clients may only *request* abilities; never let a client message carry `ext`,
    energy or cooldowns.
- Ability values, upgrade costs and effects, budgets and equipment policies live in
  `shared/src/abilities` and `shared/src/upgrades`. Changing them means updating
  BALANCE_CONFIG.md and the tests.
- Upgrades never apply in ranked play. Local upgrade levels and unlocks are claims, never
  proof of ownership. EPR is computed from definitions only (never XP) and stays
  `verified: false` until server-side ownership exists.
- **Multiplayer variants**: never edit campaign boards for multiplayer balance. Add or
  change a `<base>-mp` variant in `multiplayer/boards.ts` and **bump its version** on any
  layout change. Then re-run `npm run compat -w @brick-riot/shared` and update the SPECS
  data and BOARD_COMPATIBILITY.md. Never loosen compatibility tolerances to make pairs
  pass.
- Test-only server settings (`CLOCK_SCALE`, `TEST_START_ENERGY`) must stay refused under
  `NODE_ENV=production`.
- **Accounts (Phase 5)**: for signed-in players the server is the only source of XP,
  coins, upgrades, unlocks, loadouts and records. Rewards come only from server replays or
  server-run matches, through the idempotent ledger (unique keys). Never import coins,
  XP, upgrades or competitive data from local saves (ACCOUNTS.md). Guests get no upgrades
  in multiplayer.
- Schema changes need a new committed migration (plus any CHECKs/triggers) and a
  `db.schema.test.ts` case. Never edit an applied migration.
- Never log passwords, session tokens, reset/verification links or game tickets.
- Public ranked stays disabled until its blockers (`/api/ranked/status`) are resolved. Never
  display ratings or divisions as ranked.
- Don't claim real-device results. REAL_DEVICE_TEST_PLAN.md is the checklist; record
  actual runs in its results log.
- **File encoding**: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and treats
  backticks in double-quoted strings as escapes. Edit files with the editor tools, not
  `Get-Content`/`Set-Content` round trips. `encoding.test.ts` guards against regressions.
- Visual style: dark ink field, saturated brick palette, sharp 2px-radius slabs, Bungee
  display type, solid offset shadows only. No glassmorphism, soft gradients or emojis.
