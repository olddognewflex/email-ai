-- CreateEnum
CREATE TYPE "SenderRuleMatchType" AS ENUM ('address', 'domain', 'domain_suffix', 'glob', 'regex');

-- CreateEnum
CREATE TYPE "SenderRuleAction" AS ENUM ('classify', 'trash');

-- AlterTable
ALTER TABLE "EmailClassification" ADD COLUMN     "senderRuleId" TEXT;

-- CreateTable
CREATE TABLE "SenderRule" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "matchType" "SenderRuleMatchType" NOT NULL,
    "action" "SenderRuleAction" NOT NULL DEFAULT 'classify',
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SenderRule_enabled_idx" ON "SenderRule"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SenderRule_matchType_pattern_key" ON "SenderRule"("matchType", "pattern");

-- CreateIndex
CREATE INDEX "EmailClassification_senderRuleId_idx" ON "EmailClassification"("senderRuleId");

-- CreateIndex
CREATE INDEX "EmailClassification_providerUsed_idx" ON "EmailClassification"("providerUsed");

-- AddForeignKey
ALTER TABLE "EmailClassification" ADD CONSTRAINT "EmailClassification_senderRuleId_fkey" FOREIGN KEY ("senderRuleId") REFERENCES "SenderRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
