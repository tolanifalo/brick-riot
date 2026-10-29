-- 0.6.0: endless levels. Two account-wide leaderboards.
-- (Per-level boards keep using solo_time / solo_score; their boardId now carries
-- the board version for versions > 1, e.g. 'classic-01@v2'.)
ALTER TYPE "LeaderboardCategory" ADD VALUE 'highest_level';
ALTER TYPE "LeaderboardCategory" ADD VALUE 'total_stars';
