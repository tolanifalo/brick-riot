# Balance Config

Two config objects live in `packages/shared/src/config/`:

| File | Object | Affects replays? |
| ---- | ------ | ---------------- |
| `balance.ts` | `BALANCE` (`BalanceConfig`): physics, scoring, power-ups | **Yes**. Any change alters simulation results |
| `economy.ts` | `ECONOMY` (`EconomyConfig`): XP, coins, levels, mastery rewards | No. Applied after a run ends |
| `multiplayer/config.ts` | `MATCH_CONFIG`: timing and protocol limits | No (timing is server-side; see below) |
| `multiplayer/boards.ts` | `MULTIPLAYER_BOARD_PROFILES`: eligibility and expected times | No |
| `multiplayer/compatibility.ts` | `DEFAULT_COMPATIBILITY_POLICY` | No |
| `abilities/definitions.ts` | `ABILITY_DEFINITIONS`, `ABILITY_RULES` | **Yes** (multiplayer): costs, durations and effects change match simulations |
| `upgrades/upgrades.ts` | `UPGRADES`: costs, effects, power | Effects yes (via the per-player config); costs no |
| `abilities/equipment.ts` | Mode policies, upgrade cap, EPR policy | Yes (it decides which config applies) |

## Multiplayer

### `MATCH_CONFIG` (defaults; the server can override timing via env)
| Key | Value |
| --- | ----- |
| Tick rate | 120 Hz (shared with the engine) |
| Match length | 120 s (`MATCH_SECONDS`) |
| Countdown | 3 s (`COUNTDOWN_MS`) |
| Reconnect grace | 20 s (`RECONNECT_SECONDS`) |
| Lobby idle close | 15 min |
| Sync / preview cadence | every 6 ticks (20 Hz) / every 12 ticks (10 Hz) |
| Input lead limit | 240 ticks (2 s) |
| Inputs per message | 32 |
| Messages per client | 90/s refill, burst 150 (hard disconnect at 300/s) |
| Launches | 15/s |
| Resync requests | 2/s |
| Paddle target bounds | -480 to 960 (the simulation clamps to the field) |
| Code lookups | 20 per IP per minute; 10 wrong codes → 10-minute block |


### Multiplayer board profiles
Statistics come from **48 autoplayer seeds** under the multiplayer config
(`npm run compat -w @brick-riot/shared`). The full analysis is in
[BOARD_COMPATIBILITY.md](BOARD_COMPATIBILITY.md). **Bot estimates only**: profiles are
labelled `bot-estimate`, compatibility reports say "estimated", and nothing is
ranked-eligible until human playtests replace them. Profiles also store clear-time deciles
and the share of runs that beat the 120 s timer.

| Board | Eligible | Median | IQR | Beats 120 s | Band | Note |
| ----- | -------- | ------ | --- | ----------- | ---- | ---- |
| Twin Pillars (02) | yes | 81 s | 29 s | 94% | standard | Symmetric, moderate variance |
| Chevron (03) | yes | 42 s | 27 s | 100% | sprint | High relative variance; only fair against itself |
| Lattice (05) | yes | 54 s | 41 s | 100% | sprint | Short, wide upper tail |
| Fortress (07) | yes | 100 s | 64 s | 67% | standard | Long; see Fortress Sprint |
| Slipstream (08) | yes | 59 s | 25 s | 100% | sprint | Lowest variance |
| Gatekeeper (10) | yes | 97 s | 48 s | 75% | standard | Long; see Gatekeeper Sprint |
| **Fortress Sprint** (`classic-07-mp` v1) | yes | 86 s | 41 s | 81% | standard | Multiplayer variant |
| **Gatekeeper Sprint** (`classic-10-mp` v1) | yes | 82 s | 55 s | 90% | standard | Multiplayer variant |
| Reactor (11) | no | 76 s | 64 s | 77% | | Highest variance; most upgrade-sensitive (−24%) |
| Opening Riot, Corridor, Fuse Line, Staircase, Riot Finale | no | 185–316 s | | | | Far beyond a 120 s timer |

Variants have their own id and version and unlock with their base board. Campaign boards
are never modified for multiplayer.

### `DEFAULT_COMPATIBILITY_POLICY` (provisional)
| Key | Value | Effect |
| --- | ----- | ------ |
| maxExpectedTimeRatio | 1.15 | Slower/faster median above this → incompatible |
| maxDifficultyGap | 2 | Designer rating gap above this → incompatible |
| maxFirstClearSkew | 0.10 | Estimated P(board A clears first) outside 0.40–0.60 → incompatible (Phase 4) |
| highVarianceRatio | 0.6 | IQR/median above this → warning |
| timerPressureFraction | 0.9 | Median above 90% of the timer → warning |
| minTimerCompletionRate | 0.85 | Beats the 120 s timer in fewer runs than this → warning (Phase 4) |
| rankedRequiresHumanCalibration | true | Bot estimates are never ranked-eligible |

Incompatible pairs may still play an **unranked** private race if both players accept
it in the lobby. There are no handicaps or hidden bonuses. Same-board races are always
compatible. Compatible pairs of different boards with current data:

- Lattice / Slipstream
- Fortress / Gatekeeper
- Gatekeeper / Fortress Sprint
- Fortress Sprint / Gatekeeper Sprint

Twin Pillars / Gatekeeper Sprint match on time (1.01, P 0.48) but fail the difficulty gap
(4). The test `multiplayer.test.ts` locks this list. Phase 4 added rules; no tolerance was
raised.

## Abilities (Phase 4, `abilities/definitions.ts`)

Values are initial and conservative. Abilities unlock by player level (campaign XP) and
are never sold.

| Ability | Slot | Power | Unlock lvl | Energy | Cooldown | Effect |
| ------- | ---- | ----- | ---------- | ------ | -------- | ------ |
| EMP Pulse | offensive | 30 | 1 | 40 | 12 s | 2 s: target's wide/magnet/laser jammed (timers paused). Movement, ball, launch and timer untouched |
| Shrink Ray | offensive | 35 | 3 | 50 | 15 s | 3 s: paddle width × 0.85, never below 60 |
| Frost Brick | offensive | 40 | 5 | 60 | 18 s | Up to 5 s: a 2-hit ice block in open space below all bricks, ≥ 260 units above the paddle. Never required, no score, energy or combo |
| Shield | defensive | 25 | 1 | 35 | 15 s | 8 s: blocks the next attack, then is consumed |
| Cleanse | defensive | 20 | 2 | 30 | 12 s | Removes an active or incoming debuff; refused (free) if there is none |
| Precision Aim | passive | 20 | 3 | | | Paddle-offset rebound response × 1.12 (max angle unchanged) |
| Energy Accelerator | passive | 25 | 4 | | | Energy gains × 1.2 |
| Quick Relaunch | passive | 15 | 1 | | | Relaunch delay after a lost ball 0.5 s instead of 1 s |

### `ABILITY_RULES`
| Key | Value |
| --- | ----- |
| maxEnergy / startEnergy | 100 / 20 (+ Starting Energy upgrade in upgrade rooms) |
| openingLockoutSeconds | 5 (offensive only) |
| immunitySeconds | 5 after an offensive effect ends (expired, cleansed or shattered) |
| applyDelayTicks | 48 (0.4 s from acceptance to effect, which is also the "incoming" warning) |
| maxRequestsPerSecond | 6 |
| relaunchDelaySeconds | 1 (multiplayer; solo stays 0) |
| loadoutBudget | 80 power (default EMP + Shield + Quick Relaunch = 70) |

Combat rules: one offensive debuff at a time per player. No attacks while the target is
serving (ball not launched) or has finished. Simultaneous requests resolve in a fixed
order (client tick stamp, then seat). Refused requests cost nothing. A shield-blocked
attack costs the attacker energy and cooldown and consumes the shield. Size changes wait
(at most 2 s) while a ball is descending within 140 units of the paddle.

### Energy (`BALANCE.energy`, multiplayer only)
| Key | Value |
| --- | ----- |
| perDamage | 1 (non-lethal brick hit) |
| perDestroy | 3 |
| comboEvery / comboBonus | every 5th consecutive destroy → +5 |
| max | 100 |

Energy is stored in tenths in the simulation and is earned only from your own brick
damage, destruction and combos. Frost Bricks, movement, misses, pauses and reconnects
earn nothing.

### `BALANCE.sabotage`
| Key | Value |
| --- | ----- |
| minPaddleWidth | 60 |
| safetyZone | 140 |
| maxDeferSeconds | 2 |
| frostMinClearance | 260 |

## Workshop upgrades (`upgrades/upgrades.ts`)

Costs are per level, in coins. Effects are the cumulative total at that level, so returns
shrink at higher levels. Purchases are atomic, guarded against double-submits and never
allow negative coins.

| Upgrade | Level costs | Effect at each level | EPR power at each level |
| ------- | ----------- | -------------------- | ----------------------- |
| Paddle Control | 120 / 220 / 360 / 550 / 800 | +6 / 11 / 15 / 18 / 20% paddle speed | 2 / 4 / 5 / 6 / 7 |
| Paddle Width | 150 / 280 / 450 / 700 / 1000 | +3 / 5.5 / 7.5 / 9 / 10% width | 3 / 5 / 7 / 8 / 9 |
| Ball Power | 200 / 400 / 700 | 15 / 27 / 36% charge per multi-hit contact (full charge = +1 damage) | 3 / 5 / 7 |
| Magnet Duration | 100 / 200 / 350 | +2 / 3.5 / 4.5 s | 1 / 2 / 3 |
| Starting Energy | 150 / 300 / 500 / 750 | +5 / 9 / 12 / 14 energy (multiplayer) | 2 / 4 / 5 / 6 |

Maxing everything costs 8,280 coins.

### Equipment policies by mode (`abilities/equipment.ts`)
| Mode | Loadout | Upgrades |
| ---- | ------- | -------- |
| Solo | n/a | All levels apply (the run records them for replay verification) |
| Casual private room (default) | Yes | None |
| Casual room with upgrades on (host choice) | Yes | Signed in: the account's **server-verified** levels, trimmed to **20 upgrade power** per player, round-robin. Guests: none |
| Quick Match (Phase 5) | Yes (owned abilities) | None |
| Ranked (future) | Server-verified only | **Never** |

**Equipment Power Rating (EPR)** = sum of the definition power of the loadout's three
abilities plus the applied upgrade levels. XP is never an input. Since Phase 5, signed-in
players' equipment comes from the database. Guests' upgrade claims are ignored. Two players are
"even" when their EPRs differ by at most **15**. Otherwise the lobby warns and both must
accept the unranked race. Board compatibility and equipment compatibility are separate
checks.

`Simulation` accepts a per-player `config`. This is how loadout passives and upgrades
apply, built identically by server and client with `buildPlayerConfig`. **Opening Riot is
covered by golden replay fingerprints** (`golden.test.ts`). Solo with no upgrades uses
`BALANCE` itself, so those replays are unchanged. Changing any value Opening Riot uses
breaks Phase 1 replays. Bump board/config versions instead of editing in place for
verified play.

## Accounts and Quick Match (Phase 5)

### `MATCH_REWARDS` (`config/economy.ts`)
Signed-in players only, for a replay-verified, non-cancelled **Quick Match**. Private rooms
pay nothing.

| Result | XP | Coins |
| ------ | -- | ----- |
| Win | 40 | 10 |
| Draw | 25 | 5 |
| Loss | 15 | 3 |
| Forfeit (left / missed the reconnect deadline) | 0 | 0 |

At most **20 rewarded matches per player per day** (`dailyCap`). For comparison, a campaign
clear pays at least 100 XP / 20 coins before multipliers (see `ECONOMY`). Quick Match is
a side income, not a farm.

### `QUICK_POLICY` (`competitive/quickmatch.ts`, provisional)
| Key | Value | Meaning |
| --- | ----- | ------- |
| `baseSkillGap` | 150 | Allowed casual-rating gap, plus (deviation A + deviation B) / 4 |
| `widenAfterSeconds` / `widenPerSecond` | 15 / 6 | After 15 s of waiting the window grows 6 points per second… |
| `maxSkillGap` | 500 | …up to this gap |
| `beginnerGames` / `beginnerOpponentCeiling` | 10 / 30 | Players with < 10 games never meet players with ≥ 30 |
| `matchSeconds` | 120 | Used for the board-compatibility timer check |
| `queueTimeoutSeconds` | 300 | The search stops after 5 minutes |
| `QUICK_READY_SECONDS` (server env) | 20 | Time both players have to confirm |

Board pairs use `DEFAULT_COMPATIBILITY_POLICY` unchanged. Equipment uses the 15-point even
gap above. Loadout-only powers range from 65 to 80, so that check always passes in Quick
Match today.

### `GLICKO2` (`competitive/glicko2.ts`)
τ 0.5, initial rating 1500, deviation 350 (min 30), volatility 0.06. Used for the hidden
casual rating. The ranked divisions (`DIVISION_FLOORS`: Silver 1300, Gold 1500, Platinum
1700, Diamond 1900, on rating − 2·deviation; 10 placement matches) are defined but **not
used**, because ranked is disabled.

### `LEAD_POLICY` (`multiplayer/leadController.ts`)
| Key | Value | Meaning |
| --- | ----- | ------- |
| `baseMs` | 40 | Safety added to RTT/2 (the Phase 3/4 fixed lead) |
| `minTicks` / `maxTicks` | 3 / 36 | Bounds of the total lead (36 < the 48-tick ability delay) |
| `maxExtraTicks` | 24 | Bound of the adaptive part |
| `raiseTicks` | 3 | Added on any late input reported by the server |
| `comfortableMarginTicks` / `lowerAfterMs` | 3 / 3000 | Margins above 3 ticks for 3 s lower the lead by 1 tick |

## Fixed (`SIM`)
| Key | Value |
| --- | --- |
| tickRate | 120 Hz |
| world | 480 × 800 |

## `BALANCE`: core
| Group | Key | Value | Notes |
| ----- | --- | ----- | ----- |
| — | lives | 3 | balls per run |
| paddle | width × height | 88 × 14 | |
| paddle | y | 728 | centre |
| paddle | pointerMaxSpeed | 3600 u/s | effectively instant, but bounded for validation |
| paddle | keyboardSpeed | 900 u/s | |
| ball | radius | 7 | |
| ball | baseSpeed → maxSpeed | 430 → 720 u/s | +3 per brick contact; resets on a new serve |
| ball | maxStep | 3.5 | sub-step length (anti-tunnelling) |
| ball | launchSpread | 0.3 | fraction of the 60° range; seeded |
| rebound | maxTan | tan 60° | |
| safeguards | min angle from horizontal | 15° | |
| safeguards | stuckSeconds / nudgeRepeatSeconds | 10 / 2 | nudge = 10° rotation |
| scoring | destroy points | standard 50, reinforced 90, explosive 60, moving 70, powerup 50 | |
| scoring | hitPoints | 10 | non-lethal hit |
| scoring | comboStep / cap | 0.25 / 4× | |
| scoring | lifeBonus | 1000 | per ball remaining at clear |
| scoring | timeBonusPerSecond | 25 | per second under par |
| explosive | damage | 99 | to bricks within 1 cell (3×3) |

## `BALANCE.powerUps`
| Key | Value | Notes |
| --- | ----- | ----- |
| fallSpeed | 150 u/s | capsule fall |
| capsule | 32 × 14 | collection box |
| collectPoints | 25 | |
| maxPickups | 6 | further drops are skipped |
| maxBalls | 6 | multiball cap |
| multiball spread | ±25° | from the source ball |
| laserBoltSpeed | 900 u/s | |

| Power-up | Duration | Strength meaning | Strength | Drop weight | Cooldown |
| -------- | -------- | ---------------- | -------- | ----------- | -------- |
| Multiball | instant | extra balls | 2 | 18 | — |
| Wide Paddle | 12 s | width multiplier | 1.5 | 20 | — |
| Heavy Ball | 7 s | damage per contact (smash-through) | 99 | 12 | — |
| Magnet | 15 s | max hold seconds | 2.5 | 16 | — |
| Laser | 10 s | damage per bolt | 1 | 14 | 0.3 s |
| Bomb | 12 s (or one use) | blast radius in cells | 1 | 14 | — |

Rules:
- Collecting an active timed power-up refreshes it to full duration (no stacking).
- Losing a life clears all effects, capsules and bolts.
- Heavy and Bomb combine: a smashed brick also detonates.
- The launch input releases magnet-held balls and fires the laser.

Drops come from **power-up bricks** (always; fixed kind or weighted random) and from
other destroyed bricks with the board's `dropChance`. They use a separate seeded RNG
stream, so drops never change launch angles.

## `ECONOMY`
| Key | Value |
| --- | ----- |
| Level curve | 300 XP for level 2, ×1.18 per level, max level 60 |
| Clear base | 100 XP + 20 coins, plus 30 XP / 6 coins per difficulty point |
| Per star (time) | 25 XP / 5 coins |
| Per ball remaining | 15 XP / 4 coins |
| Best combo | 3 XP per point, capped at 60 |
| First clear | ×2 on the completion rewards above |
| Repeat clears | ×0.6ⁿ for the nth replay, floor ×0.1 |
| Star improvement | 40 XP / 10 coins per star gained over the board's best (no decay) |
| Mastery (one-time) | clear 40/10 · 2+ balls 60/15 · time 80/20 · no ball lost 100/25 · combo 80/20 · score 80/20 (XP/coins) |
| Losses | no rewards (the attempt is recorded) |

Anti-farming: rewards are only granted for **won, locally verified** runs, each run id is
applied once, replay rewards decay quickly, and mastery and star bonuses are one-time.
Restarting never grants anything.

## Campaign boards (CLASSIC)

Times are in seconds. 1★ = clear. Par is the clear-bonus reference and the estimated
completion target. The "fast" mastery objective equals the 3★ time.

| # | Board | Rating | Par | 2★ | 3★ | Combo mastery | Drop chance |
| - | ----- | ------ | --- | -- | -- | ------------- | ----------- |
| 1 | Opening Riot | 1.5 | 120* | 295 | 210 | ×8 | 0 |
| 2 | Twin Pillars | 2 | 90 | 105 | 75 | ×8 | 0.04 |
| 3 | Chevron | 2.5 | 75 | 90 | 50 | ×10 | 0.05 |
| 4 | Corridor | 3 | 195 | 225 | 120 | ×12 | 0.05 |
| 5 | Lattice | 3.5 | 55 | 60 | 40 | ×8 | 0.06 |
| 6 | Fuse Line | 4 | 185 | 215 | 105 | ×20 | 0.05 |
| 7 | Fortress | 4.5 | 130 | 150 | 85 | ×10 | 0.06 |
| 8 | Slipstream | 5 | 75 | 85 | 60 | ×8 | 0.06 |
| 9 | Staircase | 5.5 | 320 | 365 | 225 | ×10 | 0.06 |
| 10 | Gatekeeper | 6 | 135 | 155 | 95 | ×10 | 0.07 |
| 11 | Reactor | 6.5 | 85 | 100 | 55 | ×15 | 0.04 |
| 12 | Riot Finale | 7.5 | 255 | 295 | 150 | ×12 | 0.08 |

\* Opening Riot's par is frozen at its Phase 1 value (golden replays).

### How these were calibrated
`npm run calibrate -w @brick-riot/shared` plays every board with the scripted
autoplayer on 8 seeds and suggests par = median, 2★ = median × 1.15, 3★ = lower
quartile (rounded up to 5 s). The values above are those suggestions.

Caveats:
- The bot never loses a ball but aims worse than a skilled player. Clear times are
  therefore **not** strictly increasing with level: the designer rating also reflects
  ball-loss risk (moving lanes, gates), which the bot does not feel. Human playtesting
  should refine these numbers.
- Variance is high on precision boards (Staircase: 67 to 505 s; Corridor: 49 to 211 s).
- After calibration: Staircase lost its top row (median was 377 s), and Reactor's fused
  explosive core was split up and armoured (median was 39 s).
