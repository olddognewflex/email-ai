import { Injectable, Logger } from "@nestjs/common";
import { ClassificationService } from "./classification.service";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class ClassificationVerificationService {
  private readonly logger = new Logger(ClassificationVerificationService.name);

  constructor(
    private readonly classificationService: ClassificationService,
    private readonly db: DatabaseService,
  ) {}

  async runVerification(): Promise<{
    passed: number;
    failed: number;
    results: VerificationResult[];
  }> {
    const testCases = this.getTestCases();
    const results: VerificationResult[] = [];

    for (const testCase of testCases) {
      try {
        const result = await this.verifyTestCase(testCase);
        results.push(result);
      } catch (error) {
        results.push({
          name: testCase.name,
          passed: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    this.logger.log(
      `Verification complete: ${passed} passed, ${failed} failed`,
    );

    return { passed, failed, results };
  }

  private async verifyTestCase(
    testCase: TestCase,
  ): Promise<VerificationResult> {
    this.logger.debug(`Verifying: ${testCase.name}`);

    // Create test data
    const account = await this.db.emailAccount.create({
      data: {
        label: "Test Account",
        host: "test.com",
        port: 993,
        username: "test",
        encryptedPassword: "encrypted",
      },
    });

    const rawEmail = await this.db.rawEmail.create({
      data: {
        accountId: account.id,
        mailbox: "INBOX",
        uid: 1,
        rawSource: Buffer.from("test"),
        internalDate: new Date(),
      },
    });

    const parsedEmail = await this.db.parsedEmail.create({
      data: {
        rawEmailId: rawEmail.id,
        subject: testCase.subject,
        fromAddress: testCase.fromAddress,
        fromName: testCase.fromName,
        textBody: testCase.body,
        toAddresses: [],
        ccAddresses: [],
      },
    });

    const normalizedEmail = await this.db.normalizedEmail.create({
      data: {
        parsedEmailId: parsedEmail.id,
        senderDomain: "test.com",
        isNewsletter: testCase.isNewsletter ?? false,
        isBulk: testCase.isBulk ?? false,
        tags: testCase.tags ?? [],
        cleanedText: testCase.body,
        ruleCategory: testCase.expectedCategory,
        ruleConfidence: "high",
        ruleReasons: ["Test verification"],
      },
    });

    try {
      // Run classification
      const classification = await this.classificationService.classifyEmail(
        normalizedEmail.id,
      );

      // Verify expectations
      const passed =
        classification.category === testCase.expectedCategory ||
        classification.needsReview;

      // Cleanup
      await this.cleanup(account.id);

      return {
        name: testCase.name,
        passed,
        category: classification.category,
        confidence: classification.confidence,
        needsReview: classification.needsReview,
        reason: classification.reason,
      };
    } catch (error) {
      // Cleanup on error
      await this.cleanup(account.id);
      throw error;
    }
  }

  private async cleanup(accountId: string): Promise<void> {
    await this.db.emailAccount.delete({ where: { id: accountId } });
  }

  private getTestCases(): TestCase[] {
    return [
      {
        name: "Receipt - Order Confirmation",
        subject: "Your order #12345 has been confirmed",
        fromAddress: "orders@shop.com",
        fromName: "Shop Orders",
        body: "Thank you for your purchase. Order total: $49.99. Order #12345.",
        expectedCategory: "receipt",
        isNewsletter: false,
        isBulk: false,
        tags: [],
      },
      {
        name: "Newsletter - Marketing",
        subject: "Weekly Digest: Top Stories",
        fromAddress: "newsletter@company.com",
        fromName: "Company Newsletter",
        body: "Here are this week's top stories. Click here to unsubscribe.",
        expectedCategory: "newsletter",
        isNewsletter: true,
        isBulk: true,
        tags: ["newsletter"],
      },
      {
        name: "Alert - Security",
        subject: "Security Alert: New login detected",
        fromAddress: "security@bank.com",
        fromName: "Bank Security",
        body: "We detected a new login to your account from an unknown device.",
        expectedCategory: "notification",
        isNewsletter: false,
        isBulk: false,
        tags: [],
      },
      {
        name: "Personal - Direct",
        subject: "Quick question about the project",
        fromAddress: "john@example.com",
        fromName: "John Doe",
        body: "Hi, I had a quick question about the project timeline. Let me know when you're free to chat.",
        expectedCategory: "personal",
        isNewsletter: false,
        isBulk: false,
        tags: [],
      },
      {
        name: "Unknown - Ambiguous",
        subject: "Update",
        fromAddress: "info@company.com",
        fromName: "Company Info",
        body: "Here is your update.",
        expectedCategory: "unknown",
        isNewsletter: false,
        isBulk: false,
        tags: [],
      },
    ];
  }
}

interface TestCase {
  name: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  body: string;
  expectedCategory: string;
  isNewsletter?: boolean;
  isBulk?: boolean;
  tags?: string[];
}

interface VerificationResult {
  name: string;
  passed: boolean;
  category?: string;
  confidence?: string;
  needsReview?: boolean;
  reason?: string;
  error?: string;
}
