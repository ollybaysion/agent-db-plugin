import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReadOnlyStatement } from "../src/readonly.mjs";

const ok = (sql) => assert.equal(validateReadOnlyStatement(sql).ok, true, sql);
const no = (sql) => assert.equal(validateReadOnlyStatement(sql).ok, false, sql);

test("allows SELECT / WITH", () => {
  ok("SELECT * FROM dual");
  ok("  select 1 from dual");
  ok("WITH t AS (SELECT 1 FROM dual) SELECT * FROM t");
  ok("/* hi */ SELECT 1 FROM dual");
  ok("-- lead\nSELECT 1 FROM dual");
  ok("(SELECT 1 FROM dual)");
});

test("rejects DML / DDL / PLSQL / LOCK", () => {
  no("INSERT INTO t VALUES (1)");
  no("UPDATE t SET x=1");
  no("DELETE FROM t");
  no("MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.x=1");
  no("DROP TABLE t");
  no("CREATE TABLE t (x NUMBER)");
  no("TRUNCATE TABLE t");
  no("ALTER SESSION SET x=y");
  no("GRANT SELECT ON t TO u");
  no("LOCK TABLE t IN EXCLUSIVE MODE"); // §12-5: only L2 catches this
  no("BEGIN NULL; END;");
  no("DECLARE x NUMBER; BEGIN NULL; END;");
  no("CALL proc()");
});

test("rejects WITH FUNCTION / PROCEDURE (autonomous-txn write path, §11-3)", () => {
  no("WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual");
  no("with   procedure p is begin null; end; select 1 from dual");
});

test("rejects empty / non-string", () => {
  no("");
  no("   ");
  no(undefined);
});
