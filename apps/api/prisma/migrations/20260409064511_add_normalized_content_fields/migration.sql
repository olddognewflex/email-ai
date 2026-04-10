-- AlterTable
ALTER TABLE "NormalizedEmail" ADD COLUMN     "cleanedText" TEXT,
ADD COLUMN     "detectedLinks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "unsubscribeLink" TEXT;
