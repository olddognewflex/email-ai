import { EmailNormalizer } from "./email-normalizer.service";

describe("EmailNormalizer", () => {
  let normalizer: EmailNormalizer;

  beforeEach(() => {
    normalizer = new EmailNormalizer();
  });

  describe("normalize", () => {
    it("should prefer textBody over htmlBody", () => {
      const text = "Plain text content";
      const html = "<p>HTML content</p>";
      const result = normalizer.normalize(text, html);
      expect(result.cleanedText).toBe("Plain text content");
    });

    it("should fallback to htmlBody when textBody is empty", () => {
      const result = normalizer.normalize("", "<p>HTML content</p>");
      expect(result.cleanedText).toBe("HTML content");
    });

    it("should return empty string when both bodies are null", () => {
      const result = normalizer.normalize(null, null);
      expect(result.cleanedText).toBe("");
    });

    it("should extract unsubscribe links", () => {
      const text = "Click here to unsubscribe: https://example.com/unsubscribe";
      const result = normalizer.normalize(text, null);
      expect(result.unsubscribeLink).toBe("https://example.com/unsubscribe");
    });

    it("should detect general links", () => {
      const text =
        "Visit https://example.com and https://test.org for more info";
      const result = normalizer.normalize(text, null);
      expect(result.detectedLinks).toHaveLength(2);
      expect(result.detectedLinks[0].url).toBe("https://example.com");
      expect(result.detectedLinks[1].url).toBe("https://test.org");
    });
  });

  describe("stripHtml", () => {
    it("should remove HTML tags", () => {
      const html = "<p>Hello <strong>world</strong></p>";
      const result = normalizer.stripHtml(html);
      expect(result).toContain("Hello");
      expect(result).toContain("world");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });

    it("should replace paragraph tags with newlines", () => {
      const html = "<p>First paragraph</p><p>Second paragraph</p>";
      const result = normalizer.stripHtml(html);
      expect(result).toContain("First paragraph");
      expect(result).toContain("Second paragraph");
    });

    it("should replace br tags with newlines", () => {
      const html = "Line 1<br>Line 2<br/>Line 3";
      const result = normalizer.stripHtml(html);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });

    it("should remove script blocks entirely", () => {
      const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
      const result = normalizer.stripHtml(html);
      expect(result).toContain("Hello");
      expect(result).toContain("World");
      expect(result).not.toContain("script");
      expect(result).not.toContain("alert");
    });

    it("should remove style blocks entirely", () => {
      const html =
        "<p>Hello</p><style>.red { color: red; }</style><p>World</p>";
      const result = normalizer.stripHtml(html);
      expect(result).toContain("Hello");
      expect(result).toContain("World");
      expect(result).not.toContain("style");
      expect(result).not.toContain(".red");
    });

    it("should decode HTML entities", () => {
      const html = "&lt;div&gt;Hello &amp; welcome&lt;/div&gt;";
      const result = normalizer.stripHtml(html);
      expect(result).toContain("<div>");
      expect(result).toContain("&");
      expect(result).toContain("welcome</div>");
    });

    it("should handle li tags with dashes", () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
      const result = normalizer.stripHtml(html);
      expect(result).toContain("- Item 1");
      expect(result).toContain("- Item 2");
    });
  });

  describe("decodeHtmlEntities", () => {
    it("should decode common entities", () => {
      expect(normalizer.decodeHtmlEntities("&amp;")).toBe("&");
      expect(normalizer.decodeHtmlEntities("&lt;")).toBe("<");
      expect(normalizer.decodeHtmlEntities("&gt;")).toBe(">");
      expect(normalizer.decodeHtmlEntities("&quot;")).toBe('"');
      expect(normalizer.decodeHtmlEntities("&#39;")).toBe("'");
      expect(normalizer.decodeHtmlEntities("&nbsp;")).toBe(" ");
    });

    it("should leave unknown entities unchanged", () => {
      expect(normalizer.decodeHtmlEntities("&unknown;")).toBe("&unknown;");
    });
  });

  describe("removeQuotedReplies", () => {
    it("should remove lines starting with >", () => {
      const text = "My reply\n> Original message\n> More context";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My reply");
    });

    it('should stop at "On ... wrote:" pattern', () => {
      const text =
        "My message\n\nOn Jan 1, 2024, John wrote:\nOriginal message";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My message");
    });

    it('should stop at "From:" header', () => {
      const text =
        "My reply\n\nFrom: sender@example.com\nTo: recipient@example.com";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My reply");
    });

    it("should stop at separator lines", () => {
      const text = "My reply\n\n-----Original Message-----\nOriginal content";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My reply");
    });

    it("should stop at underscore separators", () => {
      const text = "My reply\n\n_____\nOriginal content";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My reply");
    });

    it('should handle "Begin forwarded message:"', () => {
      const text = "My message\n\nBegin forwarded message:\nForwarded content";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My message");
    });

    it("should handle Sent: header", () => {
      const text = "My reply\n\nSent: Monday, January 1, 2024";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe("My reply");
    });

    it("should return full text if no quote patterns found", () => {
      const text = "Line 1\nLine 2\nLine 3";
      const result = normalizer.removeQuotedReplies(text);
      expect(result).toBe(text);
    });
  });

  describe("trimSignature", () => {
    it("should trim at classic signature delimiter", () => {
      const text = "Message body\n\n-- \nJohn Doe\njohn@example.com";
      const result = normalizer.trimSignature(text);
      expect(result).toBe("Message body");
    });

    it('should trim at "Sent from my iPhone"', () => {
      const text = "My message\n\nSent from my iPhone";
      const result = normalizer.trimSignature(text);
      expect(result).toBe("My message");
    });

    it('should trim at "Sent from my Android"', () => {
      const text = "My message\n\nSent from my Android device";
      const result = normalizer.trimSignature(text);
      expect(result).toBe("My message");
    });

    it('should trim at "Best regards,"', () => {
      const text = "Thanks for your help.\n\nBest regards,\nJohn";
      const result = normalizer.trimSignature(text);
      expect(result).toBe("Thanks for your help.");
    });

    it('should trim at "Sincerely,"', () => {
      const text = "Message\n\nSincerely,\nJane";
      const result = normalizer.trimSignature(text);
      expect(result).toBe("Message");
    });

    it("should return full text if no signature found", () => {
      const text = "Line 1\nLine 2\nLine 3";
      const result = normalizer.trimSignature(text);
      expect(result).toBe(text);
    });
  });

  describe("normalizeWhitespace", () => {
    it("should collapse multiple spaces", () => {
      const text = "Hello    world";
      const result = normalizer.normalizeWhitespace(text);
      expect(result).toBe("Hello world");
    });

    it("should collapse tabs to single space", () => {
      const text = "Hello\t\t\tworld";
      const result = normalizer.normalizeWhitespace(text);
      expect(result).toBe("Hello world");
    });

    it("should collapse 3+ newlines to 2", () => {
      const text = "Line 1\n\n\n\nLine 2";
      const result = normalizer.normalizeWhitespace(text);
      expect(result).toBe("Line 1\n\nLine 2");
    });

    it("should trim each line", () => {
      const text = "  Hello world  \n  Another line  ";
      const result = normalizer.normalizeWhitespace(text);
      expect(result).toBe("Hello world\nAnother line");
    });

    it("should trim overall", () => {
      const text = "  \n\nHello world\n\n  ";
      const result = normalizer.normalizeWhitespace(text);
      expect(result).toBe("Hello world");
    });

    it("should preserve single newlines", () => {
      const text = "Line 1\nLine 2";
      const result = normalizer.normalizeWhitespace(text);
      expect(result).toBe("Line 1\nLine 2");
    });
  });

  describe("extractLinks", () => {
    it("should extract URLs from plain text", () => {
      const text = "Visit https://example.com for more info";
      const result = normalizer.extractLinks(text, null);
      expect(result.detectedLinks).toHaveLength(1);
      expect(result.detectedLinks[0].url).toBe("https://example.com");
      expect(result.detectedLinks[0].type).toBe("general");
    });

    it("should extract multiple URLs", () => {
      const text = "See https://a.com and https://b.org";
      const result = normalizer.extractLinks(text, null);
      expect(result.detectedLinks).toHaveLength(2);
    });

    it("should extract links from HTML anchor tags", () => {
      const html = '<a href="https://example.com">Click here</a>';
      const result = normalizer.extractLinks("", html);
      expect(result.detectedLinks).toHaveLength(1);
      expect(result.detectedLinks[0].url).toBe("https://example.com");
      expect(result.detectedLinks[0].text).toBe("Click here");
    });

    it("should identify unsubscribe links from URL", () => {
      const text = "Unsubscribe: https://example.com/unsubscribe";
      const result = normalizer.extractLinks(text, null);
      expect(result.unsubscribeLink).toBe("https://example.com/unsubscribe");
      expect(result.detectedLinks[0].type).toBe("unsubscribe");
    });

    it("should identify unsubscribe links from anchor text", () => {
      const html = '<a href="https://example.com/prefs">Unsubscribe</a>';
      const result = normalizer.extractLinks("", html);
      expect(result.unsubscribeLink).toBe("https://example.com/prefs");
    });

    it("should identify opt-out links", () => {
      const text = "Click to opt out: https://example.com/optout";
      const result = normalizer.extractLinks(text, null);
      expect(result.unsubscribeLink).toBe("https://example.com/optout");
    });

    it("should deduplicate URLs", () => {
      const text = "Visit https://example.com and https://example.com again";
      const result = normalizer.extractLinks(text, null);
      expect(result.detectedLinks).toHaveLength(1);
    });

    it("should handle trailing punctuation", () => {
      const text = "Visit https://example.com.";
      const result = normalizer.extractLinks(text, null);
      expect(result.detectedLinks[0].url).toBe("https://example.com");
    });

    it("should return null unsubscribeLink if not found", () => {
      const text = "Visit https://example.com";
      const result = normalizer.extractLinks(text, null);
      expect(result.unsubscribeLink).toBeNull();
    });
  });

  describe("isValidUrl", () => {
    it("should accept http URLs", () => {
      expect(normalizer.isValidUrl("http://example.com")).toBe(true);
    });

    it("should accept https URLs", () => {
      expect(normalizer.isValidUrl("https://example.com")).toBe(true);
    });

    it("should reject URLs with spaces", () => {
      expect(normalizer.isValidUrl("https://example .com")).toBe(false);
    });

    it("should reject empty strings", () => {
      expect(normalizer.isValidUrl("")).toBe(false);
    });

    it("should reject short strings", () => {
      expect(normalizer.isValidUrl("http")).toBe(false);
    });
  });

  describe("idempotency", () => {
    it("should produce same result when run twice", () => {
      const text = "Hello world\n\n-- \nSignature";
      const first = normalizer.normalize(text, null);
      const second = normalizer.normalize(first.cleanedText, null);
      expect(second.cleanedText).toBe(first.cleanedText);
    });

    it("should not add more links on re-normalization", () => {
      const text = "Visit https://example.com";
      const first = normalizer.normalize(text, null);
      const second = normalizer.normalize(first.cleanedText, null);
      expect(second.detectedLinks).toHaveLength(first.detectedLinks.length);
    });
  });

  describe("real-world email examples", () => {
    it("should handle a typical reply email", () => {
      const text = `Hi there,

Thanks for reaching out. I'll get back to you soon.

Best,
John

On Thu, Jan 1, 2024 at 10:00 AM Jane <jane@example.com> wrote:
> Hey John,
> Can we meet tomorrow?
> Jane`;

      const result = normalizer.normalize(text, null);
      expect(result.cleanedText).toContain("Thanks for reaching out");
      expect(result.cleanedText).not.toContain("On Thu");
      expect(result.cleanedText).not.toContain("> Hey John");
      expect(result.cleanedText).not.toContain("Best,");
    });

    it("should handle HTML email with unsubscribe", () => {
      const html = `
        <html>
          <body>
            <p>Welcome to our newsletter!</p>
            <p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
          </body>
        </html>
      `;

      const result = normalizer.normalize(null, html);
      expect(result.cleanedText).toContain("Welcome to our newsletter");
      expect(result.unsubscribeLink).toBe("https://example.com/unsubscribe");
    });

    it("should handle email with multiple links", () => {
      const html = `
        <p>Check out <a href="https://example.com">our website</a> and
        <a href="https://example.com/blog">our blog</a>.</p>
        <p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
      `;

      const result = normalizer.normalize(null, html);
      expect(result.detectedLinks).toHaveLength(3);
      expect(result.unsubscribeLink).toBe("https://example.com/unsubscribe");
    });
  });
});
