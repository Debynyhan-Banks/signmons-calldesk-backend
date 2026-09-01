import { createPoolConfig, getDatabaseSchema } from "./prisma.service";

describe("createPoolConfig", () => {
  it("maps Prisma's schema query parameter to the PostgreSQL search path", () => {
    expect(
      getDatabaseSchema(
        "postgresql://calldesk:secret@localhost:5432/calldesk?schema=calldesk_test",
      ),
    ).toBe("calldesk_test");
    expect(
      createPoolConfig(
        "postgresql://calldesk:secret@localhost:5432/calldesk?schema=calldesk_test",
      ),
    ).toEqual({
      connectionString:
        "postgresql://calldesk:secret@localhost:5432/calldesk?schema=calldesk_test",
      options: "-c search_path=calldesk_test",
    });
  });

  it("preserves URLs without an explicit schema", () => {
    expect(
      createPoolConfig("postgresql://calldesk:secret@localhost:5432/calldesk"),
    ).toEqual({
      connectionString:
        "postgresql://calldesk:secret@localhost:5432/calldesk",
    });
  });

  it("rejects unsafe schema names", () => {
    expect(() =>
      createPoolConfig(
        "postgresql://calldesk:secret@localhost:5432/calldesk?schema=public%20-c%20role%3Dadmin",
      ),
    ).toThrow("DATABASE_URL contains an invalid PostgreSQL schema.");
  });
});
