// Catalog/schema introspection tools. Design: docs/design.md §7.
//
// list_tables / describe_table read ALL_* catalog views only (never DBA_* —
// a low-privileged account can't see those, and "what the account can see" is
// exactly the agent's visibility boundary). Every internal query is a fixed
// template — owner/table names are bind VALUES against these views, not
// assembled SQL identifiers, so there's no string-assembly injection surface
// (§7 "쿼리 작성 주체"). The one unavoidable exception is describeTable's
// existence/permission check: Oracle has no bind syntax for an identifier
// position, so that one query is built from a charset-validated, quoted
// identifier and still runs through executeReadOnly's L1-L4 (§5) like
// anything else.
//
// Both tools reuse executeReadOnly (§3.1 "단일 함수 하나를 통과") rather than
// talking to pool.mjs directly — same checkout/rollback/STRO/cleanup
// guarantees, and shapeResult's NUMBER-as-string/DATE-ISO normalization comes
// for free. maxRows is set to HARD_MAX_ROWS since these are metadata queries
// (a table has at most ~1000 columns in Oracle) — they should never be
// silently sampled the way a run_query result might be.

import { executeReadOnly as executeReadOnlyImpl } from "./readonly.mjs";
import { HARD_MAX_ROWS } from "./config.mjs";
import { isTableAllowed, filterAllowedTables } from "./tables.mjs";

const IDENTIFIER_RE = /^[A-Za-z0-9_$#]+$/;

function isValidIdentifier(s) {
  return typeof s === "string" && IDENTIFIER_RE.test(s);
}

function rowsToObjects(result) {
  const names = result.columns.map((c) => c.name);
  return result.rows.map((row) => Object.fromEntries(row.map((v, i) => [names[i], v])));
}

async function runCatalogQuery(executeReadOnly, alias, aliasConfig, sql, binds) {
  const result = await executeReadOnly({ alias, aliasConfig, sql, binds, maxRows: HARD_MAX_ROWS });
  if (!result.ok) throw new Error(result.error);
  return rowsToObjects(result);
}

/**
 * list_tables(db, schema?, name_filter?) — design §7.
 * `schema`/`nameFilter` are ordinary bind values against ALL_TABLES.OWNER /
 * TABLE_NAME, never assembled into SQL.
 */
export async function listTables(
  alias,
  aliasConfig,
  { schema, nameFilter, executeReadOnly = executeReadOnlyImpl } = {},
) {
  const conditions = [];
  const binds = {};
  if (schema) {
    conditions.push("t.owner = :schema");
    binds.schema = schema.toUpperCase();
  }
  if (nameFilter) {
    conditions.push("t.table_name LIKE :nameFilter");
    binds.nameFilter = nameFilter.toUpperCase();
  }
  const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";

  try {
    const rows = await runCatalogQuery(
      executeReadOnly,
      alias,
      aliasConfig,
      `SELECT t.owner, t.table_name, c.comments
         FROM all_tables t
         LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
        WHERE 1=1 ${where}
        ORDER BY t.owner, t.table_name`,
      binds,
    );
    const tables = filterAllowedTables(rows, aliasConfig?.tables?.allow).map((r) => ({
      owner: r.OWNER,
      table: r.TABLE_NAME,
      comment: r.COMMENTS,
    }));
    return { ok: true, tables };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parseTableParam(tableParam, defaultOwner) {
  const parts = tableParam.split(".");
  const [owner, table] = parts.length === 2 ? parts : [defaultOwner, parts[0]];
  return { owner: (owner ?? "").toUpperCase(), table: (table ?? "").toUpperCase() };
}

function formatColumnType(row) {
  if (row.DATA_PRECISION != null && row.DATA_SCALE != null) {
    return `${row.DATA_TYPE}(${row.DATA_PRECISION},${row.DATA_SCALE})`;
  }
  if (["VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "RAW"].includes(row.DATA_TYPE)) {
    return `${row.DATA_TYPE}(${row.DATA_LENGTH})`;
  }
  return row.DATA_TYPE;
}

/**
 * describe_table(db, table) — design §7. `table` may be "TABLE" (defaults to
 * the connection's own schema) or "SCHEMA.TABLE".
 */
export async function describeTable(alias, aliasConfig, tableParam, { executeReadOnly = executeReadOnlyImpl } = {}) {
  const { owner, table } = parseTableParam(tableParam, aliasConfig.user);
  if (!isValidIdentifier(owner) || !isValidIdentifier(table)) {
    return { ok: false, error: `잘못된 테이블 식별자입니다: ${tableParam}` };
  }
  if (!isTableAllowed(owner, table, aliasConfig?.tables?.allow)) {
    return { ok: false, error: `허용되지 않은 테이블입니다: ${owner}.${table}` };
  }

  // Existence/permission check. No catalog-view query can produce ORA-00942/
  // ORA-01031 by itself (an empty catalog result and a "doesn't exist" result
  // look identical), so this is the one place an identifier is assembled into
  // SQL text rather than bound — safe because it's charset-validated above,
  // quoted, and still runs through executeReadOnly's L1-L4 like any query.
  const exists = await executeReadOnly({
    alias,
    aliasConfig,
    sql: `SELECT * FROM "${owner}"."${table}" WHERE 1=0`,
    maxRows: 1,
  });
  if (!exists.ok) return { ok: false, error: exists.error }; // ORA text verbatim (§8)

  try {
    const [tableRows, columnRows, constraintRows, fkTargetRows, indexRows, indColumnRows] = await Promise.all([
      runCatalogQuery(
        executeReadOnly,
        alias,
        aliasConfig,
        `SELECT num_rows, last_analyzed FROM all_tables WHERE owner = :owner AND table_name = :tableName`,
        { owner, tableName: table },
      ),
      runCatalogQuery(
        executeReadOnly,
        alias,
        aliasConfig,
        `SELECT col.column_name, col.data_type, col.data_length, col.data_precision, col.data_scale,
                col.nullable, col.data_default, col.column_id, cc.comments
           FROM all_tab_columns col
           LEFT JOIN all_col_comments cc ON cc.owner = col.owner AND cc.table_name = col.table_name
                                        AND cc.column_name = col.column_name
          WHERE col.owner = :owner AND col.table_name = :tableName
          ORDER BY col.column_id`,
        { owner, tableName: table },
      ),
      runCatalogQuery(
        executeReadOnly,
        alias,
        aliasConfig,
        `SELECT cc.constraint_name, cc.column_name, cc.position, c.constraint_type
           FROM all_cons_columns cc
           JOIN all_constraints c ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
          WHERE cc.owner = :owner AND c.table_name = :tableName AND c.constraint_type = 'P'
          ORDER BY cc.position`,
        { owner, tableName: table },
      ),
      runCatalogQuery(
        executeReadOnly,
        alias,
        aliasConfig,
        `SELECT fkc.column_name AS fk_column, rc.table_name AS ref_table, rcc.column_name AS ref_column
           FROM all_constraints fk
           JOIN all_cons_columns fkc ON fkc.owner = fk.owner AND fkc.constraint_name = fk.constraint_name
           JOIN all_constraints rc ON rc.owner = fk.r_owner AND rc.constraint_name = fk.r_constraint_name
           JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
                                     AND rcc.position = fkc.position
          WHERE fk.owner = :owner AND fk.table_name = :tableName AND fk.constraint_type = 'R'
          ORDER BY fk.constraint_name, fkc.position`,
        { owner, tableName: table },
      ),
      runCatalogQuery(
        executeReadOnly,
        alias,
        aliasConfig,
        `SELECT index_name, uniqueness FROM all_indexes WHERE owner = :owner AND table_name = :tableName`,
        { owner, tableName: table },
      ),
      runCatalogQuery(
        executeReadOnly,
        alias,
        aliasConfig,
        `SELECT index_name, column_name, column_position
           FROM all_ind_columns WHERE index_owner = :owner AND table_name = :tableName
          ORDER BY index_name, column_position`,
        { owner, tableName: table },
      ),
    ]);

    const columns = columnRows.map((r) => ({
      name: r.COLUMN_NAME,
      type: formatColumnType(r),
      nullable: r.NULLABLE === "Y",
      default: r.DATA_DEFAULT ? r.DATA_DEFAULT.trim() : null,
      comment: r.COMMENTS,
    }));

    const primaryKey = constraintRows.map((r) => r.COLUMN_NAME);

    const foreignKeys = fkTargetRows.map((r) => ({
      column: r.FK_COLUMN,
      refTable: r.REF_TABLE,
      refColumn: r.REF_COLUMN,
    }));

    const indexColumnsByName = new Map();
    for (const r of indColumnRows) {
      const cols = indexColumnsByName.get(r.INDEX_NAME) ?? [];
      cols.push(r.COLUMN_NAME);
      indexColumnsByName.set(r.INDEX_NAME, cols);
    }
    const indexes = indexRows.map((r) => ({
      name: r.INDEX_NAME,
      unique: r.UNIQUENESS === "UNIQUE",
      columns: indexColumnsByName.get(r.INDEX_NAME) ?? [],
    }));

    const stats = tableRows[0] ?? {};

    return {
      ok: true,
      owner,
      table,
      columns,
      primaryKey,
      foreignKeys,
      indexes,
      numRows: stats.NUM_ROWS ?? null,
      lastAnalyzed: stats.LAST_ANALYZED ?? null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
