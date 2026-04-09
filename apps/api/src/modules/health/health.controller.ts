import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

interface HealthResponse {
  status: 'ok' | 'error';
  db: 'ok' | 'error';
  timestamp: string;
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    let dbStatus: 'ok' | 'error' = 'ok';
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }
    return {
      status: dbStatus,
      db: dbStatus,
      timestamp: new Date().toISOString(),
    };
  }
}
