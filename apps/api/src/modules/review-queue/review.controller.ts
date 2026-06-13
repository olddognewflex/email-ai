import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Logger,
  Param,
  Query,
  Redirect,
} from "@nestjs/common";
import { EmailCategorySchema } from "@email-ai/shared";
import {
  ClassificationDetail,
  ReviewQueueService,
} from "./review-queue.service";

/**
 * Server-rendered web UI for working the review queue. Emails are
 * untrusted input: every email-derived string is HTML-escaped, and
 * HTML bodies render only inside a fully sandboxed iframe (no
 * scripts) with remote images blocked by CSP unless ?images=1.
 *
 * Decisions are side-effectful GETs, consistent with the digest-link
 * routes in ReviewQueueController: acceptable for this single-user
 * localhost tool.
 */
@Controller("review")
export class ReviewController {
  private readonly logger = new Logger(ReviewController.name);

  constructor(private readonly reviewQueueService: ReviewQueueService) {}

  @Get()
  @Header("Content-Type", "text/html")
  async queuePage(): Promise<string> {
    const { items, pagination } = await this.reviewQueueService.getReviewQueue(
      1,
      50,
    );

    if (items.length === 0) {
      return this.page(
        "Review queue",
        `<h1>Review queue</h1>
<p style="color: #888">Queue empty — nothing awaiting review. 🎉</p>`,
      );
    }

    const rows = items
      .map((item) => {
        const from =
          item.email.fromName || item.email.fromAddress || "Unknown sender";
        const subject = item.email.subject || "(No subject)";
        return `<tr>
<td><a href="/review/${encodeURIComponent(item.classification.id)}">${esc(subject)}</a></td>
<td>${esc(from)}</td>
<td><code>${esc(item.classification.category)}</code></td>
<td>${esc(item.classification.confidence)}</td>
</tr>`;
      })
      .join("\n");

    return this.page(
      "Review queue",
      `<h1>Review queue</h1>
<p style="color: #888">${pagination.total} pending (showing up to 50)</p>
<table>
<thead><tr><th>Subject</th><th>From</th><th>AI category</th><th>Confidence</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
    );
  }

  @Get(":id")
  @Header("Content-Type", "text/html")
  async detailPage(
    @Param("id") id: string,
    @Query("images") images?: string,
  ): Promise<string> {
    const detail = await this.reviewQueueService.getClassificationDetail(id);
    const allowImages = images === "1";

    const from = detail.email.fromName
      ? `${detail.email.fromName} <${detail.email.fromAddress ?? ""}>`
      : (detail.email.fromAddress ?? "Unknown sender");
    const subject = detail.email.subject || "(No subject)";

    const decisionBanner = detail.reviewDecision
      ? `<p style="padding: 0.5rem 1rem; background: #fff3cd; border: 1px solid #ffe69c; border-radius: 6px">
Already decided: <strong>${esc(detail.reviewDecision.decision)}</strong>${
          detail.reviewDecision.correctedCategory
            ? ` → <code>${esc(detail.reviewDecision.correctedCategory)}</code>`
            : ""
        } at ${esc(detail.reviewDecision.decidedAt.toLocaleString())}</p>`
      : "";

    const rejectAsButtons = EmailCategorySchema.options
      .map(
        (category) =>
          `<a class="btn" href="/review/${encodeURIComponent(id)}/reject?category=${category}">Reject as ${category}</a>`,
      )
      .join("\n");

    return this.page(
      `Review: ${subject}`,
      `<p><a href="/review">← Back to queue</a></p>
<h1>${esc(subject)}</h1>
<p><strong>${esc(from)}</strong> · ${esc(detail.email.date.toLocaleString())} · ${esc(detail.email.senderDomain)}${
        detail.email.attachmentCount > 0
          ? ` · 📎 ${detail.email.attachmentCount}`
          : ""
      }</p>
${decisionBanner}
<div style="display: flex; gap: 1rem; flex-wrap: wrap">
${this.classificationPanel(detail)}
${this.rulePanel(detail)}
</div>
<div style="margin: 1rem 0">
<a class="btn approve" href="/review/${encodeURIComponent(id)}/approve">✓ Approve</a>
<a class="btn reject" href="/review/${encodeURIComponent(id)}/reject">✗ Reject</a>
</div>
<div style="margin: 0 0 1rem 0">
${rejectAsButtons}
</div>
<h2>Email body</h2>
${this.bodySection(detail, id, allowImages)}`,
    );
  }

  @Get(":id/approve")
  @Redirect()
  async approveAndNext(@Param("id") id: string) {
    this.logger.log(`Approving classification ${id} (web UI)`);
    await this.reviewQueueService.approveClassification(id);
    return this.redirectToNext();
  }

  @Get(":id/reject")
  @Redirect()
  async rejectAndNext(
    @Param("id") id: string,
    @Query("category") category?: string,
  ) {
    let correctedCategory: string | undefined;
    if (category !== undefined) {
      const parsed = EmailCategorySchema.safeParse(category);
      if (!parsed.success) {
        throw new BadRequestException(
          `Invalid category: ${category}. Valid: ${EmailCategorySchema.options.join(", ")}`,
        );
      }
      correctedCategory = parsed.data;
    }

    this.logger.log(
      `Rejecting classification ${id} (web UI)` +
        (correctedCategory ? ` -> ${correctedCategory}` : ""),
    );
    await this.reviewQueueService.rejectClassification(id, correctedCategory);
    return this.redirectToNext();
  }

  private async redirectToNext(): Promise<{ url: string; statusCode: number }> {
    const nextId = await this.reviewQueueService.getNextPendingId();
    return {
      url: nextId ? `/review/${encodeURIComponent(nextId)}` : "/review",
      statusCode: 302,
    };
  }

  private classificationPanel(detail: ClassificationDetail): string {
    return `<div class="panel">
<h2>AI classification</h2>
<table class="kv">
<tr><th>Category</th><td><code>${esc(detail.category)}</code></td></tr>
<tr><th>Importance</th><td>${esc(detail.importance)}</td></tr>
<tr><th>Urgency</th><td>${esc(detail.urgency)}</td></tr>
<tr><th>Action</th><td>${esc(detail.recommendedAction)}</td></tr>
<tr><th>Confidence</th><td>${esc(detail.confidence)}</td></tr>
${detail.providerUsed ? `<tr><th>Provider</th><td>${esc(detail.providerUsed)}</td></tr>` : ""}
</table>
<p>${esc(detail.reason)}</p>
</div>`;
  }

  private rulePanel(detail: ClassificationDetail): string {
    const reasons =
      detail.rule.reasons.length > 0
        ? `<ul>${detail.rule.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
        : "<p style=\"color: #888\">No rule reasons recorded.</p>";

    return `<div class="panel">
<h2>Rule-based</h2>
<table class="kv">
<tr><th>Category</th><td><code>${esc(detail.rule.category ?? "—")}</code></td></tr>
<tr><th>Confidence</th><td>${esc(detail.rule.confidence ?? "—")}</td></tr>
</table>
${reasons}
</div>`;
  }

  private bodySection(
    detail: ClassificationDetail,
    id: string,
    allowImages: boolean,
  ): string {
    if (!detail.body.html) {
      return `<pre class="body-text">${esc(detail.body.text)}</pre>`;
    }

    const toggle = allowImages
      ? `<p><a href="/review/${encodeURIComponent(id)}">Block remote images</a></p>`
      : `<p><a href="/review/${encodeURIComponent(id)}?images=1">Load remote images</a></p>`;

    // sandbox="" blocks scripts, forms, popups, and same-origin access.
    // On top of that, a CSP <meta> injected into the srcdoc blocks
    // remote image loads (tracking pixels) unless explicitly allowed.
    const srcdoc = this.buildSrcdoc(detail.body.html, allowImages);

    return `${toggle}
<iframe sandbox="" srcdoc="${escAttr(srcdoc)}" style="width: 100%; height: 70vh; border: 1px solid #ccc; border-radius: 6px; background: #fff"></iframe>`;
  }

  private buildSrcdoc(html: string, allowImages: boolean): string {
    if (allowImages) {
      return html;
    }

    const csp = `<meta http-equiv="Content-Security-Policy" content="img-src data:;">`;
    const headMatch = /<head[^>]*>/i.exec(html);
    if (headMatch) {
      const insertAt = headMatch.index + headMatch[0].length;
      return html.slice(0, insertAt) + csp + html.slice(insertAt);
    }
    // No <head>: a leading <meta> lands in the implicit head the HTML
    // parser creates, so the CSP still applies.
    return csp + html;
  }

  private page(title: string, body: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body { font-family: system-ui; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid #ddd; }
table.kv { width: auto; }
table.kv th { color: #888; font-weight: normal; padding-left: 0; }
.panel { flex: 1 1 20rem; border: 1px solid #ddd; border-radius: 6px; padding: 0 1rem 0.5rem 1rem; }
.panel h2 { font-size: 1rem; }
.btn { display: inline-block; margin: 0.25rem; padding: 0.5rem 1rem; border: 1px solid #888; border-radius: 6px; text-decoration: none; color: inherit; }
.btn.approve { border-color: #2e7d32; color: #2e7d32; }
.btn.reject { border-color: #c62828; color: #c62828; }
pre.body-text { white-space: pre-wrap; border: 1px solid #ccc; border-radius: 6px; padding: 1rem; background: #fafafa; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1.1rem; }
code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>
</head>
<body>
${body}
</body></html>`;
  }
}

/** Escape an untrusted string for interpolation into HTML markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape an HTML document for embedding in a srcdoc attribute. Only
 * `&` and `"` need escaping — the inner markup must survive intact.
 */
function escAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
