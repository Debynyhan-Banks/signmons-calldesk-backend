import "dotenv/config";
import { defineConfig } from "prisma/config";

// Client generation does not connect to the database, but Prisma 7 still
// requires a syntactically valid datasource URL while loading this config.
// Runtime and production migration commands remain fail-closed in app config.
const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://local:local@127.0.0.1:5432/signmons?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
