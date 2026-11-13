import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { PostboteConfig } from '../config/env.js'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDb>

export function createDb(config: Pick<PostboteConfig, 'databaseUrl'>) {
  const sql = postgres(config.databaseUrl, {
    max: 10,
    onnotice: () => {},
  })
  return { sql, db: drizzle(sql, { schema }) }
}
