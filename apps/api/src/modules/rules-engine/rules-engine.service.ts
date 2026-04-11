import { Injectable } from "@nestjs/common";
import {
  ClassificationRule,
  RuleCategory,
  RuleConfidence,
  RulesEngineInput,
  RulesEngineResult,
} from "@email-ai/shared";

/**
 * Service for rule-based email classification.
 * Uses deterministic heuristics to pre-classify emails before LLM processing.
 *
 * Rules are designed to be:
 * - Deterministic: same input always produces same output
 * - Explainable: every classification includes reasons
 * - Extensible: new rules can be added easily
 * - Conservative: when uncertain, defaults to 'unknown'
 */
@Injectable()
export class RulesEngineService {
  private readonly rules: ClassificationRule[];

  constructor() {
    this.rules = this.buildRules();
  }

  /**
   * Classifies an email using deterministic rules.
   * Returns the best matching category with confidence and reasons.
   */
  classify(input: RulesEngineInput): RulesEngineResult {
    const matchedRules = this.rules.filter((rule) => rule.matcher(input));

    if (matchedRules.length === 0) {
      return {
        ruleCategory: "unknown",
        ruleConfidence: "low",
        ruleReasons: ["No classification rules matched"],
        matchedRules: [],
      };
    }

    const categoryScores = this.calculateCategoryScores(matchedRules);
    const bestCategory = this.selectBestCategory(categoryScores);

    const categoryRules = matchedRules.filter(
      (r) => r.category === bestCategory,
    );
    const confidence = this.aggregateConfidence(categoryRules);
    const reasons = this.buildReasons(categoryRules);

    return {
      ruleCategory: bestCategory,
      ruleConfidence: confidence,
      ruleReasons: reasons,
      matchedRules: categoryRules.map((r) => r.name),
    };
  }

  /**
   * Builds all classification rules.
   * Rules are ordered from most specific to least specific within each category.
   */
  private buildRules(): ClassificationRule[] {
    return [
      ...this.buildNewsletterRules(),
      ...this.buildReceiptRules(),
      ...this.buildAlertRules(),
      ...this.buildLikelyHumanRules(),
    ];
  }

  /**
   * Newsletter classification rules.
   * Detects bulk marketing emails, mailing lists, and subscriptions.
   */
  private buildNewsletterRules(): ClassificationRule[] {
    return [
      {
        name: "has_unsubscribe_link",
        category: "newsletter",
        confidence: "high",
        description: "Email contains unsubscribe link",
        matcher: (input) => input.hasUnsubscribe || !!input.unsubscribeLink,
      },
      {
        name: "list_id_header_indicator",
        category: "newsletter",
        confidence: "high",
        description: "Has mailing list indicators in tags",
        matcher: (input) =>
          input.tags.some((tag) =>
            /^(list-id|mailing-list|list-post)/i.test(tag),
          ),
      },
      {
        name: "bulk_sender_domain",
        category: "newsletter",
        confidence: "medium",
        description: "Sender domain is known bulk mail service",
        matcher: (input) => {
          const bulkDomains = [
            "mailchimp.com",
            "sendgrid.net",
            "mailgun.org",
            "postmarkapp.com",
            "amazonSES.com",
            "amazonses.com",
            "sendinblue.com",
            "brevo.com",
            "constantcontact.com",
            "campaign-archive.com",
            "substack.com",
            "convertkit.com",
            "aweber.com",
            "getresponse.com",
            "activehosted.com",
            "klaviyo.com",
          ];
          return bulkDomains.some((domain) =>
            input.senderDomain.toLowerCase().includes(domain),
          );
        },
      },
      {
        name: "newsletter_keywords_in_subject",
        category: "newsletter",
        confidence: "medium",
        description: "Subject contains newsletter keywords",
        matcher: (input) => {
          if (!input.subject) return false;
          const subject = input.subject;
          const newsletterPatterns = [
            /\b(newsletter|weekly|monthly|digest|update)\b/i,
            /\b(substack edition|issue\s*#?\d+)\b/i,
            /\bread.*this.*(first|issue)\b/i,
          ];
          return newsletterPatterns.some((pattern) => pattern.test(subject));
        },
      },
      {
        name: "is_newsletter_flag_set",
        category: "newsletter",
        confidence: "high",
        description: "Normalization marked as newsletter",
        matcher: (input) => input.isNewsletter,
      },
      {
        name: "is_bulk_flag_set",
        category: "newsletter",
        confidence: "medium",
        description: "Normalization marked as bulk",
        matcher: (input) => input.isBulk,
      },
    ];
  }

  /**
   * Receipt/transaction classification rules.
   * Detects purchase confirmations, invoices, and payment receipts.
   */
  private buildReceiptRules(): ClassificationRule[] {
    return [
      {
        name: "receipt_keywords_in_subject",
        category: "receipt",
        confidence: "high",
        description: "Subject contains receipt/invoice keywords",
        matcher: (input) => {
          if (!input.subject) return false;
          const subject = input.subject;
          const receiptPatterns = [
            /\b(receipt|invoice|order\s*confirmation|payment\s*confirmed)\b/i,
            /\b(your\s*order|purchase\s*confirmation|payment\s*receipt)\b/i,
            /\b(order\s*#|invoice\s*#|receipt\s*#)\b/i,
            /\b(thank\s*you\s*for\s*(your\s*purchase|ordering))\b/i,
          ];
          return receiptPatterns.some((pattern) => pattern.test(subject));
        },
      },
      {
        name: "receipt_keywords_in_body",
        category: "receipt",
        confidence: "high",
        description: "Body contains strong receipt indicators",
        matcher: (input) => {
          const text = (input.textBody || "") + " " + (input.htmlBody || "");
          const strongIndicators = [
            /\border\s*total\s*[:\$]/i,
            /\btotal\s*amount\s*[:\$]/i,
            /\bpayment\s*method\s*:/i,
            /\bbilling\s*address\s*:/i,
            /\bshipping\s*address\s*:/i,
            /\btransaction\s*id\s*:/i,
            /\border\s*number\s*[:#]/i,
          ];
          return strongIndicators.some((pattern) => pattern.test(text));
        },
      },
      {
        name: "receipt_sender_domain",
        category: "receipt",
        confidence: "medium",
        description: "Sender domain suggests e-commerce",
        matcher: (input) => {
          const receiptDomains = [
            "paypal.com",
            "stripe.com",
            "shopify.com",
            "squareup.com",
            " Square.com ",
            "receipt",
            "billing",
            "invoice",
            "payments",
            "checkout",
          ];
          return receiptDomains.some((domain) =>
            input.senderDomain.toLowerCase().includes(domain),
          );
        },
      },
      {
        name: "subscription_receipt_keywords",
        category: "receipt",
        confidence: "medium",
        description: "Subject suggests subscription receipt",
        matcher: (input) => {
          if (!input.subject) return false;
          return /\b(subscription\s*(confirmed|renewed|payment)|recurring\s*payment)\b/i.test(
            input.subject,
          );
        },
      },
    ];
  }

  /**
   * Alert/notification classification rules.
   * Detects system alerts, security notifications, and automated warnings.
   */
  private buildAlertRules(): ClassificationRule[] {
    return [
      {
        name: "security_alert_keywords",
        category: "alert",
        confidence: "high",
        description: "Subject contains security alert keywords",
        matcher: (input) => {
          if (!input.subject) return false;
          const subject = input.subject;
          const securityPatterns = [
            /\b(security\s*alert|suspicious\s*(activity|login)|unusual\s*activity)\b/i,
            /\b(account\s*(compromised|hacked|breached|locked))\b/i,
            /\b(password\s*(changed|reset|compromised))\b/i,
            /\b(two.factor|2fa|verification\s*code|login\s*attempt)\b/i,
            /\b(new\s*device|new\s*location).*\b(login|signin)\b/i,
          ];
          return securityPatterns.some((pattern) => pattern.test(subject));
        },
      },
      {
        name: "system_alert_keywords",
        category: "alert",
        confidence: "high",
        description: "Subject contains system alert keywords",
        matcher: (input) => {
          if (!input.subject) return false;
          const subject = input.subject;
          const systemPatterns = [
            /\b(system\s*(down|outage|error|failure)|service\s*(disruption|unavailable))\b/i,
            /\b(downtime\s*alert|maintenance\s*(notice|scheduled|window))\b/i,
            /\b(backlog\s*alert|queue\s*overflow|capacity\s*warning)\b/i,
          ];
          return systemPatterns.some((pattern) => pattern.test(subject));
        },
      },
      {
        name: "notification_automated_patterns",
        category: "alert",
        confidence: "medium",
        description: "Subject matches automated notification pattern",
        matcher: (input) => {
          if (!input.subject) return false;
          const subject = input.subject;
          const notificationPatterns = [
            /^\[.*\]\s*(alert|warning|notice|info)/i,
            /\b(auto.matic|automated)\s*(notification|alert|message)\b/i,
            /\b(do not reply|no.?reply|noreply)\b/i,
          ];
          return notificationPatterns.some((pattern) => pattern.test(subject));
        },
      },
      {
        name: "alert_sender_patterns",
        category: "alert",
        confidence: "medium",
        description: "Sender name suggests automated alerts",
        matcher: (input) => {
          if (!input.fromName) return false;
          const fromName = input.fromName;
          const alertSenders = [
            /\b(alert|notification|status|monitoring|security)\b/i,
            /\b(systems?|server|infrastructure|devops)\b/i,
          ];
          return alertSenders.some((pattern) => pattern.test(fromName));
        },
      },
      {
        name: "no_reply_sender",
        category: "alert",
        confidence: "low",
        description: "Sender address is noreply or similar",
        matcher: (input) => {
          if (!input.fromAddress) return false;
          return /\b(no.?reply|noreply|do-not-reply|donotreply)\b/i.test(
            input.fromAddress,
          );
        },
      },
    ];
  }

  /**
   * Likely human classification rules.
   * Detects personal correspondence and conversational emails.
   */
  private buildLikelyHumanRules(): ClassificationRule[] {
    return [
      {
        name: "personal_greeting_patterns",
        category: "likely_human",
        confidence: "medium",
        description: "Body contains personal greeting patterns",
        matcher: (input) => {
          const text = (input.textBody || "").slice(0, 500);
          const greetingPatterns = [
            /^(hi|hello|hey)\s+[\w]+[,!\s]/i,
            /^(dear\s+[\w]+|hi\s+there)/i,
            /^(good\s+(morning|afternoon|evening))\s*[\w]*[,!]/i,
          ];
          return greetingPatterns.some((pattern) => pattern.test(text));
        },
      },
      {
        name: "conversational_punctuation",
        category: "likely_human",
        confidence: "low",
        description: "Contains conversational punctuation patterns",
        matcher: (input) => {
          const text = input.textBody || "";
          const conversationalPatterns = [
            /\?\s*(Thanks|Thank you|Let me know|Thoughts\?)/i,
            /\.{3,}/,
            /!{1,2}\s+(Hope|Wish|Let|Want)/i,
          ];
          return conversationalPatterns.some((pattern) => pattern.test(text));
        },
      },
      {
        name: "short_personal_subject",
        category: "likely_human",
        confidence: "low",
        description: "Subject is short and conversational",
        matcher: (input) => {
          if (!input.subject) return false;
          const subject = input.subject.trim();
          if (subject.length > 60) return false;

          const personalPatterns = [
            /^(quick\s+(question|note|update)|checking in|follow.?up)/i,
            /^(re:|fwd?:)\s*\w+/i,
          ];
          return personalPatterns.some((pattern) => pattern.test(subject));
        },
      },
      {
        name: "question_mark_in_subject",
        category: "likely_human",
        confidence: "low",
        description: "Subject is a question",
        matcher: (input) => {
          if (!input.subject) return false;
          return input.subject.trim().endsWith("?");
        },
      },
      {
        name: "personal_signature_detected",
        category: "likely_human",
        confidence: "medium",
        description: "Body contains personal signature patterns",
        matcher: (input) => {
          const text = input.textBody || "";
          const signaturePatterns = [
            /(?:^|\n)--\s*\n[\s\S]{0,200}$/m,
            /(?:best|regards|cheers|thanks),?\s*\n[\w\s]{2,50}$/im,
          ];
          return signaturePatterns.some((pattern) => pattern.test(text));
        },
      },
    ];
  }

  /**
   * Calculates score for each category based on matched rules.
   * Higher confidence rules contribute more to the score.
   */
  private calculateCategoryScores(
    matchedRules: ClassificationRule[],
  ): Map<RuleCategory, number> {
    const scores = new Map<RuleCategory, number>();

    for (const rule of matchedRules) {
      const weight = this.confidenceToWeight(rule.confidence);
      const current = scores.get(rule.category) || 0;
      scores.set(rule.category, current + weight);
    }

    return scores;
  }

  /**
   * Selects the category with the highest score.
   * Defaults to 'unknown' if no clear winner.
   */
  private selectBestCategory(scores: Map<RuleCategory, number>): RuleCategory {
    let bestCategory: RuleCategory = "unknown";
    let bestScore = 0;

    for (const [category, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    return bestCategory;
  }

  /**
   * Aggregates confidence from multiple rules.
   * High if any high, medium if any medium, otherwise low.
   */
  private aggregateConfidence(rules: ClassificationRule[]): RuleConfidence {
    if (rules.some((r) => r.confidence === "high")) return "high";
    if (rules.some((r) => r.confidence === "medium")) return "medium";
    return "low";
  }

  /**
   * Builds human-readable reasons from matched rules.
   */
  private buildReasons(rules: ClassificationRule[]): string[] {
    return rules.map((rule) => `${rule.description} (${rule.name})`);
  }

  /**
   * Converts confidence level to numeric weight for scoring.
   */
  private confidenceToWeight(confidence: RuleConfidence): number {
    switch (confidence) {
      case "high":
        return 3;
      case "medium":
        return 2;
      case "low":
        return 1;
    }
  }
}
