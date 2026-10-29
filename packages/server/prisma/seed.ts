/**
 * `npm run db:seed`: reference data only. Idempotent; safe to run repeatedly.
 *
 * Deliberately creates NO players, matches, ratings or leaderboard entries:
 * every competitive row must come from a verified event, and seeded "players"
 * would show up on public leaderboards as invented data.
 */
import { createDb } from '../src/db/client';
import { PRESEASON } from '../src/progression/provision';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run `npm run db:start` first (it writes packages/server/.env).');
  process.exit(1);
}

const db = createDb(url, 1);
try {
  // The casual skill estimate and verified leaderboards live in the preseason.
  // Ranked seasons are added when public ranked is switched on (see ROADMAP).
  await db.season.upsert({
    where: { id: PRESEASON },
    create: { id: PRESEASON, name: 'Preseason (unranked)', startsAt: new Date('2026-10-28T00:00:00Z'), active: true },
    update: {},
  });
  console.log(`Seeded season "${PRESEASON}".`);
} finally {
  await db.$disconnect();
}
