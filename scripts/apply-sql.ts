/**
 * Applies every .sql file in db/sql in lexical order.
 * Each file must be idempotent — this runs on every push, not once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const dir = join(process.cwd(), "db", "sql");
  const sql = postgres(url, { prepare: false });

  try {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      process.stdout.write(`applying ${file} ... `);
      await sql.unsafe(readFileSync(join(dir, file), "utf8"));
      console.log("ok");
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
