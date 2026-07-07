import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesQualifiedName,
  isTableAllowed,
  filterAllowedTables,
  scanForDeniedTables,
} from "../src/tables.mjs";

test("matchesQualifiedName: literal schema + wildcard table", () => {
  assert.equal(matchesQualifiedName("ERP", "GL_ACCOUNTS", "ERP.GL_*"), true);
  assert.equal(matchesQualifiedName("ERP", "AP_INVOICES", "ERP.GL_*"), false);
  assert.equal(matchesQualifiedName("HR", "GL_ACCOUNTS", "ERP.GL_*"), false);
});

test("matchesQualifiedName: wildcard schema + wildcard table", () => {
  assert.equal(matchesQualifiedName("ERP", "PII_SSN", "*.PII_*"), true);
  assert.equal(matchesQualifiedName("HR", "PII_ADDRESS", "*.PII_*"), true);
  assert.equal(matchesQualifiedName("HR", "SALARY", "*.PII_*"), false);
});

test("matchesQualifiedName: literal exact match", () => {
  assert.equal(matchesQualifiedName("ERP", "HR_SALARY", "ERP.HR_SALARY"), true);
  assert.equal(matchesQualifiedName("ERP", "HR_SALARY_HISTORY", "ERP.HR_SALARY"), false);
});

test("matchesQualifiedName: case-insensitive on both halves", () => {
  assert.equal(matchesQualifiedName("erp", "gl_accounts", "ERP.GL_*"), true);
});

test("matchesQualifiedName: pattern without a dot treats the schema half as unrestricted", () => {
  assert.equal(matchesQualifiedName("ANY_SCHEMA", "GL_ACCOUNTS", "GL_*"), true);
});

test("isTableAllowed: no allow list configured -> unrestricted", () => {
  assert.equal(isTableAllowed("ERP", "ANYTHING", undefined), true);
  assert.equal(isTableAllowed("ERP", "ANYTHING", []), true);
});

test("isTableAllowed: matches if any pattern in the list matches", () => {
  const allow = ["ERP.GL_*", "ERP.AP_*"];
  assert.equal(isTableAllowed("ERP", "GL_ACCOUNTS", allow), true);
  assert.equal(isTableAllowed("ERP", "AP_INVOICES", allow), true);
  assert.equal(isTableAllowed("ERP", "HR_SALARY", allow), false);
});

test("filterAllowedTables: passes rows through unfiltered when no allow list is set", () => {
  const rows = [{ OWNER: "ERP", TABLE_NAME: "HR_SALARY" }];
  assert.deepEqual(filterAllowedTables(rows, undefined), rows);
});

test("filterAllowedTables: drops rows outside the allow patterns, keeps matches", () => {
  const rows = [
    { OWNER: "ERP", TABLE_NAME: "GL_ACCOUNTS" },
    { OWNER: "ERP", TABLE_NAME: "HR_SALARY" },
    { OWNER: "ERP", TABLE_NAME: "AP_INVOICES" },
  ];
  const result = filterAllowedTables(rows, ["ERP.GL_*", "ERP.AP_*"]);
  assert.deepEqual(result, [
    { OWNER: "ERP", TABLE_NAME: "GL_ACCOUNTS" },
    { OWNER: "ERP", TABLE_NAME: "AP_INVOICES" },
  ]);
});

test("scanForDeniedTables: no deny list configured -> always ok", () => {
  assert.deepEqual(scanForDeniedTables("SELECT * FROM HR_SALARY", undefined), { ok: true });
  assert.deepEqual(scanForDeniedTables("SELECT * FROM HR_SALARY", []), { ok: true });
});

test("scanForDeniedTables: blocks a query that references a denied table by name", () => {
  const result = scanForDeniedTables("SELECT * FROM ERP.HR_SALARY", ["ERP.HR_SALARY"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /HR_SALARY/);
});

test("scanForDeniedTables: unqualified reference to the denied table name is still caught", () => {
  const result = scanForDeniedTables("SELECT * FROM HR_SALARY", ["ERP.HR_SALARY"]);
  assert.equal(result.ok, false);
});

test("scanForDeniedTables: wildcard deny pattern catches any matching table name", () => {
  const result = scanForDeniedTables("SELECT ssn FROM PII_CUSTOMER", ["*.PII_*"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /PII_CUSTOMER/);
});

test("scanForDeniedTables: case-insensitive and tolerant of quoted identifiers", () => {
  assert.equal(scanForDeniedTables("select * from hr_salary", ["ERP.HR_SALARY"]).ok, false);
  assert.equal(scanForDeniedTables('SELECT * FROM "HR_SALARY"', ["ERP.HR_SALARY"]).ok, false);
});

test("scanForDeniedTables: does not match a name that merely contains the denied token as a substring", () => {
  // HR_SALARY_HISTORY is a different table; a whole-identifier match must not
  // flag it just because it starts with "HR_SALARY".
  const result = scanForDeniedTables("SELECT * FROM HR_SALARY_HISTORY", ["ERP.HR_SALARY"]);
  assert.equal(result.ok, true);
});

test("scanForDeniedTables: a table name embedded in a larger identifier is not falsely flagged", () => {
  const result = scanForDeniedTables("SELECT * FROM MY_HR_SALARY_BACKUP", ["ERP.HR_SALARY"]);
  assert.equal(result.ok, true);
});

test("scanForDeniedTables: allows an unrelated query untouched", () => {
  const result = scanForDeniedTables("SELECT * FROM GL_ACCOUNTS", ["ERP.HR_SALARY", "*.PII_*"]);
  assert.equal(result.ok, true);
});

test("scanForDeniedTables: documented bypass — a synonym/view wrapping the real table passes the scan", () => {
  // §5/§12-4 accepted limitation: this is not a bug, it's the documented gap
  // between "준강제" name-scanning and true row-level access control.
  const result = scanForDeniedTables("SELECT * FROM emp_pay_synonym", ["ERP.HR_SALARY"]);
  assert.equal(result.ok, true);
});
