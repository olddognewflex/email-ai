-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'SYNCING', 'ERROR');

-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "lastSyncedUid" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'IDLE',

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawEmail" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "rawSource" BYTEA NOT NULL,
    "internalDate" TIMESTAMP(3) NOT NULL,
    "flags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParsedEmail" (
    "id" TEXT NOT NULL,
    "rawEmailId" TEXT NOT NULL,
    "subject" TEXT,
    "fromAddress" TEXT,
    "fromName" TEXT,
    "toAddresses" JSONB NOT NULL,
    "ccAddresses" JSONB NOT NULL,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "hasUnsubscribe" BOOLEAN NOT NULL DEFAULT false,
    "parsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParsedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedEmail" (
    "id" TEXT NOT NULL,
    "parsedEmailId" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "isNewsletter" BOOLEAN NOT NULL DEFAULT false,
    "isBulk" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NormalizedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_accountId_mailbox_key" ON "SyncState"("accountId", "mailbox");

-- CreateIndex
CREATE UNIQUE INDEX "RawEmail_accountId_mailbox_uid_key" ON "RawEmail"("accountId", "mailbox", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "ParsedEmail_rawEmailId_key" ON "ParsedEmail"("rawEmailId");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedEmail_parsedEmailId_key" ON "NormalizedEmail"("parsedEmailId");

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEmail" ADD CONSTRAINT "RawEmail_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParsedEmail" ADD CONSTRAINT "ParsedEmail_rawEmailId_fkey" FOREIGN KEY ("rawEmailId") REFERENCES "RawEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedEmail" ADD CONSTRAINT "NormalizedEmail_parsedEmailId_fkey" FOREIGN KEY ("parsedEmailId") REFERENCES "ParsedEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
