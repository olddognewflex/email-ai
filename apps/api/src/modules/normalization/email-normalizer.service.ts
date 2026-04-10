import { Injectable } from "@nestjs/common";

export interface NormalizationResult {
  cleanedText: string;
  detectedLinks: DetectedLink[];
  unsubscribeLink: string | null;
}

export interface DetectedLink {
  url: string;
  text: string;
  type: "unsubscribe" | "general";
}

/**
 * Service for normalizing email content.
 * Applies simple heuristics to extract clean text from emails.
 *
 * Normalization pipeline:
 * 1. Extract text (from HTML if needed)
 * 2. Remove quoted replies
 * 3. Trim signatures
 * 4. Normalize whitespace
 * 5. Extract links (including unsubscribe)
 *
 * The normalization is idempotent - running it multiple times
 * on the same input produces the same output.
 */
@Injectable()
export class EmailNormalizer {
  /**
   * Normalizes email content by:
   * - Converting HTML to text (if needed)
   * - Removing quoted replies
   * - Trimming signatures
   * - Normalizing whitespace
   * - Extracting links
   */
  normalize(
    textBody: string | null,
    htmlBody: string | null,
  ): NormalizationResult {
    // Step 1: Extract raw text (prefer textBody, fallback to HTML stripping)
    let rawText = textBody ?? "";
    if ((!rawText || !rawText.trim()) && htmlBody) {
      rawText = this.stripHtml(htmlBody);
    }

    // Step 2: Detect and extract links before removing markup
    const { detectedLinks, unsubscribeLink } = this.extractLinks(
      rawText,
      htmlBody,
    );

    // Step 3: Remove quoted replies
    let cleaned = this.removeQuotedReplies(rawText);

    // Step 4: Trim signatures
    cleaned = this.trimSignature(cleaned);

    // Step 5: Normalize whitespace
    cleaned = this.normalizeWhitespace(cleaned);

    return {
      cleanedText: cleaned,
      detectedLinks,
      unsubscribeLink,
    };
  }

  /**
   * Strips HTML tags and decodes common entities.
   * Simple heuristic - no full HTML parser needed.
   */
  stripHtml(html: string): string {
    // Remove script and style blocks entirely
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");

    // Replace common block elements with newlines
    text = text.replace(/<\/p>/gi, "\n\n");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/div>/gi, "\n");
    text = text.replace(/<\/li>/gi, "\n");
    text = text.replace(/<li[^>]*>/gi, "- ");

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, " ");

    // Decode common HTML entities
    text = this.decodeHtmlEntities(text);

    return text;
  }

  /**
   * Decodes common HTML entities.
   */
  decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&nbsp;": " ",
      "&#x27;": "'",
      "&#x2F;": "/",
      "&#32;": " ",
      "&#10;": "\n",
      "&#13;": "\r",
    };

    return text.replace(/&[a-zA-Z0-9#]+;/g, (match) => {
      return entities[match] ?? match;
    });
  }

  /**
   * Removes quoted reply sections using common email quote patterns.
   * Uses simple heuristics for broad compatibility.
   */
  removeQuotedReplies(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];

    for (const line of lines) {
      if (this.isQuotedLine(line)) {
        break;
      }
      result.push(line);
    }

    return result.join("\n").replace(/\n+$/, "");
  }

  /**
   * Checks if a line indicates the start of a quoted reply.
   */
  isQuotedLine(line: string): boolean {
    const trimmed = line.trim();

    // Classic email quote prefix
    if (/^>/.test(trimmed)) return true;

    // Common reply headers
    const replyPatterns = [
      /^On .* wrote:/i,
      /^From:\s*/i,
      /^Sent:\s*/i,
      /^To:\s*/i,
      /^Cc:\s*/i,
      /^Subject:\s*/i,
      /^-{3,}\s*Original Message\s*-{3,}/i,
      /^-{3,}\s*Forwarded Message\s*-{3,}/i,
      /^_{5,}/, // Underscore separator
      /^-{5,}/, // Dash separator
      /\d{1,2}\/\d{1,2}\/\d{2,4}.*\d{1,2}:\d{2}/, // Date/time pattern often in headers
      /^\s*-{2,}\s*Forwarded by/i,
      /^Begin forwarded message:/i,
    ];

    return replyPatterns.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Trims email signatures using common signature delimiters.
   */
  trimSignature(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];

    for (const line of lines) {
      if (this.isSignatureDelimiter(line)) {
        break;
      }
      result.push(line);
    }

    return result.join("\n").replace(/\n+$/, "");
  }

  /**
   * Checks if a line is a signature delimiter.
   */
  isSignatureDelimiter(line: string): boolean {
    const trimmed = line.trim();

    if (/^--\s*$/.test(trimmed)) return true;

    const signaturePatterns = [
      /^Sent from my iPhone/i,
      /^Sent from my Android/i,
      /^Sent from my mobile/i,
      /^Sent from Samsung/i,
      /^Sent via/i,
      /^-{2,}\s*$/,
      /^_{2,}\s*$/,
      /^={2,}\s*$/,
      /^Best regards,/i,
      /^Regards,/i,
      /^Sincerely,/i,
      /^Cheers,/i,
      /^Thanks,/i,
      /^Thank you,/i,
      /^Best,/i,
      /^Yours truly,/i,
    ];

    return signaturePatterns.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Normalizes whitespace:
   * - Collapses multiple spaces
   * - Collapses multiple newlines (max 2)
   * - Trims start/end
   */
  normalizeWhitespace(text: string): string {
    if (!text) return "";
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();
  }

  /**
   * Extracts links from email content.
   * Searches both text body and HTML body for URLs.
   */
  extractLinks(
    textBody: string,
    htmlBody: string | null,
  ): { detectedLinks: DetectedLink[]; unsubscribeLink: string | null } {
    const links: DetectedLink[] = [];
    const seenUrls = new Set<string>();
    let unsubscribeLink: string | null = null;

    // Extract from HTML anchor tags
    if (htmlBody) {
      const htmlLinks = this.extractLinksFromHtml(htmlBody);
      for (const link of htmlLinks) {
        if (!seenUrls.has(link.url)) {
          seenUrls.add(link.url);
          links.push(link);

          // Check if this is an unsubscribe link
          if (this.isUnsubscribeLink(link.url, link.text)) {
            unsubscribeLink = link.url;
          }
        }
      }
    }

    // Extract plain URLs from text
    const textUrls = this.extractUrlsFromText(textBody);
    for (const url of textUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        const link: DetectedLink = {
          url,
          text: url,
          type: this.isUnsubscribeUrl(url) ? "unsubscribe" : "general",
        };
        links.push(link);

        if (link.type === "unsubscribe") {
          unsubscribeLink = url;
        }
      }
    }

    return { detectedLinks: links, unsubscribeLink };
  }

  /**
   * Extracts links from HTML anchor tags.
   */
  extractLinksFromHtml(html: string): DetectedLink[] {
    const links: DetectedLink[] = [];

    // Simple regex to extract href and text content
    // Note: This is intentionally simple - full HTML parsing is overkill
    const anchorRegex =
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = match[1];
      const text = this.stripHtml(match[2]).trim();

      if (this.isValidUrl(url)) {
        links.push({
          url,
          text: text || url,
          type:
            this.isUnsubscribeUrl(url) || this.isUnsubscribeText(text)
              ? "unsubscribe"
              : "general",
        });
      }
    }

    return links;
  }

  /**
   * Extracts bare URLs from plain text.
   */
  extractUrlsFromText(text: string): string[] {
    const urls: string[] = [];

    // Match URLs (http, https, ftp)
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      // Clean trailing punctuation
      const cleanUrl = url.replace(/[.,;:!?]+$/, "");
      if (this.isValidUrl(cleanUrl)) {
        urls.push(cleanUrl);
      }
    }

    return urls;
  }

  /**
   * Validates a URL string.
   */
  isValidUrl(url: string): boolean {
    if (!url) return false;
    if (url.length < 10) return false;
    if (!url.startsWith("http")) return false;
    if (url.includes(" ")) return false;
    return true;
  }

  /**
   * Checks if a URL is likely an unsubscribe link.
   */
  isUnsubscribeUrl(url: string): boolean {
    const unsubscribePatterns = [
      /unsubscribe/i,
      /optout/i,
      /opt-out/i,
      /remove/i,
      /\/unsub/i,
      /preferences\/email/i,
      /subscriptions\/manage/i,
      /email\/preferences/i,
    ];

    return unsubscribePatterns.some((pattern) => pattern.test(url));
  }

  /**
   * Checks if link text indicates an unsubscribe action.
   */
  isUnsubscribeText(text: string): boolean {
    const unsubscribePatterns = [
      /^\s*unsubscribe\s*$/i,
      /^\s*unsubscribe now\s*$/i,
      /^\s*opt out\s*$/i,
      /^\s*opt-out\s*$/i,
      /^\s*manage preferences\s*$/i,
      /^\s*email preferences\s*$/i,
      /^\s*stop receiving these emails\s*$/i,
      /^\s*remove me\s*$/i,
    ];

    return unsubscribePatterns.some((pattern) => pattern.test(text));
  }

  /**
   * Checks if a URL or text combination indicates an unsubscribe link.
   */
  isUnsubscribeLink(url: string, text: string): boolean {
    return this.isUnsubscribeUrl(url) || this.isUnsubscribeText(text);
  }
}
