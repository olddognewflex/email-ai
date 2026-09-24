-- CreateEnum
CREATE TYPE "ClassificationRevisionAction" AS ENUM ('update', 'claim', 'release');

-- CreateEnum
CREATE TYPE "ClassificationRevisionStatus" AS ENUM ('applied', 'reclassified', 'deferred', 'marked_review');

-- CreateTable
CREATE TABLE "ClassificationRevision" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "action" "ClassificationRevisionAction" NOT NULL,
    "status" "ClassificationRevisionStatus" NOT NULL,
    "normalizedEmailId" TEXT NOT NULL,
    "classificationId" TEXT,
    "senderRuleId" TEXT,
    "previous" JSONB NOT NULL,
    "next" JSONB,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassificationRevision_batchId_idx" ON "ClassificationRevision"("batchId");

-- CreateIndex
CREATE INDEX "ClassificationRevision_normalizedEmailId_idx" ON "ClassificationRevision"("normalizedEmailId");

-- CreateIndex
CREATE INDEX "ClassificationRevision_senderRuleId_idx" ON "ClassificationRevision"("senderRuleId");

-- CreateIndex
CREATE INDEX "ClassificationRevision_createdAt_idx" ON "ClassificationRevision"("createdAt");

-- AddForeignKey
ALTER TABLE "ClassificationRevision" ADD CONSTRAINT "ClassificationRevision_normalizedEmailId_fkey" FOREIGN KEY ("normalizedEmailId") REFERENCES "NormalizedEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationRevision" ADD CONSTRAINT "ClassificationRevision_senderRuleId_fkey" FOREIGN KEY ("senderRuleId") REFERENCES "SenderRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
