-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL DEFAULT 'INBOX',
    "uid" INTEGER NOT NULL,
    "messageId" TEXT,
    "subject" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "date" TIMESTAMP(3),
    "body" TEXT NOT NULL,
    "flags" TEXT[],
    "internalDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessage_accountId_date_idx" ON "EmailMessage"("accountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_accountId_mailbox_uid_key" ON "EmailMessage"("accountId", "mailbox", "uid");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
