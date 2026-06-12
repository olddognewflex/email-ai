-- CreateEnum
CREATE TYPE "EmailAuthType" AS ENUM ('password', 'oauth');

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "authType" "EmailAuthType" NOT NULL DEFAULT 'password',
ADD COLUMN     "encryptedRefreshToken" TEXT,
ADD COLUMN     "needsReauth" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "encryptedPassword" DROP NOT NULL;
