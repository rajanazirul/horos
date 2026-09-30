// The drizzle database handle every Postgres adapter takes: node-postgres in services and tests.
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type HorosDb = PgDatabase<PgQueryResultHKT>;
