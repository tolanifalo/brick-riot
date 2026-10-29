# BRICK RIOT

A mobile-first, browser-based competitive arcade brick-breaker. TypeScript monorepo:
Phaser 3 rendering, React UI, a deterministic simulation shared by client and server,
and a Colyseus server that runs multiplayer matches authoritatively.

**Status: Phase 5 (accounts, server-side progression, Quick Match) implemented; real-phone
testing not yet done** (see [REAL_DEVICE_TEST_PLAN.md](REAL_DEVICE_TEST_PLAN.md)).
- **Solo:** a 12-board campaign with unlocks, stars, mastery, XP and coins, six
  power-ups and moving bricks. Workshop upgrades apply.
- **Accounts (optional):** email + password accounts with email verification, password
  reset, session management and account deletion. Signed in, every reward, purchase,
  unlock and record is decided by the server, which replays your solo runs before paying
  out. Guests keep playing locally exactly as before. See [ACCOUNTS.md](ACCOUNTS.md).
- **Multiplayer:** private 1v1 rooms with a code (guests welcome) and **Quick Match**, a
  public casual queue that pairs real signed-in players (no bots). Server-authoritative
  results, reconnection, forfeits, rematches, and a three-slot ability **loadout**.
  Results of account matches are stored permanently.
- **Leaderboards:** best verified solo times and scores per board, mastery, and Quick
  Match wins. Every entry comes from a server-replayed run or a server-run match.
- **Not enabled:** public ranked play. The rating system (Glicko-2) is built and tested
  but switched off until boards are human-calibrated, real devices are tested and an
  anti-cheat review is done. See [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md).

## Requirements

- Node.js 22.9+ (developed on 24 LTS)
- Git (recommended; the project works without it)
- PostgreSQL for accounts: **no separate install needed** for development. `npm run
  db:start` runs a local PostgreSQL from the `embedded-postgres` npm package.

### Setting up version control (if Git is missing)

Git is not required to build or run the game, but it is strongly recommended.

```powershell
# Windows (built-in package manager); open a NEW terminal afterwards
winget install --id Git.Git -e --source winget
# or download the installer from https://git-scm.com/download/win

git --version
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"

cd C:\Users\USER\brick-riot
git init -b main
git add .
git commit -m "BRICK RIOT: Phase 1-2 baseline"
git switch -c phase-5-accounts
git add .
git commit -m "Phase 5: accounts, server progression, Quick Match"
```

Git was not installed on the development machine for Phases 1–5. `winget` failed with a
network error and then timed out, so a portable MinGit was installed at the end of Phase 5
(`%LOCALAPPDATA%\Programs\MinGit`). **The first commit holds Phases 1–5 together**; there is
no per-phase history. Before committing, check `git status`: `.env`, `.pgdata/` and
`src/generated/` must never appear.

`.gitignore` already excludes `node_modules`, build output (`dist`, `dist-e2e`), test
artefacts and `.env*` secrets. Note: Colyseus' optional uWebSockets transport is
fetched from GitHub; this project uses the plain WebSocket transport, so `npm install`
works without Git.

### Dependency audit and install scripts (checked in Phase 4)

- `npm audit` reports **0 vulnerabilities** as of the Phase 4 check.
- Two dependencies declare install scripts. Neither needs to run for the game to work:
  - **esbuild** (postinstall `node install.js`). It only verifies the platform binary,
    which ships prebuilt in `@esbuild/win32-x64`.
  - **msgpackr-extract** (install `node-gyp-build-optional-packages`). Optional native
    msgpack acceleration for Colyseus. It ships prebuilt in
    `@msgpackr-extract/msgpackr-extract-win32-x64`, and `msgpackr` falls back to pure
    JavaScript without it. It would only compile from source (needing build tools) if no
    prebuilt binary matched the platform.

If npm reports blocked or skipped install scripts, leave them blocked. Builds and tests
pass without them.

## Run locally

```bash
npm install
npm run db:start       # terminal 1: local PostgreSQL on 127.0.0.1:5433 (keep it running)
npm run db:seed        # once: reference data (the preseason)
npm run start:server   # terminal 2: game server on :2567 (prints LAN addresses)
npm run dev            # terminal 3: client on http://localhost:5173
```

**Windows shortcut:** double-click `start-dev.cmd` in the project folder. It opens the
three windows above and the game in your browser. Close those windows to stop.

Solo play works without any server. Without `db:start`, the game server still runs
private rooms for guests, and prints `accounts OFF`. Use `npm run dev:server` for
auto-reload while developing the server.

### Local database (embedded PostgreSQL)

- `npm run db:start` downloads nothing at run time: the PostgreSQL binaries come with the
  `embedded-postgres` dev dependency. The first run creates `packages/server/.pgdata/`,
  the `brickriot` database, applies the committed migrations (`prisma migrate deploy`) and
  writes `DATABASE_URL` to `packages/server/.env`. The server and Prisma read that file.
- It listens on **127.0.0.1 only** with a local-only password. It is for development, not
  production.
- Stop it with Ctrl+C. Data survives restarts. To start over, stop it and delete
  `packages/server/.pgdata` and the `DATABASE_URL` line in `packages/server/.env`.
- Back up: stop the database and copy the `.pgdata` folder, or with it running use
  `pg_dump` from any PostgreSQL client tools against `DATABASE_URL`.
- After changing `prisma/schema.prisma`: `npm run db:generate`, and add a new migration
  folder (see [ARCHITECTURE.md](ARCHITECTURE.md#database)).

### Accounts while developing

Emails (verification, password reset) are **not sent** in development. They go to an
in-memory outbox. Read the latest link for an address at
`http://localhost:2567/api/dev/outbox?to=you@example.com`. This endpoint only exists
when `DEV_MAIL_OUTBOX` is on, which production refuses. Sign-in works before
verification; leaderboards show verified accounts only.

### Test multiplayer with two browsers
1. Start the server and the client as above.
2. Open http://localhost:5173 in one browser window, and a **private/incognito window**
   (or a different browser) for the second player. Each browser profile can hold only
   one seat in a room.
3. Window 1: MULTIPLAYER → tick **Development room** → CREATE ROOM. Note the 6-letter
   code.
4. Window 2: MULTIPLAYER → JOIN ROOM → enter the code.
5. Pick a board in each window (they may differ), accept an uneven match-up if asked,
   and press READY in both.

Without a development room, boards must be unlocked: by your local campaign progress as
a guest, or by your server-side progress when signed in (clear Opening Riot to unlock
Twin Pillars, the first multiplayer board).

### Test Quick Match with two browsers
Needs `npm run db:start` running. In two separate browser profiles (one may be incognito),
register two accounts, clear Opening Riot in each while signed in, then press QUICK MATCH →
FIND OPPONENT in both. The queue only pairs real players; with one player searching you
see an honest waiting state.

### Test with two phones on the same Wi-Fi
1. Start the server and client on your PC. The server prints a `LAN: ws://192.168.x.x:2567`
   address; Vite's dev server also listens on the LAN (`host: true`).
2. Allow Node.js through Windows Defender Firewall (private networks) for ports **5173**
   and **2567** when prompted, or run, as administrator:
   `netsh advfirewall firewall add rule name="BRICK RIOT" dir=in action=allow protocol=TCP localport=5173,2567`
3. On each phone open `http://<PC LAN IP>:5173`. The client automatically connects to
   the server on the same host at port 2567.
4. Create a room on one phone and join with the code on the other.

To point the client at another server, set `VITE_SERVER_URL` (full URL) or
`VITE_SERVER_PORT` in `packages/client/.env.local`.

### Server configuration (environment variables)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` / `HOST` | 2567 / 0.0.0.0 | Listen address |
| `MATCH_SECONDS` | 120 | Match timer |
| `COUNTDOWN_MS` | 3000 | Start countdown |
| `RECONNECT_SECONDS` | 20 | Grace period before a dropped player forfeits |
| `LOBBY_IDLE_MINUTES` | 15 | Idle lobbies close |
| `ALLOW_DEV_ROOMS` | on unless `NODE_ENV=production` | Allow rooms that skip unlock checks |
| `ALLOWED_ORIGINS` | `*` (dev) | CORS origins for `/api` (comma-separated) |
| `TRUST_PROXY` | off | Trust `X-Forwarded-For` behind a reverse proxy |
| `CLOCK_SCALE` | 1 | Test-only clock speed (refused in production) |
| `TEST_START_ENERGY` | unset | Test-only: every player starts matches with this much ability energy (refused in production) |
| `DATABASE_URL` | unset (from `.env` after `db:start`) | PostgreSQL. Unset = no accounts, guest play only |
| `BETTER_AUTH_SECRET` | dev placeholder | Session signing secret. **Required, 32+ random characters, in production** |
| `PUBLIC_URL` | `http://localhost:PORT` | The server's public base URL (links in emails). Must be `https://` in production |
| `APP_URL` | `http://localhost:5173` | The client's URL (where email links land) |
| `MAIL_MODE` / `SMTP_URL` / `MAIL_FROM` | `outbox` / unset | `smtp` + an SMTP URL to really send email (required in production) |
| `DEV_MAIL_OUTBOX` | on unless production | Expose `/api/dev/outbox` (refused in production) |
| `QUICK_READY_SECONDS` | 20 | Time both Quick Match players have to confirm |
| `NET_DIAGNOSTICS` | off | Add per-player network timing to sync messages (refused in production) |
| `RELAXED_AUTH_LIMITS` | off | Test-only: 100× auth rate limits (refused in production) |

**Public hosting:** do not expose the server to the internet as-is. Put it behind a
reverse proxy that terminates **HTTPS/WSS** (session cookies and passwords must never
travel over plain HTTP), set `NODE_ENV=production` (which disables dev rooms, the dev
outbox and the test settings, and refuses to start without a real secret, SMTP and an
https `PUBLIC_URL`), set `ALLOWED_ORIGINS` to your site, and enable `TRUST_PROXY` only
behind that proxy. Use a managed or properly administered PostgreSQL with backups, not
the embedded development database.

## Scripts (from the repo root)

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Vite dev server for the client |
| `npm run start:server` / `npm run dev:server` | Multiplayer server (watch mode for `dev:server`) |
| `npm run db:start` | Local embedded PostgreSQL + migrations (development) |
| `npm run db:migrate` / `db:seed` / `db:generate` | Apply migrations / seed reference data / regenerate the Prisma client |
| `npm run build` | Typecheck all packages, then the production client build |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc` in every package |
| `npm test` | Vitest unit and integration tests (includes real-socket server tests; database tests start their own throwaway PostgreSQL) |
| `npm run e2e` | e2e build, then Playwright: desktop, phone, 3× DPR phone, **accounts** and **two-browser multiplayer** (starts its own server + throwaway database on :2599) |
| `npm run check` | lint + typecheck + test + build |
| `npm run calibrate -w @brick-riot/shared` | Autoplayer report of board clear times |
| `npm run compat -w @brick-riot/shared` | Multiplayer board distributions and pairwise fairness ([BOARD_COMPATIBILITY.md](BOARD_COMPATIBILITY.md)) |

First-time e2e setup: `npx playwright install chromium` in `packages/client`.

## Controls

| Action | Desktop | Mobile |
| ------ | ------- | ------ |
| Move | Mouse, ← → or A / D | Drag anywhere (incl. below the field) |
| Launch / fire laser / release magnet | Click or Space | Tap |
| Pause (solo only) | P or Esc, or HUD button | HUD button |
| Restart (solo only) | R | Overlay buttons |
| Offensive ability (multiplayer) | 1 (shown on the button) | Tap the left ability button |
| Defensive ability (multiplayer) | 2 (shown on the button) | Tap the right ability button |

Ability buttons work while another finger is dragging the paddle, and pressing them never
launches the ball.

## Layout

```
packages/
  shared/   simulation, boards, configs, progression, multiplayer protocol + compatibility (no I/O)
  client/   Vite + React + Phaser + Zustand; Colyseus SDK client with prediction
  server/   Colyseus match server + matchmaking queue, HTTP API, better-auth, Prisma/PostgreSQL
```

**Guest** progress (XP, coins, upgrades, preferred loadout, settings) is saved in the
browser's localStorage (`brick-riot:save`, format v2). It is a local convenience: it does
not prove identity or purchase ownership and is never trusted for competitive results.
**Signed-in** progress lives in PostgreSQL. A guest save can be imported once, and only
unlocks, records (marked "imported") and settings carry over, never coins, XP or upgrades
([ACCOUNTS.md](ACCOUNTS.md)).

Docs: [GAME_DESIGN](GAME_DESIGN.md) · [ARCHITECTURE](ARCHITECTURE.md) · [ACCOUNTS](ACCOUNTS.md) ·
[BALANCE_CONFIG](BALANCE_CONFIG.md) · [BOARD_COMPATIBILITY](BOARD_COMPATIBILITY.md) ·
[TESTING](TESTING.md) · [REAL_DEVICE_TEST_PLAN](REAL_DEVICE_TEST_PLAN.md) ·
[CHANGELOG](CHANGELOG.md)
