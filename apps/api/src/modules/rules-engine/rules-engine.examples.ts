import { RulesEngineInput, RulesEngineResult } from "@email-ai/shared";

/**
 * Example email inputs for testing the rules engine.
 * These demonstrate different classification scenarios.
 */
export const exampleEmails: { name: string; input: RulesEngineInput }[] = [
  {
    name: "Newsletter with unsubscribe",
    input: {
      subject: "Weekly Tech Digest - Issue #42",
      fromAddress: "newsletter@techweekly.com",
      fromName: "Tech Weekly",
      textBody: "Welcome to this week's tech digest...",
      htmlBody: "<h1>Weekly Tech Digest</h1><p>Welcome...</p>",
      senderDomain: "techweekly.com",
      isNewsletter: true,
      isBulk: true,
      hasUnsubscribe: true,
      unsubscribeLink: "https://techweekly.com/unsubscribe",
      tags: ["List-Id: <newsletter.techweekly.com>"],
    },
  },
  {
    name: "Purchase receipt",
    input: {
      subject: "Order Confirmation #12345 - Thank you for your purchase!",
      fromAddress: "orders@shop.example.com",
      fromName: "Example Shop",
      textBody: `Thank you for your order!

Order Total: $49.99
Payment Method: Visa ending in 1234
Billing Address: 123 Main St

Order Number: #12345`,
      htmlBody: null,
      senderDomain: "shop.example.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "Security alert",
    input: {
      subject: "Security Alert: New login from unknown device",
      fromAddress: "security@bank.example.com",
      fromName: "Security Team",
      textBody:
        "We detected a new login to your account from an unknown device...",
      htmlBody: null,
      senderDomain: "bank.example.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "Personal email with greeting",
    input: {
      subject: "Quick question about the project",
      fromAddress: "john@example.com",
      fromName: "John Doe",
      textBody: `Hi Alice,

Hope you're doing well! I had a quick question about the timeline.

Let me know when you have a chance.

Thanks,
John`,
      htmlBody: null,
      senderDomain: "example.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "Marketing email from bulk sender",
    input: {
      subject: "Special Offer Just For You!",
      fromAddress: "marketing@mailchimp.com",
      fromName: "Amazing Deals",
      textBody: "Check out our amazing deals this week...",
      htmlBody: "<h1>Amazing Deals</h1><a href='...'>Unsubscribe</a>",
      senderDomain: "mailchimp.com",
      isNewsletter: false,
      isBulk: true,
      hasUnsubscribe: true,
      tags: [],
    },
  },
  {
    name: "Unknown - no clear indicators",
    input: {
      subject: "Update",
      fromAddress: "info@company.com",
      fromName: "Company Info",
      textBody: "Here is the update you requested.",
      htmlBody: null,
      senderDomain: "company.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "Invoice email",
    input: {
      subject: "Invoice #2024-001 from Acme Corp",
      fromAddress: "billing@acme-corp.com",
      fromName: "Acme Billing",
      textBody: `Invoice #2024-001

Total Amount: $1,250.00
Payment Due: 30 days

Thank you for your business.`,
      htmlBody: null,
      senderDomain: "acme-corp.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "System maintenance notice",
    input: {
      subject: "[ALERT] Scheduled Maintenance Window - This Weekend",
      fromAddress: "noreply@status.example.com",
      fromName: "Status Notifications",
      textBody: "We will be performing scheduled maintenance this weekend...",
      htmlBody: null,
      senderDomain: "status.example.com",
      isNewsletter: false,
      isBulk: true,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "Reply with Re: prefix",
    input: {
      subject: "Re: Meeting notes",
      fromAddress: "sarah@example.com",
      fromName: "Sarah Smith",
      textBody: `Hey,

Thanks for sending these over. A few thoughts...

Best,
Sarah`,
      htmlBody: null,
      senderDomain: "example.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
  {
    name: "Subscription confirmation",
    input: {
      subject: "Your subscription payment has been processed",
      fromAddress: "payments@stripe.com",
      fromName: "Stripe Payments",
      textBody: "Your recurring payment was successful...",
      htmlBody: null,
      senderDomain: "stripe.com",
      isNewsletter: false,
      isBulk: false,
      hasUnsubscribe: false,
      tags: [],
    },
  },
];

/**
 * Expected classification results for verification.
 * These are the expected outputs for the example emails above.
 */
export const expectedClassifications: Record<
  string,
  Partial<RulesEngineResult>
> = {
  "Newsletter with unsubscribe": {
    ruleCategory: "newsletter",
    ruleConfidence: "high",
  },
  "Purchase receipt": {
    ruleCategory: "receipt",
    ruleConfidence: "high",
  },
  "Security alert": {
    ruleCategory: "alert",
    ruleConfidence: "high",
  },
  "Personal email with greeting": {
    ruleCategory: "likely_human",
    ruleConfidence: "medium",
  },
  "Marketing email from bulk sender": {
    ruleCategory: "newsletter",
    ruleConfidence: "high",
  },
  "Unknown - no clear indicators": {
    ruleCategory: "newsletter",
    ruleConfidence: "medium",
  },
  "Invoice email": {
    ruleCategory: "receipt",
    ruleConfidence: "high",
  },
  "System maintenance notice": {
    ruleCategory: "alert",
    ruleConfidence: "high",
  },
  "Reply with Re: prefix": {
    ruleCategory: "likely_human",
    ruleConfidence: "medium",
  },
  "Subscription confirmation": {
    ruleCategory: "receipt",
    ruleConfidence: "medium",
  },
};
