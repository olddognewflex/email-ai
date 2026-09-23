-- CreateEnum
CREATE TYPE "MailboxActionType" AS ENUM ('move_to_trash', 'restore');

-- CreateEnum
CREATE TYPE "MailboxActionStatus" AS ENUM ('pending', 'succeeded', 'failed', 'skipped', 'undone');

-- CreateTable
CREATE TABLE "MailboxAction" (
    "id" TEXT NOT NULL,
    "action" "MailboxActionType" NOT NULL,
    "status" "MailboxActionStatus" NOT NULL,
    "accountId" TEXT NOT NULL,
    "rawEmailId" TEXT,
    "senderRuleId" TEXT,
    "undoOfId" TEXT,
    "sourceMailbox" TEXT NOT NULL,
    "sourceUid" INTEGER NOT NULL,
    "sourceUidValidity" TEXT,
    "destMailbox" TEXT,
    "destUid" INTEGER,
    "destUidValidity" TEXT,
    "messageId" TEXT,
    "fromAddress" TEXT,
    "subject" TEXT,
    "gmailLabels" TEXT[],
    "error" TEXT,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailboxAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailboxAction_undoOfId_key" ON "MailboxAction"("undoOfId");

-- CreateIndex
CREATE INDEX "MailboxAction_accountId_createdAt_idx" ON "MailboxAction"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "MailboxAction_rawEmailId_idx" ON "MailboxAction"("rawEmailId");

-- CreateIndex
CREATE INDEX "MailboxAction_senderRuleId_idx" ON "MailboxAction"("senderRuleId");

-- CreateIndex
CREATE INDEX "MailboxAction_status_idx" ON "MailboxAction"("status");

-- CreateIndex
CREATE INDEX "MailboxAction_accountId_messageId_idx" ON "MailboxAction"("accountId", "messageId");

-- AddForeignKey
ALTER TABLE "MailboxAction" ADD CONSTRAINT "MailboxAction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAction" ADD CONSTRAINT "MailboxAction_rawEmailId_fkey" FOREIGN KEY ("rawEmailId") REFERENCES "RawEmail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAction" ADD CONSTRAINT "MailboxAction_senderRuleId_fkey" FOREIGN KEY ("senderRuleId") REFERENCES "SenderRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAction" ADD CONSTRAINT "MailboxAction_undoOfId_fkey" FOREIGN KEY ("undoOfId") REFERENCES "MailboxAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
