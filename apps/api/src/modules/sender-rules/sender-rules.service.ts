import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, SenderRule as SenderRuleRow } from "@prisma/client";
import {
  CreateSenderRule,
  CreateSenderRuleSchema,
  SenderRuleMatchQuery,
  SenderRulePreviewRequest,
  SenderRuleSuggestionsQuery,
  SenderRuleSuggestionsResponse,
  UpdateSenderRule,
  senderPatternTarget,
} from "@email-ai/shared";
import { DatabaseService } from "../database/database.service";
import { SenderRuleMatcher, compileRules } from "./sender-rule-matcher";
import {
  DomainClassificationStats,
  suggestSenderRules,
} from "./sender-rule-suggestions";
import {
  isProtectedDomain,
  protectedHitWarnings,
  protectedHits,
} from "./protected-senders";

export interface SenderRuleWriteResult {
  rule: SenderRuleRow;
  warnings: string[];
}

export type SenderRuleWithCount = SenderRuleRow & {
  _count: { classifications: number };
};

export interface SenderRulePreview {
  /** All stored mail the pattern matches. */
  matchedEmails: number;
  /**
   * Of those, mail with no classification yet: the only mail a new rule
   * would classify. A classification run never reclassifies
   * already-classified mail (POST /sender-rules/:id/reclassify does).
   */
  unclassifiedMatches: number;
  domains: { domain: string; count: number }[];
  protectedHits: string[];
}

export const PREVIEW_TOP_DOMAINS = 25;

/**
 * Domain of an address, as NormalizationService derives senderDomain:
 * everything after the first "@", or "unknown".
 */
function domainOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? "unknown" : address.slice(at + 1);
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

@Injectable()
export class SenderRulesService {
  private readonly logger = new Logger(SenderRulesService.name);
  private matcherCache: Promise<SenderRuleMatcher<SenderRuleRow>> | null =
    null;

  constructor(private readonly db: DatabaseService) {}

  list(): Promise<SenderRuleRow[]> {
    return this.db.senderRule.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * One rule plus how many classifications link to it. Editing a rule
   * does not reclassify that mail by itself (see
   * POST /sender-rules/:id/reclassify), so the TUI reports the count as
   * "stay linked and unchanged" after an edit.
   */
  async get(id: string): Promise<SenderRuleWithCount> {
    const rule = await this.db.senderRule.findUnique({
      where: { id },
      include: { _count: { select: { classifications: true } } },
    });
    if (!rule) {
      throw new NotFoundException(`Sender rule ${id} not found`);
    }
    return rule;
  }

  private async findOrThrow(id: string): Promise<SenderRuleRow> {
    const rule = await this.db.senderRule.findUnique({ where: { id } });
    if (!rule) {
      throw new NotFoundException(`Sender rule ${id} not found`);
    }
    return rule;
  }

  async create(dto: CreateSenderRule): Promise<SenderRuleWriteResult> {
    try {
      const rule = await this.db.senderRule.create({
        data: {
          pattern: dto.pattern,
          matchType: dto.matchType,
          action: dto.action,
          category: dto.category,
          enabled: dto.enabled,
          note: dto.note ?? null,
          source: dto.source ?? "manual",
        },
      });
      this.invalidate();
      return {
        rule,
        warnings: protectedHitWarnings(rule.pattern, rule.matchType),
      };
    } catch (error) {
      throw this.mapWriteError(error, dto);
    }
  }

  /**
   * Merges the patch into the stored rule and re-validates the whole rule
   * with CreateSenderRuleSchema, so a changed matchType re-checks the
   * existing pattern (and vice versa).
   */
  async update(
    id: string,
    patch: UpdateSenderRule,
  ): Promise<SenderRuleWriteResult> {
    const existing = await this.findOrThrow(id);
    const merged = {
      pattern: existing.pattern,
      matchType: existing.matchType,
      action: existing.action,
      category: existing.category,
      enabled: existing.enabled,
      note: existing.note,
      source: existing.source,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ),
    };
    const parsed = CreateSenderRuleSchema.safeParse(merged);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const dto = parsed.data;

    try {
      const rule = await this.db.senderRule.update({
        where: { id },
        data: {
          pattern: dto.pattern,
          matchType: dto.matchType,
          action: dto.action,
          category: dto.category,
          enabled: dto.enabled,
          note: dto.note ?? null,
          source: dto.source ?? existing.source,
        },
      });
      this.invalidate();
      return {
        rule,
        warnings: protectedHitWarnings(rule.pattern, rule.matchType),
      };
    } catch (error) {
      throw this.mapWriteError(error, dto, id);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.db.senderRule.delete({ where: { id } });
    } catch (error) {
      if (isPrismaError(error, "P2025")) {
        throw new NotFoundException(`Sender rule ${id} not found`);
      }
      throw error;
    } finally {
      this.invalidate();
    }
  }

  /**
   * What a pattern would match in mail already stored. Database only: no
   * mailbox access. Counts are grouped server-side, so this reads one row
   * per distinct domain or address rather than one per email.
   */
  async preview(request: SenderRulePreviewRequest): Promise<SenderRulePreview> {
    const matcher = compileRules([
      {
        id: "preview",
        pattern: request.pattern,
        matchType: request.matchType,
        category: "unknown",
        action: "classify",
        createdAt: new Date(0),
      },
    ]);

    // One entry per distinct sender value: its domain, total and
    // unclassified counts.
    const senders = new Map<
      string,
      { domain: string; total: number; unclassified: number }
    >();
    const tally = (
      key: string,
      domain: string,
      field: "total" | "unclassified",
      count: number,
    ) => {
      const entry = senders.get(key) ?? { domain, total: 0, unclassified: 0 };
      entry[field] += count;
      senders.set(key, entry);
    };

    if (this.targetsAddress(request)) {
      const where = { fromAddress: { not: null } };
      const [all, unclassified] = await Promise.all([
        this.db.parsedEmail.groupBy({
          by: ["fromAddress"],
          where,
          _count: { _all: true },
        }),
        this.db.parsedEmail.groupBy({
          by: ["fromAddress"],
          where: {
            ...where,
            OR: [
              { normalized: null },
              { normalized: { is: { classification: null } } },
            ],
          },
          _count: { _all: true },
        }),
      ]);
      for (const [groups, field] of [
        [all, "total"],
        [unclassified, "unclassified"],
      ] as const) {
        for (const g of groups) {
          const address = g.fromAddress?.toLowerCase();
          if (!address) continue;
          tally(address, domainOf(address), field, g._count._all);
        }
      }
      for (const [address, entry] of senders) {
        if (
          !matcher.match({ fromAddress: address, senderDomain: entry.domain })
        ) {
          senders.delete(address);
        }
      }
    } else {
      const [all, unclassified] = await Promise.all([
        this.db.normalizedEmail.groupBy({
          by: ["senderDomain"],
          _count: { _all: true },
        }),
        this.db.normalizedEmail.groupBy({
          by: ["senderDomain"],
          where: { classification: null },
          _count: { _all: true },
        }),
      ]);
      for (const [groups, field] of [
        [all, "total"],
        [unclassified, "unclassified"],
      ] as const) {
        for (const g of groups) {
          const domain = g.senderDomain.toLowerCase();
          tally(domain, domain, field, g._count._all);
        }
      }
      for (const [domain] of senders) {
        if (!matcher.match({ fromAddress: null, senderDomain: domain })) {
          senders.delete(domain);
        }
      }
    }

    let matchedEmails = 0;
    let unclassifiedMatches = 0;
    const byDomain = new Map<string, number>();
    for (const { domain, total, unclassified } of senders.values()) {
      matchedEmails += total;
      unclassifiedMatches += unclassified;
      byDomain.set(domain, (byDomain.get(domain) ?? 0) + total);
    }

    const domains = [...byDomain.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

    const hits = new Set(protectedHits(request.pattern, request.matchType));
    for (const { domain } of domains) {
      if (isProtectedDomain(domain)) hits.add(domain);
    }

    return {
      matchedEmails,
      unclassifiedMatches,
      domains: domains.slice(0, PREVIEW_TOP_DOMAINS),
      protectedHits: [...hits].sort(),
    };
  }

  /**
   * Rule suggestions from classification history: per sender domain, how
   * much `provider`-classified mail was marketing or newsletter, grouped
   * into look-alike families. Read-only: never creates a rule.
   */
  async suggestions(
    query: SenderRuleSuggestionsQuery,
  ): Promise<SenderRuleSuggestionsResponse> {
    const [rows, rules] = await Promise.all([
      this.db.$queryRaw<
        { domain: string; total: number; marketing: number; newsletter: number }[]
      >(Prisma.sql`
        SELECT lower(n."senderDomain") AS domain,
               COUNT(*)::int AS total,
               (COUNT(*) FILTER (WHERE c.category = 'marketing'))::int AS marketing,
               (COUNT(*) FILTER (WHERE c.category = 'newsletter'))::int AS newsletter
        FROM "EmailClassification" c
        JOIN "NormalizedEmail" n ON n.id = c."normalizedEmailId"
        WHERE c."providerUsed" = ${query.provider}
        GROUP BY lower(n."senderDomain")
      `),
      this.db.senderRule.findMany({ where: { enabled: true } }),
    ]);
    const stats: DomainClassificationStats[] = rows.map((r) => ({
      domain: r.domain,
      total: Number(r.total),
      marketing: Number(r.marketing),
      newsletter: Number(r.newsletter),
    }));
    return {
      families: suggestSenderRules(
        stats,
        { minEmails: query.minEmails, minShare: query.minShare },
        rules,
      ),
    };
  }

  /**
   * Compiled matcher over enabled rules, cached until the next write
   * through this service. Rows edited directly in the database are not
   * seen until the API restarts.
   */
  getMatcher(): Promise<SenderRuleMatcher<SenderRuleRow>> {
    if (!this.matcherCache) {
      const loading = this.db.senderRule
        .findMany({ where: { enabled: true } })
        .then((rules) => {
          const matcher = compileRules(rules);
          if (matcher.skipped.length) {
            this.logger.warn(
              `Skipping ${matcher.skipped.length} sender rule(s) whose regex ` +
                `does not compile or is unsafe: ${matcher.skipped.join(", ")}`,
            );
          }
          return matcher;
        });
      // Do not cache a failed load.
      loading.catch(() => {
        if (this.matcherCache === loading) this.matcherCache = null;
      });
      this.matcherCache = loading;
    }
    return this.matcherCache;
  }

  /**
   * Which enabled rule covers a sender, using the cached matcher (the same
   * precedence as classification). Read-only. When only `address` is
   * given, the domain is derived from it the way normalization does.
   */
  async match(
    query: SenderRuleMatchQuery,
  ): Promise<{ rule: SenderRuleRow | null; matchedOn: "address" | "domain" | null }> {
    const matcher = await this.getMatcher();
    const hit = matcher.match({
      fromAddress: query.address ?? null,
      senderDomain:
        query.domain ?? (query.address ? domainOf(query.address) : null),
    });
    return hit
      ? { rule: hit.rule, matchedOn: hit.matchedOn }
      : { rule: null, matchedOn: null };
  }

  private invalidate(): void {
    this.matcherCache = null;
  }

  private targetsAddress(request: SenderRulePreviewRequest): boolean {
    return senderPatternTarget(request.pattern, request.matchType) === "address";
  }

  private mapWriteError(
    error: unknown,
    dto: CreateSenderRule,
    id?: string,
  ): unknown {
    if (isPrismaError(error, "P2002")) {
      return new ConflictException(
        `A ${dto.matchType} rule for "${dto.pattern}" already exists`,
      );
    }
    if (id && isPrismaError(error, "P2025")) {
      return new NotFoundException(`Sender rule ${id} not found`);
    }
    this.logger.error("Sender rule write failed", error);
    return error;
  }
}
