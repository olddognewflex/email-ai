-- CreateTable
CREATE TABLE "EmailClassification" (
    "id" TEXT NOT NULL,
    "normalizedEmailId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "importance" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "rawResponse" TEXT,
    "classificationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailClassification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailClassification_normalizedEmailId_key" ON "EmailClassification"("normalizedEmailId");

-- CreateIndex
CREATE INDEX "EmailClassification_category_idx" ON "EmailClassification"("category");

-- CreateIndex
CREATE INDEX "EmailClassification_needsReview_idx" ON "EmailClassification"("needsReview");

-- CreateIndex
CREATE INDEX "EmailClassification_createdAt_idx" ON "EmailClassification"("createdAt");

-- AddForeignKey
ALTER TABLE "EmailClassification" ADD CONSTRAINT "EmailClassification_normalizedEmailId_fkey" FOREIGN KEY ("normalizedEmailId") REFERENCES "NormalizedEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
