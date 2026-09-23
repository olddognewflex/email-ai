import { Provider } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ClientHeaderGuard } from "./common/client-header";

/**
 * App-wide providers, kept out of app.module.ts so specs can assert on
 * them without importing AppModule (whose ConfigModule validates the
 * environment at import time and throws where no .env exists, e.g. CI).
 */
export const appProviders: Provider[] = [
  // X-Email-AI-Client is required on every non-GET request.
  { provide: APP_GUARD, useClass: ClientHeaderGuard },
];
