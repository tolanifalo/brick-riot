# Game Design

## Pillars

1. **Readable speed**: bright, high-contrast bricks on a dark field; the ball always
   stands out (white core, warm glow, short trail).
2. **Precise control**: the paddle follows the pointer almost instantly (3600 u/s cap).
   The rebound angle depends only on where the ball meets the paddle.
3. **Fair competition** (later phases): outcomes come from a deterministic simulation
   that the server can replay.

## Core loop (Phase 1)
Serve from the paddle → launch → break every *required* brick to win. Losing the last
ball in play costs one of 3 lives; losing the final life ends the run. You can restart
at any time. The clock starts at the first launch and stops while paused.

## Bricks
| Type | HP | Required | Behaviour |
| ---- | -- | -------- | --------- |
| Standard | 1 | yes | — |
| Reinforced | 2 (3 on some boards) | yes | Shows cracks after the first hit |
| Explosive | 1 | yes | Destroys bricks within 1 cell (3×3); chains |
| Power-up | 1 | yes | Always drops a capsule (fixed or random kind) |
| Moving | 1 | yes | Slides N cells right and back at a set speed |
| Indestructible | — | **no** | Deflects only. Can also move (moving steel gates) |

Moving bricks follow a triangle wave of the tick count (a pure function of time). The
validator guarantees their path stays inside the grid and crosses only empty cells.
Collisions use the brick's velocity (the ball reflects in the brick's frame), and a
final pass guarantees a ball never ends a tick inside a moving brick.

## Power-ups (Phase 2)
Capsules fall from destroyed bricks; catch them with the paddle.

| Power-up | Effect | Ends |
| -------- | ------ | ---- |
| Multiball | Splits the lead ball into three (±25°) | Extra balls last until they fall |
| Wide Paddle | Paddle ×1.5 | 12 s |
| Heavy Ball | Smashes through breakable bricks without bouncing | 7 s |
| Magnet | Paddle catches balls; launch releases (auto after 2.5 s) | 15 s; held balls released |
| Laser | Launch input fires twin bolts (0.3 s cooldown) | 10 s |
| Bomb | Next brick contact detonates a 3×3 blast | One use or 12 s |

Multiball and lives: a life is lost only when the **last** ball drains. Losing a life
clears all power-ups.

## Scoring
- Destroy points by type, multiplied by the **combo**: each consecutive destroy without
  touching the paddle adds +0.25×, capped at 4×. Touching the paddle or losing a ball
  resets it.
- Damaging a multi-hit brick without breaking it gives 10 points. Catching a capsule
  gives 25.
- **Clear bonus**: 1000 per ball remaining, plus 25 per whole second under par.

## Solo campaign (Phase 2)
12 handcrafted CLASSIC boards, each unlocked by clearing the previous one:

| # | Board | Idea |
| - | ----- | ---- |
| 1 | Opening Riot | Fundamentals: reinforced crown, two explosives, steel studs |
| 2 | Twin Pillars | Symmetric armoured towers with a channel; first power-up bricks |
| 3 | Chevron | Downward V; angled shots, explosive heart |
| 4 | Corridor | Steel vault entered through a two-cell gap: precision |
| 5 | Lattice | Checkerboard of armour; the ball rattles through the gaps |
| 6 | Fuse Line | Asymmetric diagonal explosive chain over a steel shelf |
| 7 | Fortress | Triple-armour walls around a loaded core, single gate |
| 8 | Slipstream | First moving bricks: two sliding lanes |
| 9 | Staircase | Asymmetric steel staircase; rebound angles open the upper left |
| 10 | Gatekeeper | Moving steel gates in front of an armoured bank |
| 11 | Reactor | Armoured explosive core ringed by fast sliding lanes |
| 12 | Riot Finale | Armour, steel, explosives, sliding lanes and gates combined |

Every board is cleared by the scripted autoplayer on 5 seeds in the test suite
(8 in calibration).

**Stars**: 1★ clear; 2★ and 3★ for clearing under the board's time thresholds.
**Mastery**: five objectives per board: clear; clear with 2+ balls left; clear under
the 3★ time; clear without losing a ball; reach a combo target. Each pays a one-time
reward and is shown with its progress on the campaign screen.

## Progression and rewards
- XP sets the player level (curve in BALANCE_CONFIG.md). XP is never a competitive
  rank.
- XP and coins come from verified wins: completion (scaled by difficulty), stars,
  balls remaining, best combo, first-clear ×2, star improvements and mastery.
- Replays still improve personal records but earn decaying completion rewards.
- Coins buy permanent **Workshop upgrades** (Phase 4; see below).

## Multiplayer (Phase 3)
A simultaneous 1v1 **race on separate boards**. Each player controls their own paddle
and ball on their own board, and **the boards may differ**.

**Rules** (decided by the server on authoritative ticks):
- The first player to destroy every required brick wins.
- Running out of balls does not end the match; the other player keeps playing and wins
  if they clear. If both run out of balls, it is a draw.
- A match lasts 120 s (configurable). If neither player clears, it is a draw.
- Clearing on the same tick is a draw; otherwise the earlier tick wins.
- A dropped player has a grace period (20 s by default) to reconnect. The match keeps
  running meanwhile (their paddle holds still). Missing the deadline forfeits. If
  neither player is present when a deadline passes, there is no contest.
- Leaving deliberately during a match forfeits.
- No pause, no restart, and three balls each. Power-up bricks and drops work as in solo,
  each player on their own board.

**Flow**: Multiplayer → Create (get a 6-character code) or Join (enter the code) →
lobby: pick a board and ready up (an uneven match-up must be accepted by both) →
server countdown → race → result (identical on both screens, server-verified) →
rematch or leave.

**Board choice**: only multiplayer-reviewed boards (6 of 12 campaign boards: Twin
Pillars, Chevron, Lattice, Fortress, Slipstream, Gatekeeper), plus two versioned
multiplayer variants (Fortress Sprint, Gatekeeper Sprint) that shorten long boards for
the 120 s timer. All are unlocked through the campaign; development rooms ignore unlocks
for testing. The game rates how comparable two boards are, using medians, difficulty and
the estimated chance each board clears first (BOARD_COMPATIBILITY.md). It never adds
handicaps or hidden bonuses: first to clear wins.

**Screen**: your board fills a portrait phone screen. A compact strip on top shows the
opponent's name, board, clear %, balls, connection state and a live miniature board,
plus the match timer. Desktop adds a larger opponent preview.

All multiplayer matches are **unranked** and grant no XP or coins. Rewards and ranked
play need verified accounts (Phases 5-6).

## Abilities and limited sabotage (Phase 4)
Sabotage adds pressure but must never decide a race by itself. Design rules:
- **Never touches the core**: no ability changes lives, the ball's physics, launching,
  the timer or the board's required bricks. Nothing is permanent.
- **Telegraphed**: an accepted attack lands 0.4 s later, and the target sees "INCOMING".
- **Limited**: one offensive effect at a time per player, then 5 s of immunity. No
  attacks in the first 5 s, and none while the target is serving.
- **Counterplay**: Shield blocks the next attack; Cleanse removes an active one.
- **Fair failure**: refused requests (no energy, cooldown, immune, no space, …) cost
  nothing. A blocked attack still costs the attacker.

**Loadout** (three slots, chosen in the lobby, locked at the countdown, visible to both):

| Slot | Options |
| ---- | ------- |
| Offensive | **EMP Pulse**: jams the opponent's wide/magnet/laser power-ups for 2 s · **Shrink Ray**: −15% paddle width for 3 s · **Frost Brick**: a 2-hit ice block in open space on their board for up to 5 s |
| Defensive | **Shield**: blocks the next attack within 8 s · **Cleanse**: removes the current effect |
| Passive | **Precision Aim**: sharper paddle aim · **Energy Accelerator**: +20% energy · **Quick Relaunch**: 0.5 s relaunch instead of 1 s |

Each ability has a power cost, and a loadout must fit an 80-power budget. Abilities
unlock with player level, never with money. The beginner loadout is EMP + Shield + Quick
Relaunch.

**Energy** (0–100, shown as a bar; start 20) comes only from breaking your own bricks:
+1 per hit, +3 per brick destroyed, +5 every 5th destroy in a combo. Values, costs and
cooldowns are in BALANCE_CONFIG.md.

**Safety details**:
- Shrink waits up to 2 s while a ball is about to reach the paddle, so it can never cause
  an unavoidable miss.
- Frost spawns only below every brick, clear of balls and capsules and well above the
  paddle, so it can never trap a ball or seal a route. If there is no safe space, the
  request is refused for free.

**Controls**: ability buttons under the board (tap; they work while another finger
drags), keys **1** (offensive) and **2** (defensive) on desktop.

## Workshop and equipment (Phase 4)
Five permanent upgrades are bought with coins: Paddle Control, Paddle Width, Ball Power,
Magnet Duration and Starting Energy. Each has diminishing returns and is confirmed
before purchase.

- **Solo**: all upgrades apply.
- **Private multiplayer**: the host chooses *Standard* (loadouts only, the default) or
  *Upgrades on* (upgrades apply, trimmed to 20 power per player).
- **Ranked**: never.

The **Equipment Power Rating** (EPR) shows how strong a player's equipment is: loadout
power plus applied upgrades. It is not XP and is not combined with skill or rank. If two
players' EPRs differ by more than 15, the lobby warns and both must accept an uneven,
unranked race. Equipment and board fairness are separate checks.

Local saves are not proof of ownership. Since Phase 5, only signed-in players' upgrades
(owned on the server) ever apply in multiplayer; guests play without upgrades.

## Accounts and progression (Phase 5)
Accounts are optional; everything a guest could do before still works. Signing in
makes progress **server-verified**:
- The server picks each run's seed and replays the inputs before paying rewards.
- Coins, XP, upgrades, ability unlocks and board unlocks are kept on the server.
- A guest save can be imported **once**. It carries over unlocks, records (marked
  "imported", never on leaderboards), settings and the preferred loadout, but never
  coins, XP or upgrades. The import screen says exactly what was left behind. See
  ACCOUNTS.md.

## Quick Match (Phase 5)
A public **casual** 1v1 against a real signed-in player. There are no bots: if nobody
suitable is searching, the player sees how long they have waited and how many players
are searching, and can cancel. The search stops after 5 minutes.
- **Boards**: each player lists up to three unlocked multiplayer boards. The matchmaker
  picks the most-preferred pair the compatibility rules rate fair, so players often race
  on **different** boards. If they allowed it, a player may get a suggested alternative,
  which is always labelled with the reason. A board is never changed silently.
- **Fairness checks**, kept separate: similar hidden skill (the window widens with
  waiting), compatible boards, even equipment (loadouts only; upgrades never apply), and
  beginner protection (fewer than 10 games never meets 30+).
- **Confirm**: both see the opponent, both boards and the reason for theirs, then press
  READY within 20 s. Whoever doesn't confirm returns to the Quick Match screen with a
  notice and is not requeued. The other player is put back in the queue automatically.
- The race uses the Phase 3 rules. A verified result is stored permanently, updates the
  hidden casual skill estimate and pays a small reward (none for a forfeit; at most 20
  rewarded matches a day). **No rating points are shown and nothing is ranked.**

## Leaderboards (Phase 5)
Per board: best verified clear time and best verified score. Overall: mastery objectives
completed and Quick Match wins. Every entry is backed by a server-replayed run or a
server-run match. Only accounts with a verified email are listed. The Ranked tab says
plainly that ranked play is switched off and why.

## Not built yet
Public **ranked** play (the rating system exists but is disabled until boards are
human-calibrated, real devices are tested and anti-cheat is reviewed), the
CIRCUIT/TIDAL/VOID collections, audio, and a full settings screen. See
DEVELOPMENT_ROADMAP.md.
