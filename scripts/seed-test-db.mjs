// Standalone seed script for manual exploration against a local
// `oracle-mcp-test` container (design §9 "Docker 시드 스크립트"). NOT a test
// dependency — every test/*.integration.test.mjs file seeds its own narrow
// fixtures inline and stays self-contained (design §9's "임시 스크립트를
// test/integration/로 정식화" is already satisfied by that per-suite pattern).
// This script exists so a developer can spin up the container and poke at
// list_tables/describe_table/run_query by hand without reading five test
// files first — one broad fixture set covering every column-type/structural
// case those suites verify individually: a LOB column, an index, a synonym,
// and an autonomous-transaction function (the one write-from-SELECT edge
// case documented in design §5 "잔여 리스크").
//
// Usage: ORACLE_TEST_PASSWORD=testpw node scripts/seed-test-db.mjs
// (defaults match the container started per README/design §11)

import oracledb from "oracledb";

const CONNECT_STRING = process.env.ORACLE_TEST_CONNECT_STRING ?? "localhost:1521/FREEPDB1";
const USER = process.env.ORACLE_TEST_USER ?? "testuser";
const PASSWORD = process.env.ORACLE_TEST_PASSWORD ?? "testpw";

async function dropIfExists(conn, kind, name) {
  await conn.execute(
    `BEGIN EXECUTE IMMEDIATE 'DROP ${kind} ${name}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
  );
}

async function main() {
  const conn = await oracledb.getConnection({ connectString: CONNECT_STRING, user: USER, password: PASSWORD });
  try {
    await dropIfExists(conn, "SYNONYM", "t_seed_syn");
    await dropIfExists(conn, "TABLE", "t_seed");
    await dropIfExists(conn, "FUNCTION", "t_seed_autonomous_write");

    await conn.execute(`
      CREATE TABLE t_seed (
        id NUMBER PRIMARY KEY,
        name VARCHAR2(100) NOT NULL,
        notes CLOB,
        big_number NUMBER
      )
    `);
    await conn.execute(`COMMENT ON TABLE t_seed IS '수동 탐색용 시드 테이블 (scripts/seed-test-db.mjs)'`);
    await conn.execute(`CREATE INDEX t_seed_name_idx ON t_seed (name)`);
    await conn.execute(`CREATE SYNONYM t_seed_syn FOR t_seed`); // §12-4 우회 시나리오 재현용

    await conn.execute(
      `INSERT INTO t_seed (id, name, notes, big_number) VALUES (1, 'alpha', 'a short note', 42)`,
    );
    await conn.execute(
      `INSERT INTO t_seed (id, name, notes, big_number) VALUES (2, 'beta', RPAD('x', 5000, 'x'), 90071992547409929)`,
    ); // large CLOB (§12-2) + a NUMBER past 2^53 (§12-1)
    await conn.execute(`COMMIT`);
    await conn.execute(`BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, 'T_SEED'); END;`);

    // design §5 "잔여 리스크": a pre-existing autonomous-transaction function
    // can write even when called from a read-only SELECT — L1-L4 can't catch
    // this by construction. Kept here as a live fixture to poke at, not as an
    // automated test assertion (there's nothing to assert against; it's a
    // documented, accepted gap).
    await conn.execute(`
      CREATE OR REPLACE FUNCTION t_seed_autonomous_write RETURN NUMBER IS
        PRAGMA AUTONOMOUS_TRANSACTION;
      BEGIN
        UPDATE t_seed SET big_number = big_number + 1 WHERE id = 1;
        COMMIT;
        RETURN 1;
      END;
    `);

    console.log("[seed-test-db] OK — t_seed (+ index, synonym, autonomous-write function) ready");
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error("[seed-test-db] FAILED:", err.message);
  process.exit(1);
});
