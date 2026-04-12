import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ReviewDecisionType } from "@prisma/client";

export interface ReviewQueueItem {
  classification: {
    id: string;
    category: string;
    importance: string;
    urgency: string;
    recommendedAction: string;
    confidence: string;
    needsReview: boolean;
    reason: string;
    createdAt: Date;
  };
  email: {
    id: string;
    subject: string | null;
    fromAddress: string | null;
    fromName: string | null;
    senderDomain: string;
    internalDate: Date;
  };
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ReviewDecisionResponse {
  id: string;
  classificationId: string;
  decision: ReviewDecisionType;
  decidedAt: Date;
}

@Injectable()
export class ReviewQueueService {
  private readonly logger = new Logger(ReviewQueueService.name);
  private readonly DEFAULT_CONFIDENCE_THRESHOLD = "medium";

  constructor(private readonly db: DatabaseService) {}

  async getReviewQueue(
    page: number = 1,
    limit: number = 20,
    confidenceThreshold?: string,
  ): Promise<ReviewQueueResponse> {
    const skip = (page - 1) * limit;
    const threshold = confidenceThreshold || this.DEFAULT_CONFIDENCE_THRESHOLD;

    const confidenceLevels = ["low", "medium", "high"];
    const thresholdIndex = confidenceLevels.indexOf(threshold);

    const whereClause: any = {
      OR: [
        { needsReview: true },
        {
          confidence: {
            in: confidenceLevels.slice(0, thresholdIndex + 1),
          },
        },
      ],
      reviewDecision: null,
    };

    const [classifications, total] = await Promise.all([
      this.db.emailClassification.findMany({
        where: whereClause,
        include: {
          normalizedEmail: {
            include: {
              parsedEmail: {
                include: {
                  rawEmail: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        skip,
        take: limit,
      }),
      this.db.emailClassification.count({
        where: whereClause,
      }),
    ]);

    const items: ReviewQueueItem[] = classifications.map((classification) => {
      const normalizedEmail = classification.normalizedEmail;
      const parsedEmail = normalizedEmail?.parsedEmail;
      const rawEmail = parsedEmail?.rawEmail;

      return {
        classification: {
          id: classification.id,
          category: classification.category,
          importance: classification.importance,
          urgency: classification.urgency,
          recommendedAction: classification.recommendedAction,
          confidence: classification.confidence,
          needsReview: classification.needsReview,
          reason: classification.reason,
          createdAt: classification.createdAt,
        },
        email: {
          id: normalizedEmail?.id || "",
          subject: parsedEmail?.subject || null,
          fromAddress: parsedEmail?.fromAddress || null,
          fromName: parsedEmail?.fromName || null,
          senderDomain: normalizedEmail?.senderDomain || "",
          internalDate: rawEmail?.internalDate || new Date(),
        },
      };
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async approveClassification(
    classificationId: string,
  ): Promise<ReviewDecisionResponse> {
    const classification = await this.db.emailClassification.findUnique({
      where: { id: classificationId },
      include: { reviewDecision: true },
    });

    if (!classification) {
      throw new NotFoundException(
        `Classification ${classificationId} not found`,
      );
    }

    if (classification.reviewDecision) {
      this.logger.warn(
        `Classification ${classificationId} already has a review decision. Updating to approved.`,
      );
      await this.db.reviewDecision.delete({
        where: { classificationId },
      });
    }

    const decision = await this.db.reviewDecision.create({
      data: {
        classificationId,
        decision: ReviewDecisionType.approved,
      },
    });

    this.logger.log(`Approved classification ${classificationId}`);

    return {
      id: decision.id,
      classificationId: decision.classificationId,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
    };
  }

  async rejectClassification(
    classificationId: string,
  ): Promise<ReviewDecisionResponse> {
    const classification = await this.db.emailClassification.findUnique({
      where: { id: classificationId },
      include: { reviewDecision: true },
    });

    if (!classification) {
      throw new NotFoundException(
        `Classification ${classificationId} not found`,
      );
    }

    if (classification.reviewDecision) {
      this.logger.warn(
        `Classification ${classificationId} already has a review decision. Updating to rejected.`,
      );
      await this.db.reviewDecision.delete({
        where: { classificationId },
      });
    }

    const decision = await this.db.reviewDecision.create({
      data: {
        classificationId,
        decision: ReviewDecisionType.rejected,
      },
    });

    this.logger.log(`Rejected classification ${classificationId}`);

    return {
      id: decision.id,
      classificationId: decision.classificationId,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
    };
  }
}
