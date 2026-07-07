---
name: db-schema-docs
argument-hint: "[db-alias] [table ...]"
disable-model-invocation: true
description: >-
  라이브 Oracle 스키마를 keyword-docs db-schema 문서로 생성/재생성한다:
  allow 테이블(또는 인자로 준 목록)을 describe_table로 조회 → 구조 슬롯 자동 채움 →
  의미 슬롯은 비워 스캐폴딩 → 소비 레포 .claude/docs/db/에 저장 + 인덱스 등록.
  /db-schema-docs 로만 호출된다 (모델 자동 발동 없음).
---

# db-schema-docs

agent-db-plugin MCP가 붙은 실 DB의 스키마를 읽어 **keyword-docs `db-schema` 문서**로
굳히는 절차. `describe_table`(#6)이 주는 **구조**(컬럼·타입·PK·FK·인덱스·NUM_ROWS)는
자동으로 채우고, 카탈로그에 없는 **의미**(용도·쓰기/읽기 주체·컬럼 설명·대표 쿼리·
마이그레이션 주의)는 `{{...}}` 스캐폴딩으로 남겨 사람/에이전트가 채우게 한다.

**명시적 호출 전용** — `/db-schema-docs` 로만 실행되고 모델이 스스로 발동하지 않는다
(`disable-model-invocation: true`). 파일 저장과 인덱스 수정은 **반드시 dry-run 미리보기
→ 사용자 승인 후에만** 한다.

## 산출물이 저장되는 곳 (agent-db-plugin도 claude-hooks도 아닌 "소비 레포")

- 문서: `<현재 레포>/.claude/docs/db/<테이블명 소문자>.md`
- 인덱스: `<현재 레포>/.claude/context-docs.db-schema.json` — `{keywords, path}` 배열.
  claude-hooks의 db-schema provider가 프롬프트에 DB/테이블명이 등장하면 이 문서를
  컨텍스트에 주입한다. (경로는 인덱스가 `.claude/`에 있어 레포 루트 기준으로 해석됨.)
- DB들이 거의 동일하므로 **테이블당 문서 1개**(alias 무관)를 공유한다. DB별 차이는
  문서 안에 주석으로 남긴다.

## 절차

### 1. 대상 테이블 결정

- 인자로 테이블 목록을 받았으면 그것을 쓴다.
- 아니면 `list_connections`로 alias를 고르고, 그 alias의 `tables.allow`를 대상으로
  삼는다. allow에 와일드카드(`ERP.GL_*`)가 있으면 `list_tables`로 실제 테이블로
  확장한다. allow가 없으면(= 무제한) 반드시 사용자에게 대상 목록을 물어본다 —
  스키마 전체를 무단으로 문서화하지 않는다.

### 2. 스키마 조회

각 대상 테이블에 대해:

- `describe_table(db, "SCHEMA.TABLE")` → 구조 전량.
- 테이블 용도 시드가 필요하면 `list_tables`의 해당 테이블 `comment`를 `tableComment`
  필드로 각 describe 결과에 얹는다 (describe_table은 컬럼 코멘트만 주고 테이블 코멘트는
  주지 않으므로).

조회 결과들을 **JSON 배열** 하나로 모아 임시 파일(예: 스크래치패드)에 저장한다.
각 원소는 `describe_table` 응답 그대로 + 선택적 `tableComment`.

### 3. dry-run 미리보기 → 승인

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-docs/generate.mjs \
  --describe <tables.json> --cwd <문서를 둘 레포 루트>
```

기본이 dry-run이라 디스크를 건드리지 않고 생성될 문서 전문과 요약
(`created/updated/conflict`)만 출력한다. 이를 사용자에게 보여주고 승인을 받는다.

### 4. 저장

승인되면 `--write`를 붙여 다시 실행한다. 문서와 인덱스가 기록된다.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-docs/generate.mjs \
  --describe <tables.json> --cwd <레포 루트> --write
```

### 5. 의미 슬롯 채우기 유도

생성/재생성 후, 비어 있는 `{{용도}}`·`{{쓰기→읽기}}`·컬럼 `{{설명}}`·`{{대표 쿼리}}`·
`{{마이그레이션 주의}}`를 코드/도메인 지식으로 채우도록 사용자에게 제안한다.
(대표 쿼리 자동 포집은 audit 로그 #8의 성공 SELECT top-N에서 v+ 후속으로 검토.)

## 재생성 안전 규약 (덮어쓰기 방지)

문서는 `<!-- dbdoc:auto:... -->` / `<!-- dbdoc:manual:... -->` 마커로 구역을 나눈다.

- **auto** (컬럼 구조·PK·인덱스·관계): 재생성 때마다 카탈로그에서 새로 만든다.
- **manual** (용도·컬럼 설명·대표 쿼리·마이그레이션): 사람이 채운 내용을 **원문 보존**.
  컬럼 설명은 **컬럼명 단위로 보존**되어, 타입이 바뀌어도 그 컬럼 설명은 살아남는다.
- 마커가 **없는** 기존 문서(수기 작성)는 `conflict`로 표시하고 **덮어쓰지 않는다**.

## 전제·한계

- agent-db-plugin MCP 서버가 연결돼 있어야 한다 (`describe_table`/`list_tables` 사용,
  `run_query` 아님).
- deny 테이블은 `describe_table`이 거부하므로 애초에 문서화되지 않는다 (#7).
- 구조는 카탈로그를 따르지만 의미는 사람 몫 — 이 스킬은 "뼈대 자동 + 의미 채우기 유도"
  이지 완전 자동 문서화가 아니다.

관련 코드: `render.mjs`(순수 렌더·병합, 유닛테스트 `test/db-schema-render.test.mjs`),
`generate.mjs`(파일 IO CLI). 설계: `docs/design.md` §7, keyword-docs db-schema 템플릿.
