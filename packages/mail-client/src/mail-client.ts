import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import {
  MailClientConfig,
  EmailMessage,
  FetchOptions,
  FetchResult,
  EmailAddress,
} from "./types.js";

/**
 * High-level IMAP client for fetching and parsing emails.
 * Wraps imapflow with simplified, testable abstractions.
 */
export class MailClient {
  private client: ImapFlow | null = null;
  private config: MailClientConfig;

  constructor(config: MailClientConfig) {
    this.config = config;
  }

  /**
   * Connect to the IMAP server.
   */
  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure ?? true,
      auth: {
        user: this.config.username,
        pass: this.config.password,
      },
      logger: false,
    });

    await this.client.connect();
  }

  /**
   * Disconnect from the IMAP server.
   */
  async disconnect(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.logout();
    } catch {
      this.client.close();
    } finally {
      this.client = null;
    }
  }

  /**
   * Fetch emails from the specified mailbox.
   * Returns parsed email messages with text body (HTML stripped if needed).
   */
  async fetchMessages(options: FetchOptions = {}): Promise<FetchResult> {
    if (!this.client) {
      throw new Error("Not connected. Call connect() first.");
    }

    const mailbox = options.mailbox ?? "INBOX";
    const limit = options.limit ?? 50;
    const sinceUid = options.sinceUid ?? 0;
    const newestFirst = options.newestFirst ?? true;

    const lock = await this.client.getMailboxLock(mailbox);

    try {
      const mailboxInfo = this.client.mailbox;
      const totalMessages = mailboxInfo ? mailboxInfo.exists : 0;

      if (totalMessages === 0) {
        return { messages: [], lastUid: 0, totalMessages: 0 };
      }

      // Determine UID range to fetch
      const uidRange = sinceUid === 0 ? "1:*" : `${sinceUid + 1}:*`;

      // Collect all message UIDs first
      const uids: number[] = [];
      for await (const msg of this.client.fetch(
        uidRange,
        { uid: true },
        { uid: true },
      )) {
        if (msg.uid) {
          uids.push(msg.uid);
        }
      }

      if (uids.length === 0) {
        return { messages: [], lastUid: sinceUid, totalMessages };
      }

      // Sort and limit
      uids.sort((a, b) => (newestFirst ? b - a : a - b));
      const targetUids = uids.slice(0, limit);

      // Fetch full content for target messages
      const messages: EmailMessage[] = [];
      let lastUid = sinceUid;

      for await (const msg of this.client.fetch(
        targetUids,
        {
          uid: true,
          source: true,
          flags: true,
          internalDate: true,
        },
        { uid: true },
      )) {
        if (!msg.source || !msg.uid) continue;

        const parsed = await this.parseEmail(Buffer.from(msg.source));
        const emailMessage: EmailMessage = {
          uid: msg.uid,
          messageId: parsed.messageId,
          subject: parsed.subject,
          from: parsed.from,
          date: parsed.date,
          body: parsed.body,
          isHtml: parsed.isHtml,
          flags: Array.from(msg.flags ?? []),
          internalDate:
            msg.internalDate instanceof Date ? msg.internalDate : new Date(),
        };

        messages.push(emailMessage);

        if (msg.uid > lastUid) {
          lastUid = msg.uid;
        }
      }

      // Re-sort to maintain newest-first order if needed
      if (newestFirst) {
        messages.sort(
          (a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0),
        );
      }

      return { messages, lastUid, totalMessages };
    } finally {
      lock.release();
    }
  }

  /**
   * Parse raw email bytes into structured EmailMessage fields.
   */
  private async parseEmail(source: Buffer): Promise<{
    messageId?: string;
    subject?: string;
    from: EmailAddress;
    date?: Date;
    body: string;
    isHtml: boolean;
  }> {
    const parsed: ParsedMail = await simpleParser(source);

    const from: EmailAddress = {
      name: parsed.from?.value[0]?.name,
      address: parsed.from?.value[0]?.address ?? "",
    };

    // Prefer text body, fallback to HTML with stripping
    let body = "";
    let isHtml = false;

    if (parsed.text) {
      body = parsed.text;
      isHtml = false;
    } else if (parsed.html) {
      body = this.stripHtml(parsed.html);
      isHtml = false; // Mark as not HTML since we stripped it
    }

    return {
      messageId: parsed.messageId ?? undefined,
      subject: parsed.subject ?? undefined,
      from,
      date: parsed.date ?? undefined,
      body,
      isHtml,
    };
  }

  /**
   * Strip HTML tags from text, preserving basic formatting.
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();
  }
}
