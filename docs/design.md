# agent-db-plugin 설계

> Oracle 19c 조회 전용 MCP 서버 플러그인. 2026-07-07 시작.
> 상태: **§10 결정 완료 + §11 라이브 검증 + §12 적대적 검증 완료 (2026-07-07)**.
> 적대 검증에서 나온 결함(NUMBER 정밀도·LOB 캡·STRO 청산·allow 과장)은 반영 완료.

## 1. 목적과 비목적

### 목적

- Claude Code(및 MCP 클라이언트)가 사내 Oracle 19c DB를 **조회**할 수 있게 한다.
- 여러 DB × 여러 계정을 alias 하나로 골라 쓴다.
- 어떤 경로로도 쓰기(DML/DDL)가 실행되지 않도록 서버 레이어에서 강제한다.
- 대용량 결과가 에이전트 컨텍스트를 폭파시키지 않도록 출력을 다층 캡으로 제한한다.

### 비목적 (v1에서 안 함)

- 쓰기 지원. 옵션으로도 두지 않는다 — 끌 수 있는 스위치는 언젠가 꺼진다.
- 스키마 문서 생성 자동화 (keyword-docs 연계) — v2 후보. [§10-4]
- Kerberos/wallet 인증 — 비밀번호 인증 확정이므로 범위 밖.
- 쿼리 히스토리/캐싱.

## 2. 확정된 결정

| 결정 | 선택 | 근거 |
| --- | --- | --- |
| 이름 | **`agent-db-plugin`** (저장소·플러그인 동일 이름) | Oracle 특정이 아닌 이름 — v1은 Oracle 19c만 지원하되 추후 타 DB 확장 여지를 열어둠 |
| 언어 | Node.js (ESM) + `node-oracledb` 6.x **thin mode** | Instant Client 불필요(순수 JS, 19c는 thin 지원 범위 12.1+), MCP TypeScript SDK가 레퍼런스 구현, 기존 플러그인 스택(.mjs)과 동일 |
| 저장소 | **독립 저장소** (claude-hooks에 넣지 않음) | claude-hooks의 모듈 계약은 hook 전용(core/ + hooks.json). MCP는 `.mcp.json`으로 로드되는 다른 컴포넌트. 플러그인 번들 MCP는 플러그인 켜진 모든 프로젝트에 전파됨. 릴리즈 주기·크리덴셜 수명주기도 다름 |
| 배포 형태 | **독립 플러그인** (저장소 자체가 플러그인, 자체 marketplace 등록) | 기존 플러그인들과 배포 흐름 통일(version bump → marketplace update → reload). 다중 프로젝트에서 enable만으로 사용, 사용자 추가는 마켓플레이스 안내로 끝. 사내 질의 요령을 스킬로 동봉할 수 있음 — `.mcp.json` 수동 등록엔 없는 옵션 |
| 인증 | 비밀번호 (env 변수 참조) | 사내 환경 확정. thin mode로 충분 |
| read-only 강제 지점 | **MCP 서버 레이어** | DB 여러 개 + 계정 다수 → SELECT-only 계정을 보장할 수 없음. 계정 권한은 통제 밖 |

## 3. 아키텍처 개요

```text
Claude Code ──stdio──> agent-db-plugin MCP 서버 (Node 프로세스)
                          │  connections.json (alias → 접속정보)
                          │  비밀번호: env 변수에서만
                          ├─ pool[erp-prod] ──TCP──> Oracle #1
                          └─ pool[mes-dev]  ──TCP──> Oracle #2
```

- 세션당 프로세스 하나 (stdio). 상태 없음 — 설정 파일과 env만 읽는다.
- **플러그인 패키징**: 저장소 루트에 `.claude-plugin/plugin.json` + `.mcp.json`
  (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"]`).
  플러그인 설치는 git 복사라 `node_modules`가 없다 → **esbuild 단일 파일 번들**
  (collector에서 검증한 패턴). thin mode는 순수 JS라 번들 가능하나 thick 모드용
  동적 require가 번들에서 문제될 수 있음 — 검증 항목 (§9-6). thick 미지원은 명시적 제약.
- 설정·상태는 `${CLAUDE_PLUGIN_ROOT}` 아래 절대 두지 않는다 (플러그인 업데이트마다
  경로가 바뀜) — `~/.oracle-mcp/`에만 (§4).

### 3.1 커넥션 풀 상세

풀을 두는 이유: Oracle 접속 수립(TCP + 인증 핸드셰이크 + 서버 세션 생성)은 사내망에서
쿼리당 수십~수백 ms — tool 호출마다 새로 접속하면 이 비용을 매번 낸다. 풀은 접속을
재사용하고, 커넥션별 statement cache 덕에 반복 쿼리의 재파싱도 아낀다.

```js
oracledb.createPool({
  poolAlias: alias,          // alias별 독립 풀
  connectString, user, password,
  poolMin: 0,                // 유휴 시 커넥션 0개 — DB 세션을 붙잡고 있지 않음
  poolMax: 4,                // 병렬 tool 호출(서브에이전트 fan-out) 대비. 초과분은 큐잉
  poolIncrement: 1,
  poolTimeout: 60,           // 60s 유휴 커넥션은 닫음
  poolPingInterval: 60,      // 유휴했던 커넥션은 체크아웃 시 생존 확인 (사내 방화벽
                             // 유휴 TCP 절단 대비 — 끊긴 커넥션이면 자동 교체)
  queueTimeout: 10000,       // 풀 고갈 시 대기 상한 10s → 초과 시 명확한 에러
  stmtCacheSize: 30,
});
```

#### 라이프사이클

- 프로세스 기동 시 풀 없음 → alias 첫 쿼리에서 `createPool` (lazy). 안 쓰는 DB엔
  아무 연결도 안 생긴다.
- 쿼리마다: `getConnection`(풀 체크아웃) → §5 실행 시퀀스 → `close()`(풀 반환 —
  TCP는 유지).
- `poolMin: 0` + `poolTimeout: 60` 조합이 핵심: 에이전트가 조용해지면 60초 뒤 DB
  세션이 전부 반납된다. 세션 켜둔 채 퇴근해도 DB에 유휴 세션이 밤새 붙어있지 않음
  (DBA 친화적).
- 세션 종료(stdio 닫힘/SIGTERM) 시 `pool.close(drainTime)` graceful 종료.
- Claude 세션 N개 = 프로세스 N개 = 풀 N벌. 최악(5세션 × poolMax 4) 20커넥션이지만
  lazy + 유휴 반납이라 실측은 훨씬 낮다. Oracle 기준 무시 가능한 수준.

**풀 재사용과 read-only의 상호작용** — 체크아웃된 커넥션은 직전 사용자의 상태를 이어받을
수 있으므로, §5 시퀀스가 매번 `SET TRANSACTION READ ONLY`로 시작하고 rollback으로
끝나는 것이 풀 전제에서도 안전한 이유다 (트랜잭션 상태가 반환 전에 항상 청산됨).
세션 상태 변경은 풀 `sessionCallback`의 고정 하드닝 문장(§6.1 병렬 쿼리 차단)
하나뿐이며, 사용자 SQL의 `ALTER SESSION`은 L2가 차단한다.

#### 장애 동작

- DB 재기동/네트워크 단절: 풀의 죽은 커넥션은 `poolPingInterval` 검사에서 교체.
  복구 후 첫 쿼리부터 정상.
- 풀 고갈(병렬 호출 > poolMax): 큐잉 후 `queueTimeout` 초과 시 에러 —
  "poolMax 상향 또는 순차 실행" 힌트 포함.
- DRCP(서버측 풀링)는 쓰지 않는다 — 클라이언트 수가 적어 불필요.
- 모든 쿼리 실행 경로는 단일 함수 하나를 통과한다 (`executeReadOnly()`) — L2·deny·
  read-only·캡을 우회하는 코드 경로가 존재하지 않게 하는 구조적 보장 (시퀀스는 §5).

## 4. 커넥션 설정 (멀티 DB / 멀티 계정)

```jsonc
// ~/.oracle-mcp/connections.json  (위치는 §10-3 논의)
{
  "connections": {
    "erp-prod": {
      "connectString": "erp-db.corp:1521/ERPPDB",
      "user": "APP_RO",
      "passwordEnv": "ORA_PW_ERP_PROD",     // 비밀번호는 env 변수명 참조만
      "description": "ERP 운영. 야간 배치 시간대(01~03시) 조회 자제"
    },
    "mes-dev": {
      "connectString": "mes-dev.corp:1521/MESPDB",
      "user": "DEV1",
      "passwordEnv": "ORA_PW_MES_DEV",
      "description": "MES 개발",
      "limits": { "defaultMaxRows": 200 }   // 커넥션별 캡 오버라이드 (선택)
    }
  },
  "limits": {                                // 전역 기본값 (선택, §6의 기본값을 덮음)
    "defaultMaxRows": 100
  }
}
```

- 파일에 비밀번호 직접 기입 불가 — `passwordEnv`만 지원. 값이 없으면 해당 alias는
  `list_connections`에 "비밀번호 env 미설정"으로 표시되고 사용 시 명확한 에러.
- `description`은 에이전트에게 노출된다 — 운영 DB 주의사항을 여기 적으면
  에이전트가 읽고 행동에 반영한다.
- 설정 파일 스키마 검증 실패 시 서버는 뜨되 해당 alias만 비활성 (fail-soft).

### 4.1 온보딩 (파일은 직접 작성 — 의도된 설계)

접속 정보는 사람마다 다르므로 플러그인에 싣지 않는다. 대신:

- **connections.json에는 비밀이 없다** (비밀번호는 `passwordEnv` 참조뿐) →
  Claude에게 시켜서 만들어도 안전. 플러그인에 셋업 스킬을 동봉해 대화형
  스캐폴딩 UX 제공 (v1 범위인지는 §10-8).
- 실제 비밀번호는 셸 프로파일 env로: `~/.oracle-mcp/env.sh` (chmod 600)에
  `export ORA_PW_...` 모아두고 `.bashrc`에서 source. MCP 서버는 Claude Code를
  띄운 셸의 env를 상속받는다.
- 파일이 없어도 서버는 뜬다 — `list_connections`가 "설정 없음 + 작성 방법" 안내를
  반환 (첫 사용자가 막히지 않게).
- 저장소에 `connections.example.json` 동봉.

## 5. Read-only 강제 — 4층 방어

계정 권한을 통제할 수 없으므로 (쓰기 권한 있는 계정이 물릴 수 있음) 서버가 전부 막아야 한다.
각 층이 막는 것과 못 막는 것이 다르다:

| 층 | 메커니즘 | 막는 것 | 못 막는 것 |
| --- | --- | --- | --- |
| **L1** | 매 쿼리를 `SET TRANSACTION READ ONLY` 트랜잭션 안에서 실행 | INSERT/UPDATE/DELETE/MERGE, `SELECT ... FOR UPDATE` — **DB가 ORA-01456으로 거부** | DDL (implicit commit이 탈출), autonomous txn, **`LOCK TABLE`(검증 §12-5: read-only에서 통과 — L2가 유일 방어)** |
| **L2** | 문장 검증: 주석·공백 제거 후 **첫 키워드가 `SELECT` 또는 `WITH`인 것만** 허용 | DDL, PL/SQL 블록(`BEGIN`/`DECLARE`/`CALL`), `EXPLAIN`, 기타 전부 | SELECT 내부에서 벌어지는 일 |
| **L3** | autocommit off + **commit을 호출하는 코드 경로가 없음** + 실행 후 무조건 rollback | L1·L2를 어떻게든 통과한 DML도 커밋되지 않음 | DDL, autonomous txn |
| **L4** | 드라이버 특성: `node-oracledb`는 `execute()`당 **정확히 한 문장** (멀티 스테이트먼트는 프로토콜 레벨 불가) | `SELECT ...; DROP ...` 류 문장 연결 | — |

### L2 설계 원칙: 첫 키워드 화이트리스트만, 내부 스캔 안 함

SQL 본문에서 `UPDATE`, `DELETE` 같은 키워드를 스캔하는 방식은 쓰지 않는다 —
문자열 리터럴·컬럼명·주석에서 오탐이 나고 (`SELECT * FROM audit_log WHERE action = 'DELETE'`),
오탐을 피하려면 결국 SQL 파서가 필요해진다. 첫 키워드 화이트리스트는 오탐 제로이고,
내부에서 벌어지는 DML은 L1(ORA-01456)이 DB 레벨에서 잡는다. 역할 분담:
**L2는 문장 종류를, L1은 문장 내용을 검사한다.**

L2는 단순 필터가 아니라 **부하 방어의 최종선이기도 하다**: DDL·`LOCK TABLE`은 L1이
못 막으므로(검증 §12-2/5), L2의 첫 키워드 화이트리스트가 없으면 read-only여도
`LOCK TABLE hot_tbl IN EXCLUSIVE MODE`로 DB 전체를 멈출 수 있다. → L2는 보안+가용성
양쪽을 떠받친다. 화이트리스트에서 벗어난 모든 첫 키워드를 거부하는 positive-match라
LOCK/DDL/PLSQL이 자동 포함된다.

예외 하나: `WITH FUNCTION` / `WITH PROCEDURE` (12c+의 인라인 PL/SQL)는 L2에서 차단한다.
인라인 함수에 `PRAGMA AUTONOMOUS_TRANSACTION`을 선언하면 SELECT 실행 중 쓰기가
가능한 유일한 "문장 작성만으로 뚫리는" 경로이기 때문. `WITH` 직후 토큰이
`FUNCTION`/`PROCEDURE`이면 거부. (CTE 이름을 `function`으로 짓는 정상 쿼리가
오탐될 수 있으나 실무에서 무시 가능한 수준 — §10-2)

### 잔여 리스크 (문서화하고 수용)

- **스키마에 이미 존재하는** autonomous transaction 함수를 SELECT에서 호출하는 경우:
  L1~L4 모두 못 막는다. 조건이 까다롭고(그런 함수가 존재해야 하고 에이전트가 호출해야 함),
  이는 해당 계정으로 SQL*Plus를 써도 동일한 리스크다. README에 명시하고,
  장기적으로는 DBA에 read-only 계정 요청이 방향.
- 시퀀스 `NEXTVAL`: SELECT로 시퀀스를 증가시킬 수 있다 (엄밀히는 상태 변경).
  read-only 트랜잭션에서도 허용되는 Oracle 동작. 데이터 파괴가 아니므로 수용.

### 테이블 접근 제한 — **채택: 수준 1+2** (커넥션별 선택 설정)

read-only와 달리 DB가 대신 강제해주는 메커니즘이 없다 (계정 권한 제외 — 통제 밖).
보장 수준이 계층적이며, v1은 1+2 채택 (2026-07-07 결정):

1. **카탈로그 표면 제한 (완전 강제, v1)** — 커넥션별 `tables.allow` 패턴:
   `list_tables`는 목록 밖 테이블을 숨기고 `describe_table`은 거부. 내부 고정
   쿼리에 필터만 추가하면 되므로 우회 불가. **에이전트는 스키마를 모르면 쿼리를
   못 짜므로 이것만으로도 억지력이 크다.**
2. **run_query denylist (준강제, v1)** — `tables.deny`의 민감 테이블명을 SQL에서
   단어 매칭 스캔, 등장 시 차단. L2의 "내부 스캔 안 함" 원칙(§5)과 다른 이유:
   DML 키워드와 달리 테이블명은 특이도 높은 토큰이라 오탐이 드물고, 오탐 비용도
   수용 가능 (민감 이름을 컬럼명으로 쓴 쿼리가 거부되는 정도).
   **우회 경로(문서화하고 수용)**: 뷰/시노님으로 감싼 접근(`SELECT * FROM
   emp_pay_synonym` → 실제 HR_SALARY)은 이름 스캔을 통과한다. 대소문자·인용
   식별자도 정규화 필요. deny는 "이름을 직접 쓴 실수/충동을 막는 준강제"이지
   민감정보 차단의 완전한 수단이 아니다 — 그건 수준 4(계정 권한).
3. **run_query allowlist (v1 제외)** — 참조 테이블 전수 추출에 SQL 파싱이 필요하고,
   파싱해도 뷰/시노님(밑의 테이블이 안 보임)·함수(내부에서 임의 테이블 읽기) 구멍이
   남는다. 필요해지면 별도 논의 (§10-9).
4. **DB 계정 권한 (완전 강제, 통제 밖)** — 민감정보 차단이 진짜 목적이면 이게 정답.
   서버 레이어는 심층방어.

```jsonc
"erp-prod": {
  "tables": {
    "allow": ["ERP.GL_*", "ERP.AP_*"],     // 카탈로그 표면 (완전 강제)
    "deny":  ["ERP.HR_SALARY", "*.PII_*"]  // 전 경로 이름 스캔 (준강제)
  }
}
```

### 실행 시퀀스 (모든 쿼리 공통)

```text
[L2] validateStatement(userSql)   # 첫 키워드 SELECT/WITH만. 실패 시 즉시 거부(DB 접촉 없음)
[deny] scanDeniedTables(userSql)  # tables.deny 이름 매칭 시 거부
pool.getConnection()
→ rollback()            # 체크아웃 즉시 — 더러운 커넥션 청산(ORA-01453 방지, 검증 §12-3)
→ callTimeout 설정 (기본 30s)
→ execute("SET TRANSACTION READ ONLY")
→ execute(userSql, binds, { maxRows: maxRows + 1 })   # +1은 절단 판정용(§6)
→ [cap] 셀/총량 캡 + truncated 플래그
→ rollback()            # read-only여도 무조건 — 트랜잭션·락 정리
→ connection.close()    # 풀 반환
```

L2·deny·캡이 이 단일 함수(`executeReadOnly()`) 안에 있어야 §3.1의 "우회 경로 없음"이
성립한다. 체크아웃 직후 rollback은 벨트-앤-서스펜더 — 순수 SELECT는 STRO를 막지 않지만
(검증 §12-3a), 어떤 경로가 미청산 트랜잭션을 남기면 다음 STRO가 ORA-01453으로 깨지므로.

## 6. 출력 제한 — 4단계 캡

토큰 폭발 방지. 모든 캡은 **잘렸음을 응답에 명시** — 조용히 자르면 에이전트가
전체 데이터로 착각하고 잘못된 결론을 낸다.

| 캡 | 기본값 | 상한(하드) | 동작 |
| --- | --- | --- | --- |
| 행 수 | 100 | 1,000 | **`maxRows + 1`을 fetch**해서 절단 여부를 정확히 판정(초과분이 오면 truncated=true, 반환은 maxRows까지). `rows.length === maxRows` 휴리스틱은 "정확히 maxRows개인 테이블"을 오탐하므로 쓰지 않는다 (검증 §11-5b) |
| 셀 크기 | 2,000자 | — | 긴 VARCHAR2는 slice. **CLOB/BLOB은 fetch 후 자르지 않는다 — 스트림(Lob)으로 받아 앞 2KB만 읽고 파기**(§6.2). fetchAsString은 전량 materialize라 메모리 폭탄(검증 §12-2). BLOB/RAW는 내용 대신 `<BLOB 1.2MB>` |
| 응답 총량 | 30,000자 | — | 직렬화 결과가 넘으면 행 단위로 잘라 "N행 중 M행 표시" |
| 실행 시간 | 30s | — | `callTimeout` — 폭주 쿼리가 커넥션 점유하는 것 방지 |

- 기본값은 전역 → 커넥션별 → tool 호출 파라미터 순으로 오버라이드 (하드 상한은 불변).
- `COUNT(*)` 자동 실행은 하지 않는다 — 대형 테이블에선 그 자체가 폭주 쿼리.
  총 건수가 필요하면 에이전트가 명시적으로 COUNT 쿼리를 던진다.

### 6.2 데이터 타입 직렬화 (검증에서 도출 — §12)

- **NUMBER는 전량 문자열로 fetch** (`oracledb.fetchAsString = [oracledb.NUMBER]`).
  기본 JS number 매핑은 2^53 초과에서 **조용히 값을 바꾼다** (검증 §12-1:
  `90071992547409929 → …940`). 계좌번호·금액·큰 ID에서 치명적. 문자열이면 무손실.
  - fetchAsString(NUMBER)은 **세션 NLS 무관, 항상 `.` 소수점** (thin 드라이버가
    클라이언트측 포맷 — 검증 §12-9). 따라서 로케일에 따른 콤마 소수점 오염 없음.
  - 트레이드오프(전량 문자열): COUNT·플래그·소수 ID 등 안전범위 99%도 문자열이 됨 +
    문자열 정렬/산술 함정(`"9">"100"`). 완화: **응답 `columns`에 컬럼 타입을 실어**
    자기설명적으로("이 문자열 컬럼은 NUMBER"), tool description에 "숫자는 문자열로 온다"
    명시. 값 단위 선택적 문자열화는 **컬럼 내 타입 혼합**을 낳아 더 나쁨 — 필요 시
    v2에서 컬럼 메타(정밀도≤15∧scale0→number) 단위로만.
- **DATE/TIMESTAMP**: ISO-8601 문자열로 정규화(`YYYY-MM-DD"T"HH24:MI:SS`),
  TIMESTAMP WITH TIME ZONE은 오프셋 포함. 세션 NLS 포맷 의존 제거.
- **NLS 고정 (sessionCallback)**: 에이전트가 SQL에 직접 쓴 `TO_CHAR(n)`·날짜 포맷은
  **서버 변환이라 세션 NLS를 탄다** (검증 §12-9: 콤마 로케일 → `"1234,56"`).
  DB마다 결과가 달라지지 않게 `sessionCallback`에서 `NLS_NUMERIC_CHARACTERS='.,'` +
  `NLS_DATE_FORMAT` 고정 (§6.1 병렬 차단 하드닝과 같은 자리).
- **CLOB/BLOB**: `fetchAsString`을 걸지 않고 **`Lob` 핸들로 받아
  `lob.getData(1, CAP+1)`로 서버측 부분 읽기** (검증 §12-10: 1MB CLOB에서 2000자만
  1ms에 반환, 전량 materialize 없음). CAP+1은 절단 판정용, 전체 크기는 `lob.length`로
  읽지 않고 얻어 `…[truncated, total 340KB]` 주석에 사용. BLOB은 같은 API가 Buffer 반환.
  - `fetchAsString`은 전량 materialize(검증 §12-2)라 대형 LOB에서 node OOM +
    callTimeout 소진 → 쓰지 않는다. 서버측 `DBMS_LOB.SUBSTR`은 사용자 SQL 재작성이
    필요해 "원문 실행" 원칙(§7)과 충돌하므로 쓰지 않는다.
  - **라이프사이클 제약**: Lob은 커넥션에 묶여 close(풀 반환) 전에 읽어야 한다
    (rollback은 무해 — 검증 §12-10). §5 시퀀스의 "행 처리→캡→rollback→close" 순서가
    이를 보장.
  - **비용**: LOB 셀당 round-trip 1회(`100행 × LOB 2컬럼 = 200왕복`). 각각 CAP로
    작고 행 캡(100)이 상한을 묶으므로 수용. LOB 컬럼이 많은 쿼리가 실측 병목이면
    LOB 컬럼 수 캡을 v2에서 검토.

### 6.1 폭주 쿼리와 DB 부하

**`callTimeout`은 클라이언트 포기가 아니라 서버 실행 중단이다** — 시간 초과 시
Oracle Net break로 DB에서 실행 중인 문장 자체가 중단된다. 따라서 타임아웃이 곧
부하 상한 장치. **검증됨(§11-7)**: 62.5B행 카티전(무중단 시 ~13분)이 2005ms에
`NJS-123`으로 잘림. thin mode 에러코드는 `NJS-123`(문서 초안의 ORA-03156 아님).
**타임아웃 후 커넥션은 즉시 재사용 가능** — break+reset이 깨끗한 상태로 되돌리므로
타임아웃난 쿼리가 풀 커넥션을 오염시키지 않는다 (§3.1의 poolPingInterval 교체는
네트워크 단절용이지 타임아웃용이 아니다).

**동시성×시간 상한 = `N_프로세스` × `poolMax` × `callTimeout`** — 이건 **벽시계
상한**이지 자원(CPU/IO) 상한이 아니다: 한 쿼리가 callTimeout 안에서도 카티전·해시조인으로
CPU를 태울 수 있다. 또한 상한은 프로세스당이므로 **Claude 세션 N개 = ×N**(팀 5명이
동시에 erp-prod를 치면 5×poolMax). 자원 자체의 상한은 Resource Manager(통제 밖, 아래)뿐.
그래도 이 곱은 "무한 재시도 루프가 DB를 무한히 점유"는 못 하게 막는 유용한 벽시계 경계다.
커넥션별 설정으로 운영은 빡빡하게, 개발은 느슨하게:

```jsonc
"erp-prod": { "limits": { "callTimeout": 10, "callTimeoutMax": 30, "poolMax": 2 } },
"mes-dev":  { "limits": { "callTimeout": 30, "callTimeoutMax": 120 } }
```

에이전트의 `timeout_seconds` 상향 요청은 `callTimeoutMax`(하드맥스)까지만.

**`maxRows`의 부하 절감 한계**: 스트리밍 플랜(풀스캔에서 행을 흘리는 쿼리)은 커서를
닫으면 DB도 생산을 멈추므로 행 캡이 부하 캡 역할을 한다. 그러나 블로킹 연산(대형
정렬·GROUP BY·해시 조인)은 첫 행 전에 일이 다 벌어지므로 행 캡이 무력 — 시간 캡만이
방어선. 둘 다 필요한 이유.

**병렬 쿼리 차단**: `/*+ PARALLEL */` 힌트는 PX 서버를 동원해 부하를 증폭시킨다.
풀의 `sessionCallback`(물리 커넥션 생성 시 1회)에서
`ALTER SESSION DISABLE PARALLEL QUERY` 적용. 이를 되돌리는 사용자 `ALTER SESSION`은
L2가 차단하므로 상태 유지가 보장된다.

**피드백 루프**: 응답에 `elapsedMs` 포함 (에이전트가 스스로 쿼리를 좁히는 근거).
타임아웃 에러는 코칭 포함 — "10s 초과로 중단됨. WHERE로 좁히거나 인덱스 컬럼 조건을
쓰세요. timeout_seconds로 최대 30s까지 상향 가능".

**통제 밖 (README에 DBA 요청 항목으로)**: Resource Manager 컨슈머 그룹, 프로파일
`CPU_PER_CALL`/`LOGICAL_READS_PER_CALL` — 계정 권한을 통제할 수 없는 환경이라
설계에 넣지 못하는 정석 수단들.

### 응답 포맷 (토큰 절약형)

행마다 컬럼 키를 반복하는 객체 배열 대신 columns + rows:

```json
{
  "columns": ["LOT_ID", "STATUS", "QTY"],
  "rows": [["L001", "RUN", 25], ["L002", "HOLD", 25]],
  "rowCount": 2,
  "truncated": false
}
```

잘렸을 때:

```json
{
  "columns": ["..."], "rows": ["..."],
  "rowCount": 100,
  "truncated": true,
  "hint": "행 100개에서 절단됨. WHERE로 좁히거나 집계(GROUP BY/COUNT)를 사용하세요."
}
```

## 7. Tool 명세

| tool | 파라미터 | 반환 | 비고 |
| --- | --- | --- | --- |
| `list_connections` | — | alias, description, user, 상태(env 설정 여부) | 비밀번호는 어떤 형태로도 반환 안 함 |
| `list_tables` | `db`, `schema?`, `name_filter?` | 테이블명, 코멘트 | `ALL_TABLES` + `ALL_TAB_COMMENTS`. filter는 `LIKE` 바인드 |
| `describe_table` | `db`, `table` (schema 접두 허용) | 컬럼표(명/타입/널/기본값/코멘트), PK, FK, **인덱스(컬럼 순서+유니크 여부)**, **규모(`NUM_ROWS`/`LAST_ANALYZED` 통계)** | `ALL_TAB_COLUMNS`, `ALL_COL_COMMENTS`, `ALL_CONSTRAINTS`, `ALL_CONS_COLUMNS`, `ALL_INDEXES`, `ALL_IND_COLUMNS`, `ALL_TABLES`. 출력 구조는 keyword-docs db-schema 템플릿 슬롯과 정렬 (§10-4) |
| `run_query` | `db`, `sql`, `binds?`, `max_rows?` | §6 포맷 | L1~L4 전체 통과. 바인드는 named(`:id`) 권장 |
| ~~`explain_plan`~~ | — | — | **v1 제외 확정 (§10-1)** — 아래 참고 |

### `explain_plan` — v1 제외 확정 (2026-07-07)

`EXPLAIN PLAN FOR ...`는 `PLAN_TABLE`에 **INSERT**한다 — read-only 트랜잭션 안에서
ORA-01456으로 실패한다. 넣으려면 이 tool만 L1을 우회하는 carve-out이 필요
(§3 단일 경로 원칙의 예외). 추정치라 바인드 피킹·낡은 통계에서 빗나가는 한계도 있다.

**결정: 제외하고, 대신 이렇게 커버한다** —

- 허용 테이블들은 **keyword-docs db-schema 문서로 보강** (인덱스·대표 쿼리·
  마이그레이션 주의 슬롯) → 에이전트가 검증된 쿼리 패턴에서 출발하므로
  플랜 검증이 필요한 상황 자체를 줄임 (이게 주 근거)
- describe_table의 인덱스 순서 + NUM_ROWS(§7)와 타임아웃 코칭(§6.1)이 나머지 커버
- ⚠️ **주의(검증 §12-4)**: allow는 **카탈로그 탐색 표면만** 좁힌다 — run_query는
  allow를 강제하지 않으므로(v1 수준 3 제외) 에이전트가 이름을 알면 allow 밖 테이블도
  쿼리한다. 따라서 "쿼리 표면이 유한 집합"은 **성립하지 않으며**, explain_plan 제외
  근거는 위의 db-schema 보강·코칭에 둔다(테이블 집합 유한성에 두지 않는다).

**재추가 트리거**: 관측(§10-5 연계)에서 "타임아웃 반복에 갇히는 패턴"이 실측되면
carve-out 설계로 추가 — 서버가 `EXPLAIN PLAN FOR` 접두부를 상수로 붙이고
L2 통과(SELECT/WITH) 문장만 받는 형태면, 대상 문장은 실행되지 않으므로
보안 구멍이 아니라 원칙의 예외 1개로 관리 가능.

### 쿼리 작성 주체 — 두 층위

- **`run_query`의 SQL은 에이전트가 작성한다.** 서버는 만들지 않고 검증(L2)·실행(L1/L3)만.
  에이전트는 describe_table(또는 keyword-docs의 db-schema 문서)로 스키마를 파악하고
  SQL을 작성, ORA 에러(§8 원문 반환)를 보고 자기수정 루프를 돈다. 바인드는 강제가
  아닌 권장 — SQL 전체가 에이전트 작성물이라 고전적 인젝션 구도가 없고, 실익은
  따옴표 실수 방지 + statement cache 적중.
- **인덱스를 아는 쿼리 작성**: describe_table이 인덱스 컬럼 순서·유니크 여부·테이블
  규모(NUM_ROWS)를 주므로, 에이전트가 "500만 행 → 인덱스 선두 컬럼 조건 필수" 판단을
  할 수 있다. run_query tool description에 "대형 테이블은 describe_table로 인덱스
  확인 후 작성"을 명시 → §6.1 타임아웃 코칭과 피드백 루프 완성 (느린 쿼리 → 중단 →
  코칭 → 인덱스 재확인 → 수정). 실제 플랜 검증(explain_plan)은 v1 보류 (§10-1).
- **`list_tables`/`describe_table`의 내부 쿼리는 고정 템플릿 + 바인드만.** 카탈로그
  뷰에서 테이블명은 식별자가 아닌 값이라 전부 바인드 가능 (`WHERE owner = :owner
  AND table_name = :table`). 문자열 조립 경로가 존재하지 않는다.

### 스키마 조회는 `ALL_*` 뷰만

`DBA_*` 뷰는 쓰지 않는다 — 권한 없는 계정에서 에러가 나고, 계정이 볼 수 있는 범위(`ALL_*`)가
곧 에이전트가 볼 수 있어야 하는 범위다.

## 8. 에러 처리와 감사 로그

- Oracle 에러는 **ORA 코드 + 메시지 그대로** 반환 — 에이전트가 스스로 수정하는 데
  가장 유용한 정보다 (ORA-00942 table not found, ORA-00904 invalid column 등).
- L2 거부는 정형 메시지: `"SELECT/WITH 문만 실행할 수 있습니다 (read-only MCP). 받은 문장: DELETE..."`
- 접속 실패(호스트/비번)는 alias와 connectString(비번 제외)을 포함해 반환.
- 서버 내부 오류로 프로세스가 죽지 않게 tool 핸들러 최상위에서 catch — MCP 에러 응답으로 변환.

### 감사 로그 (§10-5 결정: 로컬 파일 기록)

- 위치: `~/.oracle-mcp/audit/audit-YYYY-MM-DD.jsonl` — 일 단위 파일, 정리는
  사용자 몫 (v1은 로테이션 없음).
- 한 줄에 한 실행: `{ts, alias, tool, sql, elapsedMs, rowCount, truncated,
  oraError}`. **바인드 값은 기록하지 않는다** (민감 데이터 가능성) — SQL 원문만.
  ⚠️ **한계(검증 §12-8)**: 바인드를 뺀다고 민감정보가 안 남는 게 아니다 — 바인드는
  "권장"일 뿐이라 에이전트가 리터럴을 인라인하면(`WHERE ssn='123-45-6789'`) 그 값이
  SQL 원문에 섞여 평문 기록된다. 감사 로그가 민감할 수 있다는 전제로 파일 권한(0600)을
  두고, 진짜 PII 보호는 deny(§5)+계정 권한(수준 4)에 의존한다.
- **fail-open**: 로그 쓰기 실패가 쿼리 실행을 막지 않는다 (stderr 경고만).
- 용도: 사후 추적 + explain_plan 재추가 트리거(§7)의 근거 데이터
  (타임아웃 반복 패턴 확인).

## 9. 테스트 전략

| 레벨 | 대상 | 방법 |
| --- | --- | --- |
| 단위 | L2 문장 검증기 (순수 함수) | `node:test`. 케이스: SELECT/WITH 허용, DML/DDL/PLSQL/`WITH FUNCTION` 거부, 주석·공백 변형 |
| 통합 | L1/L3 실동작, 캡, 스키마 조회 | Docker `gvenzl/oracle-free:23-slim` + 시드 스크립트 |
| CI | 위 전부 | GitHub Actions service container (기동 1~2분) |

**19c vs 23ai Free**: 검증 대상(thin 연결, `SET TRANSACTION READ ONLY`/ORA-01456,
`ALL_*` 뷰, LOB 절단)은 두 버전에서 동작 동일. 19c 고유 확인(사내 문자셋, 실제 권한
구성)은 회사 DB 스모크 테스트 1회로 마감.

**통합 테스트로 반드시 증명할 것** (설계의 핵심 가정 검증) — **1~5,7 완료(§11), 6 구현 단계**:

1. read-only 트랜잭션에서 INSERT/UPDATE/DELETE/`FOR UPDATE` → ORA-01456 ✅
2. read-only 트랜잭션에서 DDL이 **탈출함** (L1의 구멍 실증 → L2 존재 이유) ✅
3. autonomous txn 함수로 SELECT에서 쓰기 가능함 (L2 차단 이유 실증) ✅
4. `execute()`에 세미콜론 연결 문장 → 드라이버 에러 (L4 실증) ✅
5. maxRows 캡 + `maxRows+1` fetch 절단 판정 + 오탐 음성대조 ✅
6. esbuild 번들 산출물(`dist/server.mjs`)로 thin 접속 동작 (thick용 동적 require가
   번들을 깨지 않는지) — **구현 단계에서 검증**
7. `callTimeout` 초과 시 서버측 실행 중단 ✅

> 검증 결과는 [§11 부록](#11-부록-검증-결과)에 기록.

## 10. 열린 논의 사항

1. ~~explain_plan을 v1에 넣을까?~~ — **결정(2026-07-07): v1 제외.** 허용 테이블
   한정(§5 수준 1) + db-schema 문서 보강으로 커버. 재추가 트리거·carve-out
   스케치는 §7 참고.
2. ~~`WITH FUNCTION` 차단의 오탐 수용?~~ — **결정(2026-07-07): 수용.**
   실무 발생 확률 ≈ 0, 우회는 CTE 이름 변경으로 간단.
3. ~~connections.json 위치~~ — **결정(2026-07-07): 글로벌 `~/.oracle-mcp/` 하나.**
   접속 정보는 사람에 붙는 정보. 저장소 커밋 위험도 제거.
4. ~~keyword-docs 연계 시점~~ — **결정(2026-07-07): 출력 정렬까지만 v1**, 문서
   굳히기(자동 `.md` 생성)는 v2. 단, 허용 테이블의 db-schema 문서 작성은
   explain_plan 대체 수단이므로 운영 절차로 병행 (§7).
5. ~~감사 로그~~ — **결정(2026-07-07): 로컬 파일 기록.** 상세는 §8.
6. ~~저장소 이름~~ — **결정(2026-07-07): `agent-db-plugin`** (저장소·플러그인 동일).
7. ~~결과 포맷~~ — **결정(2026-07-07): JSON 확정** (§6).
8. ~~셋업 스킬~~ — **결정(2026-07-07): README + `connections.example.json`으로
   시작**, 스킬은 사용자 늘어날 때.
9. ~~run_query 테이블 allowlist 강제(§5 수준 3)~~ — **결정(2026-07-07): v1 제외.**
   수준 1+2 채택. 실사용에서 갭이 확인되면 재논의. 민감정보가 목적이면
   DBA 협의(수준 4)가 정도.

## 11. 부록: 검증 결과

**2026-07-07, gvenzl/oracle-free:23-slim + node-oracledb 7.0.0 (thin), 11/11 통과.**
설계의 모든 핵심 가정 실증 완료.

| # | 검증 항목 | 결과 |
| --- | --- | --- |
| 11-1 | read-only 트랜잭션이 INSERT/UPDATE/DELETE/`FOR UPDATE` 거부 | ✅ 4종 모두 **ORA-01456** |
| 11-2 | read-only 트랜잭션에서 DDL이 탈출함 (L1의 구멍 → L2 존재 이유) | ✅ `CREATE TABLE` 성공(트랜잭션 탈출) |
| 11-3 | `AUTONOMOUS_TRANSACTION` 함수가 SELECT에서 쓰기 성공 (L2 차단 이유) | ✅ SELECT가 t_audit에 기록됨 |
| 11-4 | `execute()`에 세미콜론 연결 문장 → 드라이버 거부 (L4) | ✅ **ORA-03405** |
| 11-5 | `maxRows+1` fetch로 정확한 truncated 판정 | ✅ 101 fetch → 100 반환, truncated=true |
| 11-5b | 정확히 maxRows개인 테이블 오탐 없음 (음성대조) | ✅ 100행 → truncated=false |
| 11-7 | `callTimeout`이 서버 실행 중단 | ✅ 62.5B행 카티전이 2005ms에 **NJS-123**으로 중단 |
| 11-7b | 타임아웃 후 커넥션 재사용 가능 | ✅ break 후 즉시 `SELECT 1` 성공 (풀 오염 없음) |

**설계 반영 사항** (검증에서 도출):

- 절단 판정은 `maxRows+1` fetch 방식 확정 (§6) — `length === maxRows` 휴리스틱 폐기.
- thin mode 타임아웃 에러코드 = `NJS-123` (§6.1) — 초안의 ORA-03156 정정.
- 타임아웃난 커넥션은 재사용 가능 → 타임아웃용 풀 교체 로직 불필요 (§3.1/§6.1).

**주의**: §9-6(esbuild 번들 산출물로 thin 접속)은 구현 단계에서 검증 — 지금은 소스
직접 실행 기준. 사내 19c 고유(문자셋 `KO16MSWIN949` 등, 실제 권한)는 회사 DB 스모크
테스트에서 마감.

검증 스크립트: `scratchpad/oracle-verify/verify.mjs` (11 케이스, 시드→검증→요약).

## 12. 적대적 검증 (2026-07-07, 라이브 실증)

핵심 주장을 라이브 DB로 공격한 결과. 스크립트: `scratchpad/oracle-verify/adversarial.mjs`.
확인된 결함은 위 섹션에 이미 반영됨 — 아래는 근거 원장.

| # | 공격 | 판정 | 실측 | 반영 |
| --- | --- | --- | --- | --- |
| 12-1 | NUMBER 2^53 초과 정밀도 | 🔴 **BROKEN→FIX** | `90071992547409929 → …940`; fetchAsString로 무손실 | §6.2 |
| 12-2 | CLOB 2KB 캡을 fetch-후-절단으로? | 🔴 **MEMORY-BOMB→FIX** | 128KB CLOB 전량 materialize; 스트림 앞 2KB만 읽기로 교정 | §6/§6.2 |
| 12-3 | 더러운 풀 커넥션에서 STRO | 🟠 **RISK→FIX** | 미청산 txn → `ORA-01453`; 체크아웃 rollback 선행 | §5 시퀀스 |
| 12-3a | 순수 SELECT 뒤 STRO | ✅ 안전 | 성공 (SELECT는 STRO 안 막음) | — |
| 12-4 | run_query가 allow 우회? | 🟠 **CONFIRMED-GAP** | allow 밖 테이블 `SELECT`로 'leaked' 읽힘 | §7 근거 수정 |
| 12-5 | LOCK TABLE이 L1 통과? | 🟡 **통과** | read-only에서 `LOCK TABLE` 성공 → L2가 유일 방어 | §5 L1행·L2노트 |
| 12-6 | MERGE를 L1이 막나 | ✅ BLOCKED | `ORA-01456` | 확인 |
| 12-7 | 부하 상한 = poolMax×callTimeout? | 🟡 **과장** | 벽시계 상한, 자원 상한 아님; ×N프로세스 누락 | §6.1 표현 수정 |
| 12-8 | 바인드 제외로 감사 로그 안전? | 🟡 **부분** | 리터럴 인라인 시 SQL 원문에 평문 잔존 | §8 한계 명시 |
| 12-9 | fetchAsString(NUMBER)이 NLS 타나? | ✅ **무관** | fetchAsString→항상 `.`; 단 사용자 `TO_CHAR`는 NLS 탐(`1234,56`) | §6.2 NLS 고정 |
| 12-10 | LOB 부분 읽기 API 존재? | ✅ **해결** | 기본=Lob 핸들, `getData(1,2000)`=서버측 2000자 1ms; close 前 읽기 제약 | §6.2 확정 |
| — | ORA-01466 | ℹ️ edge | 정의 변경 <1s 테이블을 read-only로 읽으면 실패; 배포창 중 드묾. 필요 시 01466 1회 재시도 | 관찰 |

**결론**: read-only 4층 방어의 뼈대(L1 ORA-01456 + L2 화이트리스트 + no-commit +
단문)는 공격을 견뎠고, "쓰기 차단"이라는 1차 목표는 유지된다. 그러나 **조회 도구로서의
정확성**에서 두 개의 실질 결함(NUMBER 손상, LOB 메모리 폭탄)이 실증됐고, 부하·접근
제한 주장 일부가 과장이었다. 모두 위 섹션에 반영 완료. **판단거리 2건 다 검증으로 해소**:

1. ~~NUMBER 직렬화 정책~~ — **결정(2026-07-07): 전량 문자열** + 컬럼 타입 메타 +
   NLS 고정(§6.2). NLS 오염 우려는 검증으로 기각. 컬럼 메타 기반 선택은 v2 UX 최적화.
2. ~~LOB 부분 읽기 API~~ — **확정(2026-07-07): `lob.getData(1, CAP+1)` 서버측 부분
   읽기**(검증 §12-10, §6.2). close 前 읽기 제약 + 셀당 round-trip 비용 반영.
