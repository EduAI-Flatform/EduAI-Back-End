import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("GDS platform policy migration", () => {
  let db: PGlite;
  const actor = "10000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("CREATE TABLE users (id UUID PRIMARY KEY)");
    await db.query("INSERT INTO users(id) VALUES ($1)", [actor]);
    await db.exec(
      readFileSync(
        join(
          __dirname,
          "migrations/20261111090000_platform_policy_revisions/migration.sql",
        ),
        "utf8",
      ),
    );
  }, 60000);
  afterAll(async () => db.close());
  it("stores drafts and enforces revision uniqueness", async () => {
    const sql =
      "INSERT INTO platform_policy_revisions (\"group\", version, content, created_by_id) VALUES ('branding', 1, '{}', $1)";
    await db.query(sql, [actor]);
    await expect(db.query(sql, [actor])).rejects.toThrow();
  });
  it("rejects an approval with no approver and a schedule with no effective time", async () => {
    await expect(
      db.query(
        "INSERT INTO platform_policy_revisions (\"group\", version, content, created_by_id, status) VALUES ('branding', 2, '{}', $1, 'approved')",
        [actor],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO platform_policy_revisions (\"group\", version, content, created_by_id, status, approved_by_id, approved_at) VALUES ('branding', 3, '{}', $1, 'scheduled', $1, CURRENT_TIMESTAMP)",
        [actor],
      ),
    ).rejects.toThrow();
  });
  it("retains administrators referenced by policy history", async () => {
    await expect(
      db.query("DELETE FROM users WHERE id = $1", [actor]),
    ).rejects.toThrow();
  });
});
