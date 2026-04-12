import { LlmRequest, LlmResponse } from "@email-ai/shared";
import { BaseLlmProvider } from "./base.provider";

export class MockLlmProvider implements BaseLlmProvider {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const lowerPrompt = request.prompt.toLowerCase();

    if (
      lowerPrompt.includes("receipt") ||
      lowerPrompt.includes("order") ||
      lowerPrompt.includes("invoice")
    ) {
      return {
        content: JSON.stringify({
          category: "receipt",
          importance: "medium",
          urgency: "none",
          recommendedAction: "archive",
          confidence: "high",
          needsReview: false,
          reason: "Purchase receipt with order confirmation details",
        }),
      };
    }

    if (
      lowerPrompt.includes("newsletter") ||
      lowerPrompt.includes("unsubscribe")
    ) {
      return {
        content: JSON.stringify({
          category: "newsletter",
          importance: "low",
          urgency: "none",
          recommendedAction: "unsubscribe",
          confidence: "high",
          needsReview: false,
          reason: "Marketing newsletter with unsubscribe link",
        }),
      };
    }

    if (
      lowerPrompt.includes("security") ||
      lowerPrompt.includes("alert") ||
      lowerPrompt.includes("login")
    ) {
      return {
        content: JSON.stringify({
          category: "notification",
          importance: "critical",
          urgency: "immediate",
          recommendedAction: "read_now",
          confidence: "high",
          needsReview: false,
          reason: "Security alert requiring immediate attention",
        }),
      };
    }

    if (
      lowerPrompt.includes("hi ") ||
      lowerPrompt.includes("hello ") ||
      lowerPrompt.includes("meeting")
    ) {
      return {
        content: JSON.stringify({
          category: "personal",
          importance: "high",
          urgency: "today",
          recommendedAction: "reply_needed",
          confidence: "medium",
          needsReview: false,
          reason: "Personal correspondence requiring response",
        }),
      };
    }

    return {
      content: JSON.stringify({
        category: "unknown",
        importance: "low",
        urgency: "none",
        recommendedAction: "no_action",
        confidence: "low",
        needsReview: true,
        reason: "Unable to classify confidently - insufficient signals",
      }),
    };
  }
}
