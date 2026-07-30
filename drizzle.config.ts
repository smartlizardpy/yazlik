import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./db/schema.ts", "./db/auth-schema.ts"],
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
