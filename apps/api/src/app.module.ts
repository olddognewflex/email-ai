import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ClientHeaderGuard } from "./common/client-header";
import { AiProviderModule } from "./modules/ai-provider/ai-provider.module";
import { ClassificationModule } from "./modules/classification/classification.module";
import { ConfigModule } from "./modules/config/config.module";
import { DatabaseModule } from "./modules/database/database.module";
import { DigestModule } from "./modules/digest/digest.module";
import { HealthModule } from "./modules/health/health.module";
import { EmailAccountsModule } from "./modules/email-accounts/email-accounts.module";
import { EmailSyncModule } from "./modules/email-sync/email-sync.module";
import { EmailParserModule } from "./modules/email-parser/email-parser.module";
import { MailboxActionsModule } from "./modules/mailbox-actions/mailbox-actions.module";
import { NormalizationModule } from "./modules/normalization/normalization.module";
import { RulesEngineModule } from "./modules/rules-engine/rules-engine.module";
import { ReviewQueueModule } from "./modules/review-queue/review-queue.module";
import { SenderRulesModule } from "./modules/sender-rules/sender-rules.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    EmailAccountsModule,
    EmailSyncModule,
    EmailParserModule,
    NormalizationModule,
    RulesEngineModule,
    SenderRulesModule,
    MailboxActionsModule,
    ClassificationModule,
    AiProviderModule,
    ReviewQueueModule,
    DigestModule,
  ],
  // Every non-GET/HEAD/OPTIONS request needs X-Email-AI-Client (CSRF).
  providers: [{ provide: APP_GUARD, useClass: ClientHeaderGuard }],
})
export class AppModule {}
