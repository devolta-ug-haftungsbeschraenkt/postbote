import { defineConfig } from 'drizzle-kit'

/** drizzle-kit generate: `npm run db:generate` (no DB connection needed). */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.POSTBOTE_DATABASE_URL ?? 'postgres://postbote:postbote@localhost:5432/postbote',
  },
})
