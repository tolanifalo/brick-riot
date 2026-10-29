# Accounts, server progression and the guest-save import

Phase 5. This page covers what an account is, what the server trusts, and exactly what
carries over from a local guest save. The code it describes is in `packages/server/src/auth`,
`src/progression` and `src/persistence`.

## Guests and accounts

| | Guest (default) | Signed in |
| - | - | - |
| Solo campaign | Yes, saved in this browser | Yes, saved on the server |
| XP, coins, upgrades | Local and unverified | Server-side, from verified runs and matches only |
| Private rooms (code) | Yes, with **no upgrades** | Yes, with the account's verified loadout and upgrades |
| Quick Match | No (sign-in required) | Yes, casual |
| Leaderboards | View only | Listed once the email is verified |
| Ranked | No | Not enabled for anyone yet |

Signing in does not alter or delete the guest save. Signing out returns the browser to the
untouched guest progress.

## Authentication (better-auth)

- Email and password. Passwords are 10–128 characters and are hashed with scrypt by
  better-auth. They are never stored or logged in plain text, and neither are session or
  reset tokens.
- Sessions are HTTP-only cookies (`brickriot.*`, `SameSite=Lax`, `Secure` when
  `PUBLIC_URL` is https). They expire after 7 days, and the expiry is refreshed at most
  once a day.
- Profile → Account lists your sessions and can sign out every other device. A password
  reset signs out every session.
- **Email verification**: a link valid for 24 hours. Signing in works before verifying.
  Leaderboards only list verified accounts.
- **Password reset**: the response never reveals whether an account exists. The link is
  valid for one hour and works once.
- **Account deletion** requires your password. It removes the account, sessions,
  profile, progress, purchases, ledger, ratings and leaderboard entries (database
  cascades). Match records stay immutable for your opponents' history, but your seat in
  them is detached from the account. The display name recorded at match time remains in
  the opponent's history. (Limitation: there is no name scrubbing yet.)
- **Rate limits** (per IP, stored in the database): sign-in 5/min; sign-up 5 per 10 min;
  reset requests 3 per 10 min; verification resend 3 per 10 min; everything else 100/min.
  The client IP comes from the socket, or from `X-Forwarded-For` only with `TRUST_PROXY=1`.
  A client-supplied IP header is overwritten.
- **CSRF**: better-auth checks the Origin against `APP_URL` and `ALLOWED_ORIGINS`. Our own
  state-changing routes require an allowed Origin (or none, for non-browser clients) and
  a JSON body, which a cross-site HTML form cannot send.
- Game connections: the client exchanges its session for a **game ticket** (random,
  single-use, valid 60 s) and passes it when joining a room. The room redeems it on the
  server; a client cannot claim to be someone else.

## What the server trusts

Nothing the client says about its progress. In particular:

- **Solo rewards.** The server issues a run first, choosing the seed and snapshotting the
  account's upgrade levels. When the run ends, the client submits its **inputs only**. The
  server replays them with the shared deterministic simulation. Only a replay that
  finishes counts, and rewards come from the replayed result. A run can be claimed once;
  resubmitting returns the stored result.
- **Purchases.** The server checks the price, your server balance and the current level in
  one transaction. The request carries an `Idempotency-Key`, so a retried request never
  charges twice, and a stale request (wrong expected level) is refused. Coins are integer
  ledger entries; the database refuses negative balances.
- **Loadouts.** These must be abilities the account owns. Abilities are granted by the
  server as you level up.
- **Match equipment.** The account's verified loadout and upgrades are loaded on the
  server when the player joins a room. They are locked in when the match starts. Guests
  play with no upgrades.
- **Match results.** These are written once by the server that ran the match, in one
  transaction with the participants and any rewards. Database triggers refuse later edits.

## Importing a guest save

Profile → Account → **Import guest progress** (once per account). The import reads this
browser's local save and reports exactly what it did and did not take.

| Imported | Not imported (cannot be verified) |
| - | - |
| Board unlocks earned by your local clears (source `import`) | XP and level |
| Personal records, shown as **imported** and kept apart from verified records | Coins |
| Settings (reduced effects) | Workshop upgrade levels |
| Preferred loadout, if the account already owns those abilities | Mastery objectives and their rewards |
| | Run history, match results, any competitive data |

- Imported records never reach leaderboards, and never pay XP or coins. Clearing the board
  again while signed in creates a verified record that replaces the imported one in your
  profile.
- **Known limitation:** imported unlocks give access to later boards, including the matching
  multiplayer boards in casual Quick Match, without proof that you cleared them. That is
  accepted for casual play: a player could equally have cleared them. Ranked, when enabled,
  must use verified clears only (see DEVELOPMENT_ROADMAP.md).
- The save is re-parsed and validated on the server (size limit 512 KB). A second import
  returns `already_imported`.

## Data kept

Email, display name, password hash (in better-auth's `account` table), sessions (token,
IP address, user agent, expiry), profile, progress, purchases, the coin and XP ledger,
ratings, leaderboard entries, match participation and solo-run evidence (gzipped inputs,
kept for verification). No payment data.
