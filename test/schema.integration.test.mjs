import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { listTables, describeTable } from "../src/schema.mjs";
import { closeAllPools } from "../src/pool.mjs";

// Real-DB integration test (design §9/§7 done-when, issue #6): a seeded schema
// with a PK, an FK, and two indexes comes back with exact columns/PK/FK/index/
// NUM_ROWS data through the real listTables/describeTable → executeReadOnly
// path. Runs against the local `oracle-mcp-test` Docker container when
// reachable; otherwise every case is skipped so `npm test` stays DB-independent
// (Docker/CI wiring is issue #9).

const TEST_CONNECT_STRING = process.env.ORACLE_TEST_CONNECT_STRING ?? "localhost:1521/FREEPDB1";
const TEST_USER = process.env.ORACLE_TEST_USER ?? "testuser";
const TEST_PASSWORD = process.env.ORACLE_TEST_PASSWORD ?? "testpw";
const PASSWORD_ENV = "TEST_ORA_PW_SCHEMA_INTEGRATION";
const ALIAS = "schema-it";

const aliasConfig = {
  connectString: TEST_CONNECT_STRING,
  user: TEST_USER,
  passwordEnv: PASSWORD_ENV,
  limits: { callTimeout: 30, poolMax: 4, defaultMaxRows: 100 },
};

async function isDbReachable() {
  try {
    const conn = await oracledb.getConnection({
      connectString: TEST_CONNECT_STRING,
      user: TEST_USER,
      password: TEST_PASSWORD,
    });
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

const dbReachable = await isDbReachable();
const skip = !dbReachable && "oracle-mcp-test DB 미도달 — Docker 통합환경에서만 실행";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same documented ORA-01466 edge case as the other integration suites (design
// §11) — apply the same retry-once mitigation.
async function retrying01466(fn) {
  const result = await fn();
  if (!result.ok && /ORA-01466/.test(result.error)) {
    await delay(2000);
    return fn();
  }
  return result;
}

before(async () => {
  if (!dbReachable) return;
  process.env[PASSWORD_ENV] = TEST_PASSWORD;
  const setup = await oracledb.getConnection({
    connectString: TEST_CONNECT_STRING,
    user: TEST_USER,
    password: TEST_PASSWORD,
  });
  try {
    await setup.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE sc_item'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
    await setup.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE sc_order'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
    await setup.execute(`
      CREATE TABLE sc_order (
        id NUMBER PRIMARY KEY,
        status VARCHAR2(20) DEFAULT 'NEW' NOT NULL,
        note VARCHAR2(200)
      )
    `);
    await setup.execute(`COMMENT ON TABLE sc_order IS '주문 테이블'`);
    await setup.execute(`COMMENT ON COLUMN sc_order.status IS '주문 상태'`);
    await setup.execute(`
      CREATE TABLE sc_item (
        id NUMBER,
        order_id NUMBER NOT NULL,
        qty NUMBER,
        CONSTRAINT sc_item_pk PRIMARY KEY (id),
        CONSTRAINT sc_item_fk FOREIGN KEY (order_id) REFERENCES sc_order(id)
      )
    `);
    await setup.execute(`CREATE INDEX sc_item_order_idx ON sc_item (order_id, qty)`);
    await setup.execute(`INSERT INTO sc_order VALUES (1, 'NEW', 'x')`);
    await setup.execute(`INSERT INTO sc_item VALUES (1, 1, 5)`);
    await setup.execute(`COMMIT`);
    await setup.execute(`BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, 'SC_ITEM'); END;`);
  } finally {
    await setup.close();
  }
  await delay(1100); // best-effort ORA-01466 settle window — retrying01466 covers the rest
});

after(async () => {
  if (!dbReachable) return;
  delete process.env[PASSWORD_ENV];
  await closeAllPools();
});

test("listTables: finds the seeded tables with comments, filtered by name_filter", { skip }, async () => {
  const result = await retrying01466(() =>
    listTables(ALIAS, aliasConfig, { schema: TEST_USER, nameFilter: "SC_%" }),
  );
  assert.equal(result.ok, true);
  const byName = Object.fromEntries(result.tables.map((t) => [t.table, t]));
  assert.equal(byName.SC_ORDER.comment, "주문 테이블");
  assert.equal(byName.SC_ITEM.comment, null);
});

test("describeTable: columns, nullability, default, and comment come back exactly (unqualified name, own schema)", { skip }, async () => {
  const result = await retrying01466(() => describeTable(ALIAS, aliasConfig, "sc_order"));
  assert.equal(result.ok, true);
  assert.equal(result.owner, TEST_USER.toUpperCase());
  const byName = Object.fromEntries(result.columns.map((c) => [c.name, c]));
  assert.equal(byName.ID.nullable, false);
  assert.match(byName.ID.type, /^NUMBER/);
  assert.equal(byName.STATUS.nullable, false);
  assert.equal(byName.STATUS.default, "'NEW'");
  assert.equal(byName.STATUS.comment, "주문 상태");
  assert.equal(byName.NOTE.nullable, true);
});

test("describeTable: primary key, foreign key, and indexes (with column order + uniqueness) are correct", { skip }, async () => {
  const result = await retrying01466(() => describeTable(ALIAS, aliasConfig, "sc_item"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.primaryKey, ["ID"]);
  assert.deepEqual(result.foreignKeys, [{ column: "ORDER_ID", refTable: "SC_ORDER", refColumn: "ID" }]);

  const byName = Object.fromEntries(result.indexes.map((i) => [i.name, i]));
  assert.equal(byName.SC_ITEM_PK.unique, true);
  assert.deepEqual(byName.SC_ITEM_PK.columns, ["ID"]);
  assert.equal(byName.SC_ITEM_ORDER_IDX.unique, false);
  assert.deepEqual(byName.SC_ITEM_ORDER_IDX.columns, ["ORDER_ID", "QTY"]); // column order preserved

  assert.equal(result.numRows, "1");
  assert.match(result.lastAnalyzed, /^\d{4}-\d{2}-\d{2}T/);
});

test("describeTable: a nonexistent table returns the ORA error verbatim (§8)", { skip }, async () => {
  const result = await retrying01466(() => describeTable(ALIAS, aliasConfig, "sc_does_not_exist"));
  assert.equal(result.ok, false);
  assert.match(result.error, /ORA-00942/);
});

test("describeTable: schema-qualified table param works the same as unqualified", { skip }, async () => {
  const result = await retrying01466(() =>
    describeTable(ALIAS, aliasConfig, `${TEST_USER.toUpperCase()}.SC_ORDER`),
  );
  assert.equal(result.ok, true);
  assert.equal(result.table, "SC_ORDER");
});

test("listTables: allow patterns hide tables outside the catalog surface, end-to-end against real ALL_TABLES (design §5 수준1, issue #7)", { skip }, async () => {
  const restrictedConfig = { ...aliasConfig, tables: { allow: [`${TEST_USER.toUpperCase()}.SC_ORDER`] } };
  const result = await retrying01466(() =>
    listTables(ALIAS, restrictedConfig, { schema: TEST_USER, nameFilter: "SC_%" }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.tables.map((t) => t.table),
    ["SC_ORDER"],
  );
});

test("describeTable: a table outside the allow patterns is rejected without ever reaching the DB (design §5 수준1, issue #7)", { skip }, async () => {
  const restrictedConfig = { ...aliasConfig, tables: { allow: [`${TEST_USER.toUpperCase()}.SC_ORDER`] } };
  const result = await describeTable(ALIAS, restrictedConfig, "sc_item");
  assert.equal(result.ok, false);
  assert.match(result.error, /허용되지 않은 테이블/);
});
