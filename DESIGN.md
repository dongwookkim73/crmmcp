# Dynamics 365 로컬 MCP 서버 설계서

- 작성일: 2026-10-15
- 대상: Dynamics 365 Online (Dataverse, `*.crm3.dynamics.com`), Field Service 포함
- 용도: (1) 리포트 작성 (2) 일반 사용자 지원 / 트러블슈팅
- 실행 형태: 로컬 PC에서 stdio MCP 서버로 실행 → Claude Desktop / Claude Code에서 사용

---

## 1. 리서치 요약: Microsoft 공식 MCP 서버가 제공하는 기능

### 1.1 Dataverse MCP Server (GA, `/api/mcp`)

| 도구 | 기능 | 비고 |
|---|---|---|
| `search` | 테이블 스키마·스킬을 키워드로 검색 (메타데이터) | |
| `describe` | 테이블/레코드/스키마/앱 상세 | 구 `describe_table`, `list_tables`, `fetch` 대체 |
| `read_query` | Dataverse SQL `SELECT` 실행 | **JOIN, GROUP BY, DISTINCT, HAVING, 서브쿼리, OFFSET 미지원**, 대량 결과 잘림 보고 있음 |
| `search_data` | Dataverse Search(정형+비정형) | Dataverse search 활성화 필요, **호출당 10 크레딧** |
| `create_record` / `update_record` / `delete_record` | 레코드 CRUD | delete는 사용자 승인 후 |
| `create_table` / `update_table` / `delete_table` | 스키마 변경 | |
| `upsert_skill` / `delete_skill` | Dataverse 스킬(플레이북) | |
| `init_file_upload` / `commit_file_upload` / `file_download` | 파일 컬럼 SAS URL | |

- 보안: Dataverse 보안 역할·행 수준 보안 그대로 적용
- 과금: 2025-12-15부터 Copilot Studio 외부 에이전트 사용 시 Copilot Credit 과금 (D365 Premium / M365 Copilot USL 보유 시 면제)
- 연결: `npx @microsoft/dataverse mcp <orgUrl>` 로컬 프록시, 테넌트 관리자 동의 + PPAC에서 허용 클라이언트 등록 필요

### 1.2 Dynamics 365 Sales MCP Server
- 리드/계정/경쟁사 리서치, 아웃리치 이메일 초안, 영업기회 건강도·리스크·스테이크홀더 등 **생성형 AI 도구 ~20개**
- Agent 365 게이트웨이 경유, **Claude Desktop 미지원** 명시

### 1.3 Dynamics 365 Customer Experience MCP Server for Service (GA 2026-07)
- 90+ 도구: 케이스 관리(조회/검색/수정/할당/해결, SLA), 고객 정보·타임라인, 지식 문서, 이메일 보조, 활동/노트, 다음 최선 조치, 데이터 검색, 관리 도구
- 도구별로 Dataverse 권한(privilege)에 매핑 → 권한 없으면 도구 자체가 노출되지 않음
- Agent 365 Tooling Gateway 경유

### 1.4 Field Service
- **전용 MCP 서버 없음.** Dataverse MCP의 범용 조회로만 접근 가능

### 1.5 설계에 주는 시사점
1. 공식 서버의 핵심 약점은 **`read_query`의 SQL 제약**(JOIN·집계 불가) → 리포트 용도로 부족. 우리 서버는 **FetchXML**(조인·집계·그룹핑 지원)을 1급 시민으로 둔다.
2. 공식 서버에는 **사용자 지원용 진단 도구가 없다** (역할/팀/권한 확인, 감사 이력, 플러그인 오류). → 우리 서버의 차별점.
3. Field Service 특화 도구가 없다 → 작업지시·예약·리소스 일정 도구를 만든다.
4. 공식 서버의 좋은 패턴은 차용: 권한은 Dataverse에 위임, 파괴적 작업은 명시적 승인, 메타데이터 검색→상세→조회의 3단계 흐름.

---

## 2. 설계 목표 / 비목표

**목표**
- 사용자 본인 계정(위임 권한)으로 Dataverse Web API 직접 호출 → **Copilot Credit 과금 없음**, 본인 권한 범위만 접근
- 기본 **읽기 전용**, 쓰기는 설정으로 명시적 활성화 + 2단계 확인
- 리포트: 조인·집계 쿼리, 대량 결과는 로컬 파일(CSV/XLSX)로 저장하고 요약만 AI에 전달
- 지원: "왜 안 보여요 / 왜 안 돼요"를 도구 몇 번으로 진단
- 나중에 원격(HTTP) 배포로 확장 가능한 구조

**비목표 (1차)**
- 스키마 변경(테이블 생성/삭제), 레코드 삭제
- 생성형 AI 도구(요약·이메일 초안) — Claude가 직접 수행하므로 불필요
- 다중 테넌트, 서비스 계정 무인 실행

---

## 3. 기술 스택

| 항목 | 선택 | 이유 |
|---|---|---|
| 언어/런타임 | **TypeScript + Node.js** | 이 PC에 Node v25 설치됨, Python 없음. 단일 실행파일 패키징도 용이 |
| MCP SDK | `@modelcontextprotocol/sdk` | 공식 SDK, stdio·Streamable HTTP 모두 지원 |
| 스키마 검증 | `zod` | 도구 입력 스키마 정의 |
| 인증 | `@azure/msal-node` + `@azure/msal-node-extensions` | 대화형 로그인/디바이스 코드, Windows DPAPI 암호화 토큰 캐시 |
| HTTP | Node 내장 `fetch` | 의존성 최소화 |
| 파일 출력 | `exceljs` (XLSX), 내장 CSV 작성기 | 리포트 내보내기 |

---

## 4. 아키텍처

```
Claude Desktop / Claude Code
        │  stdio (JSON-RPC)
        ▼
┌──────────────────────────────────────────────┐
│ dynamics-mcp (Node)                          │
│  ├─ tools/      도구 정의 (core/support/fs/report/write)
│  ├─ guard/      읽기전용·테이블 허용목록·행 상한·PII 마스킹
│  ├─ dataverse/  Web API 클라이언트 (OData, FetchXML, 함수/액션)
│  │               └ 재시도(429 Retry-After), 페이징, 포맷값
│  ├─ metadata/   EntityDefinitions 캐시 (디스크, TTL 24h)
│  ├─ auth/       MSAL 공개 클라이언트 + 암호화 토큰 캐시
│  └─ audit/      로컬 호출 로그 (JSONL)
└──────────────────────────────────────────────┘
        │  HTTPS, Bearer (사용자 위임 토큰)
        ▼
https://<org>.crm3.dynamics.com/api/data/v9.2/
```

### 4.1 인증
- Entra ID **앱 등록 1개** (공개 클라이언트, 리디렉션 `http://localhost`)
  - API 권한: `Dynamics CRM` → `user_impersonation` (위임)
  - 관리자 동의가 필요할 수 있음 (테넌트 정책에 따라)
- 흐름: 최초 1회 브라우저 대화형 로그인 → 이후 리프레시 토큰으로 무인 갱신
  - 브라우저를 못 띄우는 환경이면 디바이스 코드 흐름으로 폴백
- 스코프: `https://<org>.crm3.dynamics.com/.default`
- 토큰 캐시: `%LOCALAPPDATA%\dynamics-mcp\token-cache.bin` (DPAPI 암호화)
- 비밀번호·클라이언트 시크릿은 저장하지 않음
- 프로토타입 단계에서 앱 등록이 늦어지면, Microsoft 문서 샘플용 공개 클라이언트 ID 사용 가능 여부를 테넌트 정책으로 확인 (운영에선 자체 앱 등록 사용)

### 4.2 다중 환경
- `config.json`의 `environments` 목록 (예: `covfs-dev`, `covfs-prod`)
- 모든 도구에 선택적 `env` 파라미터, 기본값은 `defaultEnvironment`
- 환경별로 `readOnly`, `allowedTables` 개별 설정 → **prod는 항상 읽기 전용** 권장

---

## 5. 도구(Tool) 설계

명명 규칙: `<영역>_<동사>`. 모든 응답은 `{ summary, data, truncated, nextPageToken? }` 형태의 간결한 JSON. 옵션셋·룩업은 `@OData.Community.Display.V1.FormattedValue`로 사람이 읽는 값을 함께 반환.

### 5.1 Core — 탐색과 조회 (Phase 1)

| 도구 | 입력 | 동작 | 공식 서버 대응 |
|---|---|---|---|
| `dv_whoami` | env? | WhoAmI + 사용자 이름, 사업부, 환경 URL/버전 | – |
| `dv_find_tables` | keyword | EntityDefinitions에서 논리명/표시명/설명 검색 (캐시) | `search` |
| `dv_describe_table` | table, includeRelationships? | 컬럼(타입, 필수, 옵션셋 값), 기본키/기본 이름 컬럼, 관계 | `describe` |
| `dv_query` | table, select[], filter?, orderBy?, expand?, top? | OData 조회, 자동 페이징(상한까지) | `read_query` |
| `dv_fetchxml` | fetchXml | FetchXML 실행 — **조인(link-entity), 집계, group by 지원** | (없음) |
| `dv_get_record` | table, id, select? | 단일 레코드 + 포맷값 | `describe` |
| `dv_count` | table, filter? | 빠른 건수 (`$count` / `RetrieveTotalRecordCount`) | – |
| `dv_search` | text, tables? | Dataverse Search (활성화된 경우만 노출) | `search_data` |

**설계 포인트**
- `dv_query`의 `filter`는 OData 문법 그대로 받되, 테이블/컬럼명은 메타데이터 캐시로 검증 → 오타 시 "혹시 이 컬럼?" 후보 제안
- 결과 행 상한 기본 200 (설정 가능). 넘으면 `truncated: true` + "report_export를 쓰세요" 안내
- 긴 텍스트 필드는 500자로 자름

### 5.2 Support — 사용자 지원/진단 (Phase 1)

| 도구 | 입력 | 동작 |
|---|---|---|
| `support_user_profile` | user (이메일/이름/ID) | 활성 여부, 액세스 모드, 사업부, **직접 역할 + 팀 경유 역할**, 소속 팀, 최근 로그인(가능 시) |
| `support_check_access` | user, table, recordId | `RetrievePrincipalAccess`로 해당 사용자의 레코드 권한(Read/Write/Assign/Share…) + 소유자/공유 여부 → "왜 안 보이는지" 설명 |
| `support_compare_users` | userA, userB | 두 사용자의 역할·팀·사업부 차이 (되는 사람 vs 안 되는 사람) |
| `support_record_history` | table, recordId, top? | `RetrieveRecordChangeHistory` — 누가 언제 어떤 필드를 바꿨는지 (감사 활성화 필요) |
| `support_recent_failures` | sinceHours?, user? | 실패한 시스템 작업(`asyncoperation`, statuscode=31), 플러그인 추적 로그(`plugintracelog`), 실패한 Power Automate 흐름 실행 요약 |
| `support_solution_info` | name? | 설치된 솔루션/버전 (예: Maptaskr `mtrcore_*` 버전 확인) |

### 5.3 Field Service (Phase 1)

| 도구 | 입력 | 동작 |
|---|---|---|
| `fs_work_orders` | status?, territory?, account?, from?, to?, top? | 작업지시 목록 (`msdyn_workorder`) — 상태·우선순위·유형·서비스 계정·지역 |
| `fs_work_order_detail` | workOrder (번호 또는 ID) | 작업지시 + 인시던트, 제품/서비스, 서비스 작업, **예약(bookings)**, 최근 노트 한 번에 |
| `fs_resource_schedule` | resource, from, to | 리소스(기술자)의 예약 일정 (`bookableresourcebooking`) + 상태 |
| `fs_unscheduled` | territory?, priority? | 미배정 작업지시 / 요구사항(`msdyn_resourcerequirement`) |

### 5.4 Report (Phase 1)

| 도구 | 입력 | 동작 |
|---|---|---|
| `report_export` | fetchXml 또는 query, format (csv/xlsx), fileName? | 전체 페이지를 받아 `./reports/` 에 저장. **AI에는 파일 경로 + 건수 + 컬럼 + 상위 10행만 반환** (토큰 절약·데이터 노출 최소화) |
| `report_aggregate` | table, groupBy[], measures[] (count/sum/avg/min/max), filter?, dateGrouping? (day/week/month/quarter/year) | 구조화된 입력 → 집계 FetchXML 생성·실행. AI가 FetchXML을 직접 짜다 틀리는 걸 줄임 |

### 5.5 Write (Phase 2, 기본 비활성)

| 도구 | 동작 |
|---|---|
| `dv_prepare_change` | 생성/수정 내용을 받아 **검증 + 변경 전/후 diff 미리보기**만 반환, 10분 유효한 `changeToken` 발급 |
| `dv_apply_change` | `changeToken`으로만 실행 (미리보기 없이 쓰기 불가) |

- `readOnly: false`인 환경에서만 노출
- 삭제·스키마 변경 도구는 만들지 않음
- 모든 쓰기는 감사 로그에 기록

### 5.6 MCP Prompts / Resources

**Prompts** (슬래시 메뉴에서 선택하는 재사용 시나리오)
- `troubleshoot-visibility`: "사용자 X가 레코드 Y를 못 봄" → profile → check_access → compare_users 순서 안내
- `monthly-report`: 테이블·기간 받아 report_aggregate → report_export → 요약
- `fs-daily-briefing`: 오늘 미배정/지연 작업지시, 기술자별 일정

**Resources**
- `dataverse://{env}/tables` — 테이블 목록 (캐시)
- `dataverse://{env}/tables/{name}` — 테이블 스키마

---

## 6. 안전장치 (Guard)

| 항목 | 기본값 | 설명 |
|---|---|---|
| 읽기 전용 | `true` | 쓰기 도구 자체를 등록하지 않음 |
| 테이블 허용/차단 목록 | 차단: `systemuser`의 민감 컬럼 등 | 환경별 설정 |
| 행 상한 | 200 (응답), 50,000 (export) | 초과 시 잘림 표시 |
| 컬럼 마스킹 | 옵션 | 이메일·전화 등 지정 컬럼을 `***`로 마스킹해서 AI에 전달 |
| 요청 제한 | 429 시 `Retry-After` 준수, 최대 3회 | Dataverse 서비스 보호 한도(사용자당 5분 6,000요청 등) 대응 |
| 타임아웃 | 30초/요청 | |
| 감사 로그 | `logs/audit-YYYYMMDD.jsonl` | 도구명, 파라미터, 건수, 소요시간 (데이터 본문 제외) |

> 권한의 최종 판단은 Dataverse 보안 역할에 맡긴다. 이 서버의 Guard는 **AI의 실수를 줄이는 보조 장치**이지 보안 경계가 아니다.

---

## 7. 프로젝트 구조

```
DynamicsMCP/
├─ package.json
├─ tsconfig.json
├─ config.example.json        # 환경 URL, 테넌트/클라이언트 ID, 가드 설정
├─ src/
│  ├─ index.ts                # 서버 부트스트랩 (stdio)
│  ├─ config.ts
│  ├─ auth/msal.ts
│  ├─ dataverse/client.ts     # fetch 래퍼: 재시도, 페이징, 포맷값 헤더
│  ├─ dataverse/fetchxml.ts   # 집계 FetchXML 빌더
│  ├─ metadata/cache.ts
│  ├─ guard/index.ts
│  ├─ audit/log.ts
│  └─ tools/
│     ├─ core.ts
│     ├─ support.ts
│     ├─ fieldservice.ts
│     ├─ report.ts
│     └─ write.ts
├─ reports/                   # export 출력 (gitignore)
└─ logs/                      # 감사 로그 (gitignore)
```

### 7.1 Claude 연결 설정

Claude Code:
```bash
claude mcp add dynamics -- node C:/Projects/DynamicsMCP/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "dynamics": {
      "command": "node",
      "args": ["C:/Projects/DynamicsMCP/dist/index.js"]
    }
  }
}
```

---

## 8. 구현 단계

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **0. 준비** | Entra 앱 등록, `config.json` 작성 | 브라우저 로그인 후 `dv_whoami` 성공 |
| **1. Core** | dv_* 도구, 메타데이터 캐시, 가드, 감사 로그 | "계정 테이블 설명해줘", "이번 달 생성된 케이스 수" 동작 |
| **2. Support + FS** | support_*, fs_* 도구 | 실제 사용자 1명으로 권한 진단 시나리오 통과 |
| **3. Report** | report_export, report_aggregate, prompts | 월간 리포트 XLSX 생성 |
| **4. Write (선택)** | prepare/apply 2단계 쓰기 | dev 환경에서만 검증 |
| **5. 원격화 (선택)** | Streamable HTTP + OAuth, Azure 배포 | claude.ai 웹 커스텀 커넥터로 연결 |

---

## 9. 공식 Dataverse MCP와 비교

| | 공식 Dataverse MCP | 이 서버 |
|---|---|---|
| 비용 | Copilot Credit (Premium/M365 Copilot 면제) | 없음 (일반 Web API) |
| 관리자 작업 | 테넌트 동의 + PPAC 환경별 MCP 활성화·클라이언트 허용 | 앱 등록 1개 |
| 조인/집계 | ✗ (`read_query` SQL 제약) | ✓ FetchXML |
| 사용자 지원 진단 | ✗ | ✓ 역할/팀/권한/감사/실패 작업 |
| Field Service 특화 | ✗ | ✓ |
| 대용량 결과 | AI 컨텍스트로 전달 (잘림) | 로컬 파일로 저장 후 요약 |
| 스키마 변경 | ✓ | ✗ (의도적 제외) |
| 유지보수 | Microsoft | 직접 |

---

## 10. 열린 질문
1. Entra 앱 등록을 직접 할 수 있는지, IT 요청이 필요한지
2. 대상 환경: `covfs-dev` 외에 prod/test URL
3. 감사(Audit) 활성화 여부 — `support_record_history` 사용 가능성
4. Field Service에서 자주 보는 리포트/질문 예시 3~5개 (도구 입력 설계에 반영)
5. 데이터 반출 정책 확인 결과 (마스킹 기본값 결정)

## 참고 자료
- [Connect to Dataverse with MCP](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp)
- [Dataverse MCP FAQ](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp-faq)
- [Dataverse MCP preview tools](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp-preview-tools)
- [Dataverse MCP with non-Microsoft clients](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp-other-clients)
- [Dynamics 365 Sales MCP overview](https://learn.microsoft.com/en-us/dynamics365/sales/model-context-protocol-sales-overview)
- [Customer Service MCP tools overview](https://learn.microsoft.com/en-us/dynamics365/customer-service/develop/mcp-tools-overview)
- [dv-query skill (read_query SQL 제약, 2차 출처)](https://mcpservers.org/agent-skills/microsoft/dv-query)
