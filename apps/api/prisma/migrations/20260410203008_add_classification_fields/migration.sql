-- AlterTable
ALTER TABLE "NormalizedEmail" ADD COLUMN     "ruleCategory" TEXT,
ADD COLUMN     "ruleConfidence" TEXT,
ADD COLUMN     "ruleReasons" TEXT[];

-- CreateIndex
CREATE INDEX "NormalizedEmail_ruleCategory_idx" ON "NormalizedEmail"("ruleCategory");

-- CreateIndex
CREATE INDEX "NormalizedEmail_ruleConfidence_idx" ON "NormalizedEmail"("ruleConfidence");
