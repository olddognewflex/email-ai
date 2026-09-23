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
import {
  DEFAULT_REVIEW_WINDOW_DAYS,
  formatLocalDate,
  resolveReviewWindow,
  ReviewWindow,
} from "./review-window";

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
  async queuePage(
    @Query("days") days?: string,
    @Query("since") since?: string,
    @Query("all") all?: string,
  ): Promise<string> {
    const window = resolveReviewWindow({ days, since, all });
    const { items, pagination } = await this.reviewQueueService.getReviewQueue(
      1,
      50,
      undefined,
      window,
    );
    return this.queueListPage(
      "review",
      "Review queue",
      items,
      pagination,
      window,
      {
        empty: "Queue empty — nothing awaiting review. 🎉",
        count: "pending",
      },
    );
  }

  @Get("actionable")
  @Header("Content-Type", "text/html")
  async actionablePage(
    @Query("days") days?: string,
    @Query("since") since?: string,
    @Query("all") all?: string,
  ): Promise<string> {
    const window = resolveReviewWindow({ days, since, all });
    const { items, pagination } =
      await this.reviewQueueService.getActionableQueue(1, 50, window);
    return this.queueListPage(
      "actionable",
      "Actionable",
      items,
      pagination,
      window,
      {
        empty: "Nothing needs action right now. 🎉",
        count: "actionable",
      },
    );
  }

  /** Shared list rendering for the review and actionable queues. */
  private queueListPage(
    view: "review" | "actionable",
    title: string,
    items: Awaited<
      ReturnType<ReviewQueueService["getReviewQueue"]>
    >["items"],
    pagination: { total: number },
    window: ReviewWindow,
    labels: { empty: string; count: string },
  ): string {
    const query = esc(windowQuery(window));
    const nav = this.nav(view, query);
    const windowLine = this.windowLine(view, window);
    const detailSuffix = esc(
      withParams("", [
        ...(view === "actionable" ? ["from=actionable"] : []),
        ...windowParams(window),
      ]),
    );

    if (items.length === 0) {
      return this.page(
        title,
        `${nav}<h1>${esc(title)}</h1>
${windowLine}
<p style="color: #888">${esc(labels.empty)}</p>`,
      );
    }

    const rows = items
      .map((item) => {
        const from =
          item.email.fromName || item.email.fromAddress || "Unknown sender";
        const subject = item.email.subject || "(No subject)";
        const account = item.email.accountLabel || "—";
        const unsubscribe = item.email.unsubscribeLink
          ? `<a class="unsub" href="${esc(item.email.unsubscribeLink)}" target="_blank" rel="noopener noreferrer">↪ Unsubscribe</a>`
          : "";
        return `<tr>
<td>${esc(account)}</td>
<td><a href="/review/${encodeURIComponent(item.classification.id)}${detailSuffix}">${esc(subject)}</a></td>
<td>${esc(from)}</td>
<td><code>${esc(item.classification.category)}</code></td>
<td>${esc(item.classification.confidence)}</td>
<td>${unsubscribe}</td>
</tr>`;
      })
      .join("\n");

    return this.page(
      title,
      `${nav}<h1>${esc(title)}</h1>
${windowLine}
<p style="color: #888">${pagination.total} ${esc(labels.count)} (showing up to 50)</p>
<table>
<thead><tr><th>Account</th><th>Subject</th><th>From</th><th>AI category</th><th>Confidence</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
    );
  }

  /**
   * The active received-date window, with a link to widen it to all mail
   * (or back to the default window when already showing everything).
   */
  private windowLine(
    view: "review" | "actionable",
    window: ReviewWindow,
  ): string {
    const base = view === "actionable" ? "/review/actionable" : "/review";
    if (!window.since) {
      return `<p style="color: #888">Showing all mail · <a href="${base}">last ${DEFAULT_REVIEW_WINDOW_DAYS} days</a></p>`;
    }
    const days = window.days !== null ? ` (last ${window.days} days)` : "";
    return `<p style="color: #888">Showing mail received since ${esc(formatLocalDate(window.since))}${esc(days)} · <a href="${base}?all=true">show all</a></p>`;
  }

  /** Top nav linking the two queue views; the active one is bolded. */
  private nav(active: "review" | "actionable", query = ""): string {
    const link = (
      href: string,
      label: string,
      isActive: boolean,
    ): string =>
      isActive
        ? `<strong>${esc(label)}</strong>`
        : `<a href="${href}">${esc(label)}</a>`;
    return `<nav style="margin-bottom: 1rem; color: #888">
${link(`/review${query}`, "Needs review", active === "review")} ·
${link(`/review/actionable${query}`, "Actionable", active === "actionable")}
</nav>`;
  }

  @Get(":id")
  @Header("Content-Type", "text/html")
  async detailPage(
    @Param("id") id: string,
    @Query("images") images?: string,
    @Query("from") fromView?: string,
    @Query("days") days?: string,
    @Query("since") since?: string,
    @Query("all") all?: string,
  ): Promise<string> {
    const window = resolveReviewWindow({ days, since, all });
    const detail = await this.reviewQueueService.getClassificationDetail(id);
    const allowImages = images === "1";

    // Which list (and received-date window) the user came from, so every
    // link back out (back, approve, reject, image toggle, decision
    // redirect) returns to the same view with the same window.
    const origin: "review" | "actionable" =
      fromView === "actionable" ? "actionable" : "review";
    const backHref = esc(
      (origin === "actionable" ? "/review/actionable" : "/review") +
        windowQuery(window),
    );
    const backLabel =
      origin === "actionable" ? "actionable" : "review queue";
    const carried = [
      ...(origin === "actionable" ? ["from=actionable"] : []),
      ...windowParams(window),
    ];
    const withFrom = (path: string): string => esc(withParams(path, carried));

    const from = detail.email.fromName
      ? `${detail.email.fromName} <${detail.email.fromAddress ?? ""}>`
      : (detail.email.fromAddress ?? "Unknown sender");
    const subject = detail.email.subject || "(No subject)";
    const account = detail.email.accountLabel || "—";

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
          `<a class="btn" href="${withFrom(`/review/${encodeURIComponent(id)}/reject?category=${category}`)}">Reject as ${category}</a>`,
      )
      .join("\n");

    return this.page(
      `Review: ${subject}`,
      `<p><a href="${backHref}">← Back to ${esc(backLabel)}</a></p>
<h1>${esc(subject)}</h1>
<p>To: <strong>${esc(account)}</strong></p>
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
<a class="btn approve" href="${withFrom(`/review/${encodeURIComponent(id)}/approve`)}">✓ Approve</a>
<a class="btn reject" href="${withFrom(`/review/${encodeURIComponent(id)}/reject`)}">✗ Reject</a>
${
        detail.email.unsubscribeLink
          ? `<a class="btn unsub" href="${esc(detail.email.unsubscribeLink)}" target="_blank" rel="noopener noreferrer">↪ Unsubscribe</a>`
          : ""
      }
</div>
<div style="margin: 0 0 1rem 0">
${rejectAsButtons}
</div>
<h2>Email body</h2>
${this.bodySection(detail, id, allowImages, carried)}`,
    );
  }

  @Get(":id/approve")
  @Redirect()
  async approveAndNext(
    @Param("id") id: string,
    @Query("from") fromView?: string,
    @Query("days") days?: string,
    @Query("since") since?: string,
    @Query("all") all?: string,
  ) {
    // Resolve before acting so an invalid window 400s without a decision.
    const window = resolveReviewWindow({ days, since, all });
    this.logger.log(`Approving classification ${id} (web UI)`);
    await this.reviewQueueService.approveClassification(id);
    return this.redirectToNext(fromView, window);
  }

  @Get(":id/reject")
  @Redirect()
  async rejectAndNext(
    @Param("id") id: string,
    @Query("category") category?: string,
    @Query("from") fromView?: string,
    @Query("days") days?: string,
    @Query("since") since?: string,
    @Query("all") all?: string,
  ) {
    const window = resolveReviewWindow({ days, since, all });
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
    return this.redirectToNext(fromView, window);
  }

  /**
   * After a web-UI decision, return to where the user was. The actionable
   * list isn't decision-gated (items don't disappear), so there's no
   * "next pending" to advance to — go back to the list. The review queue
   * advances to the next item still awaiting review within the active
   * received-date window. Every redirect keeps a non-default window.
   */
  private async redirectToNext(
    fromView: string | undefined,
    window: ReviewWindow,
  ): Promise<{ url: string; statusCode: number }> {
    const query = windowQuery(window);
    if (fromView === "actionable") {
      return { url: `/review/actionable${query}`, statusCode: 302 };
    }
    const nextId = await this.reviewQueueService.getNextPendingId(window);
    return {
      url: nextId ? `/review/${encodeURIComponent(nextId)}${query}` : `/review${query}`,
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
    carried: string[],
  ): string {
    if (!detail.body.html) {
      return `<pre class="body-text">${esc(detail.body.text)}</pre>`;
    }

    const base = `/review/${encodeURIComponent(id)}`;
    const toggle = allowImages
      ? `<p><a href="${esc(withParams(base, carried))}">Block remote images</a></p>`
      : `<p><a href="${esc(withParams(base, ["images=1", ...carried]))}">Load remote images</a></p>`;

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
.btn.unsub { border-color: #1565c0; color: #1565c0; }
a.unsub { color: #1565c0; text-decoration: none; font-size: 0.85rem; }
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

/**
 * Query params that reproduce a non-default window (none for the
 * default), so links and redirects keep the user's window. Built from
 * the validated window, not raw input. Raw URL text: callers esc() it
 * when interpolating into HTML.
 */
function windowParams(window: ReviewWindow): string[] {
  if (!window.since) return ["all=true"];
  if (window.days === null) {
    return [`since=${formatLocalDate(window.since)}`];
  }
  if (window.days !== DEFAULT_REVIEW_WINDOW_DAYS) {
    return [`days=${window.days}`];
  }
  return [];
}

/** `?`-prefixed form of windowParams(), or "" for the default window. */
function windowQuery(window: ReviewWindow): string {
  return withParams("", windowParams(window));
}

/** Append `key=value` params to a path, joining with ? or & as needed. */
function withParams(path: string, params: string[]): string {
  if (params.length === 0) return path;
  return path + (path.includes("?") ? "&" : "?") + params.join("&");
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
