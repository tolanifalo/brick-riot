-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "UnlockSource" AS ENUM ('default', 'progression', 'import');

-- CreateEnum
CREATE TYPE "SoloRunStatus" AS ENUM ('issued', 'verified', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('coins', 'xp');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('solo_reward', 'match_reward', 'upgrade_purchase');

-- CreateEnum
CREATE TYPE "MatchMode" AS ENUM ('private', 'quick');

-- CreateEnum
CREATE TYPE "LeaderboardCategory" AS ENUM ('solo_time', 'solo_score', 'mastery', 'casual_wins');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_profile" (
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "selectedCosmetic" TEXT,
    "selectedBoardId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_profile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "solo_board_progress" (
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "completions" INTEGER NOT NULL DEFAULT 0,
    "bestScore" INTEGER,
    "bestTimeTicks" INTEGER,
    "bestStars" INTEGER NOT NULL DEFAULT 0,
    "bestCombo" INTEGER NOT NULL DEFAULT 0,
    "masteryDone" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstClearedAt" TIMESTAMP(3),
    "lastPlayedAt" TIMESTAMP(3),

    CONSTRAINT "solo_board_progress_pkey" PRIMARY KEY ("userId","boardId")
);

-- CreateTable
CREATE TABLE "board_unlock" (
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "boardVersion" INTEGER NOT NULL,
    "source" "UnlockSource" NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_unlock_pkey" PRIMARY KEY ("userId","boardId")
);

-- CreateTable
CREATE TABLE "solo_run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "boardVersion" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "upgrades" JSONB NOT NULL,
    "status" "SoloRunStatus" NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "summary" JSONB,
    "inputs" BYTEA,
    "rejectReason" TEXT,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "coinsAwarded" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "solo_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owned_ability" (
    "userId" TEXT NOT NULL,
    "abilityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owned_ability_pkey" PRIMARY KEY ("userId","abilityId")
);

-- CreateTable
CREATE TABLE "loadout" (
    "userId" TEXT NOT NULL,
    "offensive" TEXT NOT NULL,
    "defensive" TEXT NOT NULL,
    "passive" TEXT NOT NULL,
    "equipmentPower" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loadout_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "upgrade_level" (
    "userId" TEXT NOT NULL,
    "upgradeId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upgrade_level_pkey" PRIMARY KEY ("userId","upgradeId")
);

-- CreateTable
CREATE TABLE "purchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "upgradeId" TEXT NOT NULL,
    "fromLevel" INTEGER NOT NULL,
    "toLevel" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "type" "LedgerType" NOT NULL,
    "sourceEvent" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "mode" "MatchMode" NOT NULL,
    "devMode" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "winnerSeat" TEXT,
    "startTick" INTEGER NOT NULL,
    "endTick" INTEGER NOT NULL,
    "durationTicks" INTEGER NOT NULL,
    "ticksPerSecond" INTEGER NOT NULL,
    "equipmentMode" TEXT NOT NULL,
    "replayVerified" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "record" JSONB NOT NULL,
    "compatibility" JSONB,

    CONSTRAINT "match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_participant" (
    "matchId" TEXT NOT NULL,
    "seat" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "boardVersion" INTEGER NOT NULL,
    "completionTick" INTEGER,
    "exhaustedTick" INTEGER,
    "score" INTEGER NOT NULL,
    "ballsRemaining" INTEGER NOT NULL,
    "bricksCleared" INTEGER NOT NULL,
    "bricksTotal" INTEGER NOT NULL,
    "forfeited" BOOLEAN NOT NULL,
    "result" TEXT NOT NULL,
    "equipment" JSONB NOT NULL,
    "equipmentPower" INTEGER NOT NULL,
    "ratingBefore" DOUBLE PRECISION,

    CONSTRAINT "match_participant_pkey" PRIMARY KEY ("matchId","seat")
);

-- CreateTable
CREATE TABLE "season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating" (
    "userId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "deviation" DOUBLE PRECISION NOT NULL DEFAULT 350,
    "volatility" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "placementRemaining" INTEGER NOT NULL DEFAULT 10,
    "division" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rating_pkey" PRIMARY KEY ("userId","queue","seasonId")
);

-- CreateTable
CREATE TABLE "leaderboard_entry" (
    "category" "LeaderboardCategory" NOT NULL,
    "boardId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "achievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_entry_pkey" PRIMARY KEY ("category","boardId","seasonId","userId")
);

-- CreateTable
CREATE TABLE "local_import" (
    "userId" TEXT NOT NULL,
    "saveHash" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" JSONB NOT NULL,

    CONSTRAINT "local_import_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "imported_record" (
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "completions" INTEGER NOT NULL,
    "bestScore" INTEGER,
    "bestTimeMs" INTEGER,
    "bestStars" INTEGER NOT NULL,

    CONSTRAINT "imported_record_pkey" PRIMARY KEY ("userId","boardId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_key_key" ON "rate_limit"("key");

-- CreateIndex
CREATE INDEX "player_profile_level_idx" ON "player_profile"("level");

-- CreateIndex
CREATE INDEX "solo_run_userId_issuedAt_idx" ON "solo_run"("userId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_userId_idempotencyKey_key" ON "purchase"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_userId_upgradeId_toLevel_key" ON "purchase"("userId", "upgradeId", "toLevel");

-- CreateIndex
CREATE INDEX "ledger_entry_userId_createdAt_idx" ON "ledger_entry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_userId_idempotencyKey_currency_key" ON "ledger_entry"("userId", "idempotencyKey", "currency");

-- CreateIndex
CREATE INDEX "match_finalizedAt_idx" ON "match"("finalizedAt");

-- CreateIndex
CREATE INDEX "match_participant_userId_idx" ON "match_participant"("userId");

-- CreateIndex
CREATE INDEX "match_participant_boardId_boardVersion_idx" ON "match_participant"("boardId", "boardVersion");

-- CreateIndex
CREATE INDEX "rating_queue_seasonId_rating_idx" ON "rating"("queue", "seasonId", "rating");

-- CreateIndex
CREATE INDEX "leaderboard_entry_category_boardId_seasonId_value_idx" ON "leaderboard_entry"("category", "boardId", "seasonId", "value");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solo_board_progress" ADD CONSTRAINT "solo_board_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_unlock" ADD CONSTRAINT "board_unlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solo_run" ADD CONSTRAINT "solo_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owned_ability" ADD CONSTRAINT "owned_ability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadout" ADD CONSTRAINT "loadout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrade_level" ADD CONSTRAINT "upgrade_level_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating" ADD CONSTRAINT "rating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_entry" ADD CONSTRAINT "leaderboard_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_import" ADD CONSTRAINT "local_import_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_record" ADD CONSTRAINT "imported_record_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---- Integrity rules Prisma cannot express ----------------------------------

-- Balances and levels can never go negative or out of range, whatever the code does.
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_coins_nonnegative" CHECK ("coins" >= 0 AND "coins" <= 100000000);
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_xp_nonnegative" CHECK ("xp" >= 0 AND "xp" <= 100000000);
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_level_positive" CHECK ("level" >= 1);
ALTER TABLE "upgrade_level" ADD CONSTRAINT "upgrade_level_range" CHECK ("level" >= 0 AND "level" <= 10);
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_cost_positive" CHECK ("cost" > 0 AND "toLevel" = "fromLevel" + 1);
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_nonzero" CHECK ("amount" <> 0 AND "balanceAfter" >= 0);
ALTER TABLE "solo_board_progress" ADD CONSTRAINT "solo_board_progress_counts" CHECK ("attempts" >= 0 AND "completions" >= 0 AND "completions" <= "attempts" AND "bestStars" BETWEEN 0 AND 3);

-- Finalised matches are immutable: results can never be edited after the fact.
CREATE OR REPLACE FUNCTION "match_is_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'match % is finalised and cannot be modified', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "match_no_update" BEFORE UPDATE ON "match"
  FOR EACH ROW EXECUTE FUNCTION "match_is_immutable"();

-- Participants are immutable too, except that deleting an account detaches it (userId -> NULL).
CREATE OR REPLACE FUNCTION "match_participant_is_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS NULL AND OLD."userId" IS NOT NULL
     AND (to_jsonb(NEW) - 'userId') = (to_jsonb(OLD) - 'userId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'match participant %/% is finalised and cannot be modified', OLD."matchId", OLD."seat";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "match_participant_no_update" BEFORE UPDATE ON "match_participant"
  FOR EACH ROW EXECUTE FUNCTION "match_participant_is_immutable"();