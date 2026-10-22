-- CreateEnum
CREATE TYPE "ReviewDecisionSource" AS ENUM ('human', 'auto');

-- AlterTable
ALTER TABLE "ReviewDecision" ADD COLUMN     "source" "ReviewDecisionSource" NOT NULL DEFAULT 'human';

-- CreateIndex
CREATE INDEX "ReviewDecision_source_idx" ON "ReviewDecision"("source");
