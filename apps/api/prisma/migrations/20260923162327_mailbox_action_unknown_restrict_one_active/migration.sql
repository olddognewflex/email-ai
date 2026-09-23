-- AlterEnum
ALTER TYPE "MailboxActionStatus" ADD VALUE 'unknown';

-- DropForeignKey
ALTER TABLE "MailboxAction" DROP CONSTRAINT "MailboxAction_accountId_fkey";

-- AddForeignKey
ALTER TABLE "MailboxAction" ADD CONSTRAINT "MailboxAction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express partial indexes): at most one ACTIVE
-- move_to_trash per message. Active = any status except failed, skipped,
-- undone, i.e. pending, succeeded and unknown. The predicate is written as
-- NOT IN so it does not reference 'unknown', which PostgreSQL forbids using
-- in the same transaction that added it. A second concurrent insert fails
-- with a unique violation (Prisma P2002), handled as already_in_progress.
CREATE UNIQUE INDEX "MailboxAction_one_active_move_per_uid"
  ON "MailboxAction"("accountId", "sourceUidValidity", "sourceUid")
  WHERE "action" = 'move_to_trash'
    AND "status" NOT IN ('failed', 'skipped', 'undone');

CREATE UNIQUE INDEX "MailboxAction_one_active_move_per_raw_email"
  ON "MailboxAction"("rawEmailId")
  WHERE "action" = 'move_to_trash'
    AND "rawEmailId" IS NOT NULL
    AND "status" NOT IN ('failed', 'skipped', 'undone');
