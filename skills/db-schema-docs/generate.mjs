// db-schema-docs generator CLI (the side-effecting wrapper around render.mjs).
//
// Input: a JSON file holding one describe_table result, or an array of them
// (optionally each with an extra `tableComment` seeded from list_tables). It
// renders/regenerates each table's doc under <cwd>/.claude/docs/db/ and upserts
// <cwd>/.claude/context-docs.db-schema.json.
//
// DEFAULT IS DRY-RUN: it prints the rendered docs and does not touch disk. Pass
// --write to actually write — the skill shows the dry-run for approval first.
//
// Usage:
//   node generate.mjs --describe tables.json [--cwd DIR] [--index PATH] [--write]
//
// Exit: 0 ok, 1 fatal, 2 one or more tables skipped as a conflict (a
// pre-existing hand-authored doc without our markers — never overwritten).

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";

import { renderDoc, upsertIndexEntry, docRelPath, WIDE_TABLE_COLUMNS } from "./render.mjs";

function parseArgs(argv) {
  const args = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--describe") args.describe = argv[++i];
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--index") args.index = argv[++i];
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!args.describe) throw new Error("--describe <json> 가 필요합니다");
  return args;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd ?? process.cwd();
  const indexPath = args.index ?? join(cwd, ".claude", "context-docs.db-schema.json");

  const raw = await readJson(args.describe);
  const tables = Array.isArray(raw) ? raw : [raw];

  let index = (await exists(indexPath)) ? await readJson(indexPath) : [];
  if (!Array.isArray(index)) index = [];

  const summary = { created: [], updated: [], conflict: [] };

  for (const desc of tables) {
    if (!desc?.owner || !desc?.table) {
      console.error("skip: owner/table 없는 항목");
      continue;
    }
    const docAbs = join(cwd, docRelPath(desc.table));
    const existing = (await exists(docAbs)) ? await readFile(docAbs, "utf8") : null;
    const res = renderDoc(desc, { tableComment: desc.tableComment ?? null, existing });

    if (res.status === "conflict") {
      summary.conflict.push(desc.table);
      console.error(res.reason);
      continue;
    }

    const precision = (desc.columns?.length ?? 0) > WIDE_TABLE_COLUMNS ? 0.5 : undefined;
    index = upsertIndexEntry(index, desc, { precision });
    summary[res.status].push(desc.table);

    if (args.write) {
      await mkdir(dirname(docAbs), { recursive: true });
      await writeFile(docAbs, res.markdown);
    } else {
      console.log(`\n===== ${docRelPath(desc.table)} (${res.status}) =====`);
      console.log(res.markdown);
    }
  }

  if (args.write) {
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
  }

  const tag = args.write ? "WROTE" : "DRY-RUN";
  console.error(
    `[${tag}] created=${summary.created.length} updated=${summary.updated.length} ` +
      `conflict=${summary.conflict.length} index=${indexPath}`,
  );
  if (summary.conflict.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
