import { afterEach, expect, test } from "vitest";
import { connectPostgres } from "./connect.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

// No connection is opened: pg.Pool connects lazily.
const URL_ = "postgres://user@127.0.0.1:1/none";

test("an idle-client error on the pool is forwarded, not thrown", () => {
  const seen: Error[] = [];
  const conn = connectPostgres(URL_, 1, (e) => seen.push(e));
  closers.push(conn.close);
  const err = new Error("terminating connection due to administrator command");
  expect(() => conn.pool.emit("error", err)).not.toThrow();
  expect(seen).toEqual([err]);
});

test("with the default handler, or a throwing handler, emitting error does not throw", () => {
  const a = connectPostgres(URL_, 1);
  const b = connectPostgres(URL_, 1, () => {
    throw new Error("handler failed");
  });
  closers.push(a.close, b.close);
  expect(() => a.pool.emit("error", new Error("x"))).not.toThrow();
  expect(() => b.pool.emit("error", new Error("x"))).not.toThrow();
});

test("pingPostgres: true on a live database; false (not a rejection) on a hanging or failing one", async () => {
  const { emptyDb } = await import("./test-db.js");
  const { pingPostgres } = await import("./connect.js");
  const { client, db } = await emptyDb();
  closers.push(() => client.close());
  expect(await pingPostgres(db, 30_000)).toBe(true);

  const hanging = { transaction: () => new Promise<never>(() => {}) } as never;
  const started = Date.now();
  expect(await pingPostgres(hanging, 50)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);

  const failing = { transaction: () => Promise.reject(new Error("down")) } as never;
  expect(await pingPostgres(failing, 50)).toBe(false);
});

test("pingPostgres sets a server-side statement_timeout equal to the budget", async () => {
  const { pingPostgres } = await import("./connect.js");
  const statements: string[] = [];
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const tx = { execute: async (q: never) => void statements.push(dialect.sqlToQuery(q).sql) };
  const db = { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as never;
  expect(await pingPostgres(db, 750)).toBe(true);
  expect(statements).toEqual(["SET LOCAL statement_timeout = 750", "select 1"]);
});
