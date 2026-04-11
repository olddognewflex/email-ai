import { Module } from "@nestjs/common";
import { ConfigModule } from "./modules/config/config.module";
import { DatabaseModule } from "./modules/database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { EmailAccountsModule } from "./modules/email-accounts/email-accounts.module";
import { EmailSyncModule } from "./modules/email-sync/email-sync.module";
import { EmailParserModule } from "./modules/email-parser/email-parser.module";
import { NormalizationModule } from "./modules/normalization/normalization.module";
import { RulesEngineModule } from "./modules/rules-engine/rules-engine.module";

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
  ],
})
export class AppModule {}
