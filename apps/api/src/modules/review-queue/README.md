# Review Queue Module

This module provides a review queue API for manually reviewing AI-generated email classifications.

## Overview

Emails that need human review are those where:

- `needsReview` flag is `true` (explicitly flagged by classifier)
- OR confidence is below the threshold (default: "medium")

User decisions are stored in the `ReviewDecision` table for audit and potential training data.

## API Endpoints

### GET /review-queue

List emails pending review with pagination and filtering.

**Query Parameters:**

- `page` (number, optional): Page number, default 1
- `limit` (number, optional): Items per page, default 20
- `confidenceThreshold` (string, optional): Minimum confidence to include ("low", "medium", "high"), default "medium"

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "classification": {
        "id": "cl...",
        "category": "receipt",
        "importance": "medium",
        "urgency": "none",
        "recommendedAction": "archive",
        "confidence": "low",
        "needsReview": true,
        "reason": "Purchase receipt but confidence is low due to unusual formatting",
        "createdAt": "2025-01-15T10:30:00.000Z"
      },
      "email": {
        "id": "cl...",
        "subject": "Your Amazon Order Confirmation",
        "fromAddress": "order-update@amazon.com",
        "fromName": "Amazon.com",
        "senderDomain": "amazon.com",
        "internalDate": "2025-01-15T10:30:00.000Z"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

### POST /review-queue/:id/approve

Approve a classification decision. The email will be removed from the review queue.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "cl...",
    "classificationId": "cl...",
    "decision": "approved",
    "decidedAt": "2025-01-15T11:00:00.000Z"
  },
  "message": "Classification approved successfully"
}
```

### POST /review-queue/:id/reject

Reject a classification decision. The email will be removed from the review queue.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "cl...",
    "classificationId": "cl...",
    "decision": "rejected",
    "decidedAt": "2025-01-15T11:00:00.000Z"
  },
  "message": "Classification rejected successfully"
}
```

## Database Schema

### ReviewDecision

```prisma
model ReviewDecision {
  id                String            @id @default(cuid())
  classificationId  String            @unique
  decision          ReviewDecisionType // approved | rejected
  decidedAt         DateTime          @default(now())

  classification    EmailClassification @relation(fields: [classificationId], references: [id], onDelete: Cascade)

  @@index([decision])
  @@index([decidedAt])
}

enum ReviewDecisionType {
  approved
  rejected
}
```

## Verification Steps

### 1. Start the development server

```bash
pnpm --filter @email-ai/api start:dev
```

### 2. Test the review queue endpoint

```bash
# Get the first page of review queue
curl http://localhost:3000/review-queue

# Get page 2 with 10 items per page
curl "http://localhost:3000/review-queue?page=2&limit=10"

# Filter by confidence threshold
curl "http://localhost:3000/review-queue?confidenceThreshold=high"
```

### 3. Test approve/reject endpoints

```bash
# Get a classification ID from the review queue
CLASSIFICATION_ID=$(curl -s http://localhost:3000/review-queue | jq -r '.data[0].classification.id')

# Approve it
curl -X POST "http://localhost:3000/review-queue/$CLASSIFICATION_ID/approve"

# Or reject it
curl -X POST "http://localhost:3000/review-queue/$CLASSIFICATION_ID/reject"

# Verify it's removed from the queue
curl http://localhost:3000/review-queue
```

### 4. Verify database state

```bash
# Connect to the database
docker compose exec postgres psql -U email_ai -d email_ai

# Check review decisions
SELECT
  rd.id,
  rd.decision,
  rd.decided_at,
  ec.category,
  ec.confidence
FROM review_decision rd
JOIN email_classification ec ON rd.classification_id = ec.id
ORDER BY rd.decided_at DESC;
```

## Architecture

```
GET /review-queue
  ↓
ReviewQueueController
  ↓
ReviewQueueService.getReviewQueue()
  ↓
Prisma: Find classifications where
  (needsReview = true OR confidence <= threshold)
  AND no reviewDecision exists
  ↓
Return paginated items with email data

POST /review-queue/:id/approve|reject
  ↓
ReviewQueueController
  ↓
ReviewQueueService.approve|rejectClassification()
  ↓
Prisma: Create ReviewDecision record
  ↓
Return decision confirmation
```

## Design Decisions

1. **No Mailbox Actions**: As per constraints, approving/rejecting only records the decision. No emails are moved, deleted, or modified in the mailbox.

2. **Soft Queue**: Items are excluded from the queue by creating a ReviewDecision record, not by deleting or flagging the classification.

3. **Confidence Threshold**: Configurable threshold allows filtering by confidence level. Default is "medium" which includes low and medium confidence items.

4. **Pagination**: Simple offset-based pagination with configurable page size.

5. **Audit Trail**: All decisions are stored with timestamps for potential ML training feedback loops.

## Constraints

- Never auto-delete emails
- Never silently mutate mailbox state
- Always default to including items needing review
- Store all user decisions for audit purposes
