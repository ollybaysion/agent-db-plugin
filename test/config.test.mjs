import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadConfig,
  resolvePassword,
  passwordEnvStatus,
  HARD_MAX_ROWS,
} from "../src/config.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const VALID = join(FIXTURES, "connections-valid.json");
const MISSING_FIELD = join(FIXTURES, "connections-missing-field.json");
const MISSING_FILE = join(FIXTURES, "does-not-exist.json");
const GLOBAL_TABLES = join(FIXTURES, "connections-global-tables.json");

test("normal: parses aliases, merges limits, reports password env status", async () => {
  delete process.env.TEST_ORA_PW_ERP_PROD;
  process.env.TEST_ORA_PW_MES_DEV = "hunter2";

  const { connections, errors } = await loadConfig(VALID);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(connections).sort(), ["erp-prod", "mes-dev"]);

  const erp = connections["erp-prod"];
  assert.equal(erp.connectString, "erp-db.corp:1521/ERPPDB");
  assert.equal(erp.passwordStatus, "unset");
  assert.deepEqual(erp.tables, { allow: ["ERP.GL_*"], deny: ["ERP.HR_SALARY"] });
  // connection-level callTimeout(10) survives merge with global defaultMaxRows(100)
  assert.equal(erp.limits.callTimeout, 10);
  assert.equal(erp.limits.defaultMaxRows, 100);
  assert.equal(erp.limits.poolMax, 2);

  const mes = connections["mes-dev"];
  assert.equal(mes.passwordStatus, "set");
  // per-connection override wins over global default
  assert.equal(mes.limits.defaultMaxRows, 200);
  // falls back to built-in default since neither global nor connection set it
  assert.equal(mes.limits.callTimeout, 30);

  delete process.env.TEST_ORA_PW_MES_DEV;
});

test("global tables: an alias with no tables inherits the top-level allow+deny", async () => {
  const { connections, errors } = await loadConfig(GLOBAL_TABLES);
  assert.deepEqual(errors, []);
  assert.deepEqual(connections["inherits-all"].tables, {
    allow: ["ERP.GL_*", "ERP.AP_*"],
    deny: ["*.PII_*"],
  });
});

test("global tables: an alias overriding only allow keeps the global deny (per-key merge)", async () => {
  const { connections } = await loadConfig(GLOBAL_TABLES);
  assert.deepEqual(connections["overrides-allow-only"].tables, {
    allow: ["MES.*"], // replaced whole
    deny: ["*.PII_*"], // inherited from global — a per-alias allow tweak must not drop the deny guard
  });
});

test("global tables: an alias overriding both keys ignores the global lists entirely", async () => {
  const { connections } = await loadConfig(GLOBAL_TABLES);
  assert.deepEqual(connections["overrides-both"].tables, {
    allow: ["FIN.*"],
    deny: ["FIN.SECRET"],
  });
});

test("global tables: a per-alias tables object still wins over global (existing valid fixture)", async () => {
  // connections-valid.json has NO top-level tables and erp-prod defines its own —
  // resolveTables(undefined, connTables) must return the alias's own spec unchanged.
  const { connections } = await loadConfig(VALID);
  assert.deepEqual(connections["erp-prod"].tables, { allow: ["ERP.GL_*"], deny: ["ERP.HR_SALARY"] });
  // mes-dev sets no tables and there's no global → undefined (unrestricted).
  assert.equal(connections["mes-dev"].tables, undefined);
});

test("global tables: a malformed top-level tables is a collected error, aliases still load", async () => {
  const raw = JSON.stringify({
    connections: {
      "ok-db": { connectString: "x:1521/X", user: "U", passwordEnv: "TEST_ORA_PW_OK" },
    },
    tables: { allow: "not-an-array" },
  });
  const tmp = join(FIXTURES, "connections-bad-global-tables.json");
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, raw);
  try {
    const { connections, errors } = await loadConfig(tmp);
    assert.deepEqual(Object.keys(connections), ["ok-db"]);
    assert.equal(connections["ok-db"].tables, undefined); // malformed global dropped, not inherited
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith("최상위 tables:"));
  } finally {
    await unlink(tmp);
  }
});

test("missing field: bad aliases are dropped (fail-soft), good ones still load", async () => {
  const { connections, errors } = await loadConfig(MISSING_FIELD);
  assert.deepEqual(Object.keys(connections), ["good-db"]);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.startsWith("no-user:")));
  assert.ok(errors.some((e) => e.startsWith("not-an-object:")));
  assert.ok(errors.some((e) => e.startsWith("bad-tables:")));
});

test("no file: returns empty config plus a write-this-file hint, not an error", async () => {
  const { connections, errors, hint } = await loadConfig(MISSING_FILE);
  assert.deepEqual(connections, {});
  assert.deepEqual(errors, []);
  assert.match(hint, /connections\.json/);
});

test("password env unset: clear status and a resolvePassword error that never echoes back the var value", async () => {
  delete process.env.TEST_ORA_PW_ERP_PROD;
  const { connections } = await loadConfig(VALID);
  const erp = connections["erp-prod"];
  assert.equal(erp.passwordStatus, "unset");
  assert.throws(() => resolvePassword(erp), /TEST_ORA_PW_ERP_PROD/);
});

test("resolvePassword returns the env value when set", () => {
  process.env.TEST_ORA_PW_SOMETHING = "s3cret";
  assert.equal(
    resolvePassword({ passwordEnv: "TEST_ORA_PW_SOMETHING" }),
    "s3cret",
  );
  delete process.env.TEST_ORA_PW_SOMETHING;
});

test("passwordEnvStatus reflects env presence without revealing the value", () => {
  delete process.env.TEST_ORA_PW_X;
  assert.equal(passwordEnvStatus("TEST_ORA_PW_X"), "unset");
  process.env.TEST_ORA_PW_X = "v";
  assert.equal(passwordEnvStatus("TEST_ORA_PW_X"), "set");
  delete process.env.TEST_ORA_PW_X;
});

test("hard row cap cannot be raised via config", async () => {
  const raw = JSON.stringify({
    connections: {
      "over-cap": {
        connectString: "x:1521/X",
        user: "U",
        passwordEnv: "TEST_ORA_PW_OVER_CAP",
        limits: { defaultMaxRows: HARD_MAX_ROWS * 10 },
      },
    },
  });
  const tmp = join(FIXTURES, "connections-over-cap.json");
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, raw);
  try {
    const { connections } = await loadConfig(tmp);
    assert.equal(connections["over-cap"].limits.defaultMaxRows, HARD_MAX_ROWS);
  } finally {
    await unlink(tmp);
  }
});

test("malformed JSON is a collected error, not a thrown exception", async () => {
  const tmp = join(FIXTURES, "connections-malformed.json");
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, "{ not json");
  try {
    const { connections, errors } = await loadConfig(tmp);
    assert.deepEqual(connections, {});
    assert.equal(errors.length, 1);
  } finally {
    await unlink(tmp);
  }
});
