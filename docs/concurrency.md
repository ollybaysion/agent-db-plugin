# 동시성·부하 시나리오

한 세션(= MCP 서버 프로세스 하나)이 동시/병렬 쿼리로 DB에 부하를 주는 경로와, 그걸
묶는 메커니즘을 정리한 **참고 문서**다. 메커니즘 자체는 이미 구현돼 있다 — 풀은
`src/pool.mjs`(#3), `callTimeout`은 `src/readonly.mjs`(#4). 여기서 새로 구현·검증할 것은
없고, 운영자가 "왜 이 상한인가"를 이해하고 `poolMax`/`callTimeout`을 조절하기 위한
근거 문서다.

설계 근거: `docs/design.md` §3.1(커넥션 수명), §6.1(폭주 쿼리와 DB 부하), §12(적대검증).

## 한 세션이 DB에 부하를 주는 두 경로

### 경로 1 — 동시 쿼리 여러 개

에이전트가 `run_query`를 병렬로 여러 개 던지는 경우. node-oracledb 커넥션은
non-concurrent(한 커넥션에 한 번에 한 문장)라, 동시 쿼리 N개 = 풀에서 커넥션 N개
체크아웃이다. 따라서 한 세션의 동시 실행 상한은 **`poolMax`개**로 묶인다.

- `poolMax`를 초과한 요청은 **hang이 아니라** `queueTimeout` 동안 큐잉된 뒤 명확한
  에러로 실패한다 — `QUEUE_TIMEOUT_MS = 10000`(10초), `src/pool.mjs:19`. 무한 대기가
  아니라 "지금 풀이 꽉 찼다"는 신호를 에이전트에게 되돌려 준다.
- `poolMin = 0`(`src/pool.mjs:15`)이라 유휴 커넥션은 DB로 반환된다 — 부하가 없을 때
  세션이 DB 자원을 붙들고 있지 않는다.

### 경로 2 — 쿼리 하나가 병렬로 증폭

`SELECT /*+ PARALLEL(t, 16) */ ...` 힌트 하나가 PX(병렬 실행) 서버 여러 개를 동원해
단일 쿼리로도 부하를 증폭시킬 수 있다.

- 풀의 `sessionCallback`이 물리 커넥션 생성 시 1회 `ALTER SESSION DISABLE PARALLEL
  QUERY`를 적용해 차단한다(`src/pool.mjs:37`).
- 이를 되돌리려는 사용자 `ALTER SESSION`은 L2(첫 키워드 SELECT/WITH 화이트리스트)가
  거부하므로, 세션 수명 내내 병렬 차단 상태가 유지되는 것이 보장된다.

## 부하 상한

**공식: 한 세션의 alias당 최악 = `poolMax × callTimeout`** (벽시계 상한, 자원 상한 아님).

- **`callTimeout`은 클라이언트 포기가 아니라 서버 실행 중단**이다. 시간 초과 시 Oracle
  Net break로 DB에서 실행 중인 문장 자체가 끊긴다 → 이것이 부하 상한의 핵심 장치.
  thin mode에서 에러코드는 `NJS-123`이며, 62.5B행 카티전이 ~2초에 잘리는 것으로
  실증됐다(design §11-7). 타임아웃 후 커넥션은 즉시 재사용 가능(break+reset이 깨끗한
  상태로 되돌림) — 오염되지 않는다.
- **프로세스 간은 ×N**: Claude 세션 N개 = 프로세스 N개이므로 실질 상한은
  `N_프로세스 × poolMax × callTimeout`. 팀 5명이 동시에 `erp-prod`를 치면 5 × poolMax.
- **벽시계이지 자원(CPU/IO) 상한은 아니다**: 한 쿼리가 `callTimeout` 안에서도
  카티전·해시조인으로 CPU를 태울 수 있다. 이 곱이 막아 주는 것은 "무한 재시도 루프가
  DB를 무한정 점유"하는 상황이다.

**`maxRows`의 부하 절감 한계**: 스트리밍 플랜(풀스캔에서 행을 흘리는 쿼리)은 커서를
닫으면 DB도 생산을 멈추므로 행 캡이 곧 부하 캡이 된다. 그러나 블로킹 연산(대형 정렬·
GROUP BY·해시 조인)은 첫 행이 나오기 전에 일이 다 벌어지므로 행 캡이 무력 — 시간 캡만이
방어선이다. 시간 캡과 행 캡이 둘 다 필요한 이유.

### 조절 knob

| knob | 위치 | 효과 |
| --- | --- | --- |
| `poolMax` | 커넥션별 `limits.poolMax` | 세션당 동시 쿼리 상한. 운영 권장 2, 완전 직렬을 원하면 1 |
| `callTimeout` | 커넥션별 `limits.callTimeout` | 쿼리당 벽시계 상한(초). 운영 10s / 개발 30s |
| `callTimeoutMax` | 커넥션별 `limits.callTimeoutMax` | 에이전트의 `timeout_seconds` 상향 요청 하드맥스 |

```jsonc
"erp-prod": { "limits": { "callTimeout": 10, "callTimeoutMax": 30, "poolMax": 2 } },
"mes-dev":  { "limits": { "callTimeout": 30, "callTimeoutMax": 120 } }
```

**통제 밖 (계정 권한 = DBA 몫, README의 요청 항목)**: 진짜 자원 상한(CPU/IO)은 Oracle
Resource Manager 컨슈머 그룹과 프로파일 `CPU_PER_CALL`/`LOGICAL_READS_PER_CALL`로만
걸 수 있다. 계정 권한을 통제할 수 없는 환경이라 이 문서의 벽시계 상한은 그 대체가
아니라 보완이다.

## 열린 질문 (사내 스모크에서 확인 — 지금 막을 필요 없음)

이 두 가지는 실 DB/실사용 환경에서 한 번 확인하면 되는 관찰 항목이지, v1 구현을 막는
결정이 아니다.

1. **병렬쿼리 차단이 실무에서 진짜 무력화하나.** 지금까지 확인한 것은 `ALTER SESSION
   DISABLE PARALLEL QUERY`가 **수용된다**는 것까지다. 실제로 serial 실행이 강제되는지는
   사내에서 `V$SQL`/`V$PX_SESSION` 또는 실행 플랜으로 한 번 대조한다.
2. **MCP 서버가 병렬 tool 호출을 동시 처리하나 직렬화하나.** MCP SDK 거동에 달렸다.
   - 직렬화한다면 → intra-session 동시성은 항상 1이므로 경로 1은 사실상 무의미(상한은
     언제나 커넥션 1개)하고, `poolMax`는 안전 여유분일 뿐이다.
   - 동시 처리한다면 → `poolMax`가 세션당 동시성의 실질 상한이다.
   - 확인 후 결과에 맞춰 README에 `poolMax` 가이드 한 줄을 추가한다.

## 참고

- 구현: `src/pool.mjs`(#3 — 풀·`queueTimeout`·`sessionCallback`),
  `src/readonly.mjs`(#4 — `callTimeout`)
- 설계: `docs/design.md` §3.1, §6.1, §12
