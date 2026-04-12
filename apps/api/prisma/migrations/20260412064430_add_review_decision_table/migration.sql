-- CreateEnum
CREATE TYPE "ReviewDecisionType" AS ENUM ('approved', 'rejected');

-- CreateTable
CREATE TABLE "ReviewDecision" (
    "id" TEXT NOT NULL,
    "classificationId" TEXT NOT NULL,
    "decision" "ReviewDecisionType" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewDecision_classificationId_key" ON "ReviewDecision"("classificationId");

-- CreateIndex
CREATE INDEX "ReviewDecision_decision_idx" ON "ReviewDecision"("decision");

-- CreateIndex
CREATE INDEX "ReviewDecision_decidedAt_idx" ON "ReviewDecision"("decidedAt");

-- CreateIndex
CREATE INDEX "EmailClassification_confidence_idx" ON "EmailClassification"("confidence");

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_classificationId_fkey" FOREIGN KEY ("classificationId") REFERENCES "EmailClassification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
