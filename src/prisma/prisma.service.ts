import {
  Inject,
  Injectable,
  INestApplication,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, PoolConfig } from "pg";
import appConfig from "../config/app.config";

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function getDatabaseSchema(databaseUrl: string): string | undefined {
  const parsed = new URL(databaseUrl);
  const schema = parsed.searchParams.get("schema");

  if (!schema) return undefined;
  if (!POSTGRES_IDENTIFIER.test(schema)) {
    throw new Error("DATABASE_URL contains an invalid PostgreSQL schema.");
  }

  return schema;
}

export function createPoolConfig(databaseUrl: string): PoolConfig {
  const schema = getDatabaseSchema(databaseUrl);

  if (!schema) return { connectionString: databaseUrl };

  return {
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is not configured.");
    }

    const schema = getDatabaseSchema(config.databaseUrl);
    const pool = new Pool(createPoolConfig(config.databaseUrl));

    super({
      adapter: new PrismaPg(pool, schema ? { schema } : undefined),
      log: ["warn", "error"],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  enableShutdownHooks(app: INestApplication) {
    process.on("beforeExit", () => {
      void app.close();
    });
  }
}
