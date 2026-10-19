# crmmcp — Dynamics 365 / Power Platform 개발자용 로컬 MCP 서버 설계서 (v2)

- 작성일: 2026-10-18 (v1: 2026-10-15, 리포트/지원 중심 → v2: 커스터마이징·개발 중심으로 재설계)
- 사용자: 본인 1명, 로컬 PC (Claude Code / Claude Desktop)
- 대상: Dynamics 365 Online (Dataverse, `*.crm3.dynamics.com`), Power Pages, Power Automate

## 0. 요구사항

| # | 작업 | 우선순위 |
|---|---|---|
| R1 | 엔터티(테이블)·컬럼·관계·옵션셋 생성/수정 | 필수 |
| R2 | 폼·뷰 생성 | 필수 |
| R3 | 폼 커스터마이즈 (탭/섹션/필드, 스크립트, 컨트롤) | 필수 |
| R4 | PCF 컨트롤 개발 | 필수 |
| R5 | Power Automate 클라우드 흐름 생성/수정 | 필수 |
| R6 | Power Pages 커스터마이즈 | 필수 |
| R7 | Power Pages 보안 점검 | 필수 |
| R8 | 접근성 점검 | 선택 |

---

## 1. 리서치 요약 — 이미 있는 것들

### 1.1 Microsoft 공식 도구 현황

| 도구 | 형태 | 커버 범위 | 우리에게 주는 의미 |
|---|---|---|---|
| **Dataverse MCP Server** (`/api/mcp`) | 원격 MCP | 레코드 CRUD, `read_query`(SQL 제약), 테이블 생성/수정/삭제 | 폼·뷰·흐름·Pages 미지원. 외부 클라이언트는 Copilot Credit 과금 |
| **microsoft/Dataverse-skills** | Claude Code 플러그인 (스킬) | `dv-metadata`(테이블·컬럼·관계·**폼·뷰**), `dv-solution`, `dv-security`, `dv-admin` 등 | 기능은 R1·R2와 겹침. 단 **Dataverse MCP + Python SDK + Dataverse CLI에 의존** |
| **microsoft/power-platform-skills** | Claude Code 플러그인 마켓 | `pcf`(스캐폴드→게이트→PAC 배포→검증, 프리뷰), `model-apps`(/app-builder), `power-pages`(**코드 사이트/SPA** 생성·배포, `scan-site` 보안 스캔), `power-automate`(**FlowAgent MCP** 경유) | PCF·Pages·흐름 노하우 참고 가치 큼. 흐름은 Microsoft MCP 의존 |
| **PAC CLI** (설치됨: 1.39.3) | CLI | `pac solution`, `pac pcf`, `pac pages download/upload`, `pac auth` | R4·R6의 실제 빌드/배포 엔진으로 그대로 사용 |
| Dataverse Web API | REST | 메타데이터(EntityDefinitions), `systemform`, `savedquery`, `workflow`(category=5 흐름), `webresource`, Power Pages 테이블(`powerpagecomponent` 등) | **우리 서버의 기반** |

### 1.2 결론: 왜 직접 만드나
1. Microsoft 쪽은 **흐름(FlowAgent MCP)·Dataverse(Dataverse MCP)가 Microsoft MCP 의존** → "가능하면 Microsoft MCP 미사용" 원칙과 충돌, 일부는 과금.
2. 기존 Power Pages 플러그인은 **코드 사이트(SPA) 중심**. 기존(Liquid/웹 템플릿) 사이트의 커스터마이즈·**정적 보안 감사**는 부족.
3. 폼 XML 편집, 흐름 정의 편집처럼 **망가뜨리기 쉬운 작업에 백업·diff·롤백**을 일관되게 강제하는 도구가 없음.
4. 단, 바퀴를 다시 만들지는 않는다: **빌드·배포는 PAC CLI**, 코드 편집은 **Claude Code 기본 기능**, 노하우는 **스킬 문서**로 둔다. MCP 서버는 "Dataverse에 안전하게 쓰는 일"에 집중.

---

## 2. 아키텍처 — 3계층 분담

```
┌─────────────────────────── Claude Code (로컬) ───────────────────────────┐
│                                                                           │
│  ① 스킬 (.claude/skills/*)        ② crmmcp MCP 서버 (stdio)   ③ 기본 도구  │
│  - 작업 절차·체크리스트·XML 패턴    - Dataverse 메타데이터/폼/뷰  - 파일 편집 │
│  - "엔터티 만들 때 순서"            - 흐름 정의 CRUD             - npm, git │
│  - "PCF 개발 루프"                  - Pages 다운로드/업로드/감사  - 터미널   │
│  - "Pages 보안 체크리스트"          - 백업·diff·게시·롤백          │        │
│                                     - PAC CLI 래핑                 │        │
└──────────────────────────────────────┬────────────────────────────┴───────┘
                                       │ HTTPS (사용자 위임 토큰) / pac
                                       ▼
                 Dataverse Web API  ·  PAC CLI  ·  Power Pages 사이트(라이브 URL)
```

| 계층 | 담당 | 예 |
|---|---|---|
| ① 스킬 | **무엇을 어떤 순서로** — 지식·절차 | 폼 XML 구조, 흐름 정의 스키마 예시, 보안 규칙 근거 |
| ② MCP | **Dataverse에 쓰는 모든 것** — 검증·백업·게시를 강제 | `entity_create`, `form_patch`, `flow_update` |
| ③ 기본 도구 | **로컬 코드** — PCF TypeScript, Liquid/CSS/JS 편집, 빌드 | PCF `index.ts` 수정, `npm run build` |

---

## 3. 핵심 원칙: 안전한 변경 파이프라인

모든 쓰기 도구는 같은 파이프라인을 탄다.

```
 plan(미리보기) ──► 사용자 확인 ──► apply ──► publish ──► verify
    │                                 │
    └─ 현재 상태 스냅샷 → backups/     └─ 실패 시 스냅샷으로 rollback
```

| 규칙 | 내용 |
|---|---|
| **환경 프로필** | `dev`만 쓰기 허용. `test`/`prod`는 읽기 전용 (쓰기 도구가 아예 등록되지 않음). 프로필은 `config.json` |
| **솔루션 강제** | 모든 생성/수정은 지정한 **비관리 솔루션**에 포함 (`MSCRM.SolutionUniqueName` 헤더 또는 `AddSolutionComponent`). 기본 솔루션에 흩어지지 않음 |
| **퍼블리셔 접두사** | 새 스키마 이름에 퍼블리셔 접두사 자동 적용·검증 (예: `cov_`) |
| **2단계 쓰기** | `*_plan` → diff + `changeToken`(10분 유효) 반환, `*_apply`는 토큰으로만 실행 |
| **스냅샷** | 변경 전 원본(폼 XML, 뷰 FetchXML/LayoutXML, 흐름 clientdata, Pages 파일)을 `backups/<날짜>/<컴포넌트>`에 저장 → 이 폴더는 git으로 이력 관리 |
| **게시** | 변경된 컴포넌트만 `PublishXml`로 게시 (전체 게시는 별도 도구) |
| **삭제 없음 (1차)** | 테이블·컬럼·폼·흐름 삭제 도구는 만들지 않음. 필요 시 UI에서 |
| **감사 로그** | `logs/audit-YYYYMMDD.jsonl` — 도구, 대상, 솔루션, 결과 |

---

## 4. 도구 설계

명명 규칙 `<영역>_<동사>`. 모든 도구에 선택적 `env`(기본 `dev`). 쓰기 도구는 `plan`/`apply` 쌍.

### 4.0 공통 / 솔루션

| 도구 | 동작 |
|---|---|
| `env_info` | 현재 환경, 사용자, 기본 솔루션·퍼블리셔 접두사, 읽기전용 여부 |
| `solution_list` / `solution_components` | 비관리 솔루션 목록, 솔루션 내 구성요소 |
| `solution_set_active` | 이후 변경이 들어갈 작업 솔루션 지정 |
| `solution_export` | 솔루션 내보내기 → `pac solution unpack`으로 `src/solutions/<name>`에 풀어 git diff 가능하게 (백업 겸 소스 관리) |
| `publish` | 지정 컴포넌트 게시 / `publish_all` |
| `rollback` | `backups/`의 스냅샷으로 되돌리기 (폼·뷰·흐름·웹리소스) |

### 4.1 R1 — 엔터티·컬럼·관계

| 도구 | 동작 | API |
|---|---|---|
| `meta_find` | 테이블/컬럼 검색 (캐시) | `EntityDefinitions` |
| `meta_describe` | 테이블 상세: 컬럼(타입·필수·옵션값), 관계, 키, 폼·뷰 목록 | 〃 |
| `entity_plan` / `entity_apply` | 테이블 생성·수정 (표시명, 복수형, 소유권 User/Org, 활동/노트 활성화, 감사, 기본 이름 컬럼) | `POST/PUT EntityDefinitions` |
| `column_plan` / `column_apply` | 컬럼 생성·수정 — 문자열/메모/정수/소수/통화/날짜/불린/선택(로컬·글로벌)/다중선택/조회/파일/이미지, 수식·롤업은 정의 문자열 | `…/Attributes` |
| `relationship_plan` / `relationship_apply` | 1:N(조회 컬럼 포함), N:N, 연계 동작(cascade) | `RelationshipDefinitions` |
| `optionset_plan` / `optionset_apply` | 글로벌 선택 집합 생성, 옵션 추가/라벨 변경 | `GlobalOptionSetDefinitions`, `InsertOptionValue` |
| `key_plan` / `key_apply` | 대체 키 | `…/Keys` |

- 입력은 사람 친화 스펙 (예: `{ "name": "Inspection Date", "type": "date", "required": true }`) → 서버가 메타데이터 JSON(`@odata.type`, Label 구조 등)으로 변환
- 라벨 수정 시 `MSCRM.MergeLabels: true`로 다른 언어 라벨 보존
- `plan` 단계에서 이름 충돌, 접두사, 예약어, 최대 길이, 타입 변경 불가 여부 검증

### 4.2 R2 — 폼·뷰 생성

| 도구 | 동작 | API |
|---|---|---|
| `form_list` / `form_get` | 테이블의 폼 목록, 폼 구조를 **읽기 쉬운 트리**(탭→섹션→필드)와 원본 XML로 반환 | `systemforms` |
| `form_create_plan` / `_apply` | 새 폼 (Main/Quick Create/Quick View/Card), 레이아웃 스펙 또는 기존 폼 복제 | `POST systemforms` (formxml) |
| `view_list` / `view_get` | 뷰 목록, 컬럼·정렬·필터를 구조화해서 반환 | `savedqueries` |
| `view_create_plan` / `_apply` | 새 뷰: 컬럼(너비), 정렬, 필터, 연결 테이블 컬럼 | `POST savedqueries` (fetchxml + layoutxml 자동 생성) |
| `view_update_plan` / `_apply` | 컬럼 추가/제거/순서/너비, 필터·정렬 변경 | `PATCH savedqueries` |

### 4.3 R3 — 폼 커스터마이즈

폼 XML을 AI가 통째로 다시 쓰지 않게 **패치 연산** 방식으로 설계 (실수 범위 최소화).

| 도구 | 동작 |
|---|---|
| `form_patch_plan` / `_apply` | 연산 배열을 받아 폼 XML에 적용 → diff 미리보기 |
| `webresource_list` / `webresource_get` | JS/HTML/CSS/이미지 웹 리소스 조회 |
| `webresource_upsert_plan` / `_apply` | 로컬 파일 → 웹 리소스 생성/수정 (폼 스크립트, 아이콘) |

`form_patch` 연산 종류:

| 연산 | 예 |
|---|---|
| `addTab` / `addSection` | `{ op:"addSection", tab:"General", label:"Inspection", columns:2 }` |
| `addField` / `removeField` / `moveField` | `{ op:"addField", section:"Inspection", field:"cov_inspectiondate", after:"cov_status" }` |
| `setFieldProps` | 라벨, 필수(폼 레벨), 읽기전용, 숨김, 라벨 표시 여부 |
| `setTabProps` / `setSectionProps` | 표시/숨김, 라벨, 기본 펼침 |
| `addSubgrid` | 관련 테이블·뷰·행 수 |
| `addLibrary` / `addEventHandler` | 폼 OnLoad/OnSave, 필드 OnChange에 웹 리소스 함수 연결 (`executionContext` 전달) |
| `bindControl` | 필드에 **PCF 컨트롤** 바인딩 (웹/폰/태블릿, 속성 매핑) — R4와 연결 |
| `setHeaderFields` | 헤더 필드 |

- `plan` 단계 검증: 필드가 테이블에 존재하는지, 이미 폼에 있는지, 라이브러리가 존재하는지, ID 중복
- 비즈니스 규칙은 1차 범위 밖 (UI 권장)

### 4.4 R4 — PCF 개발

PCF는 대부분 로컬 코드 작업이라 Claude Code 기본 기능 + PAC CLI가 주역. MCP는 **반복 작업 단축과 Dataverse 연결**만 담당.

| 도구 | 동작 |
|---|---|
| `pcf_scaffold` | `pac pcf init` (field/dataset, React/표준) + `npm install`, 폴더 `src/pcf/<name>` |
| `pcf_build` | `npm run build` + 오류 요약 |
| `pcf_test_harness` | `npm start watch` 백그라운드 실행, 로컬 테스트 하네스 URL 반환 |
| `pcf_push` (dev 전용) | `pac pcf push --publisher-prefix <prefix>` → 임시 솔루션 대신 작업 솔루션에 추가 옵션 |
| `pcf_package` | `pac solution init/add-reference` + `dotnet build` → 배포용 솔루션 zip |
| `pcf_list_installed` | 환경에 등록된 사용자 정의 컨트롤 목록 (`customcontrols`) |
| (연계) `form_patch: bindControl` | 만든 컨트롤을 폼 필드에 바인딩 |

스킬 `pcf-dev-loop`: 매니페스트 속성 설계 → `updateView`/`getOutputs` 패턴 → 하네스 테스트 → push → 폼 바인딩 → 확인 체크리스트.

### 4.5 R5 — Power Automate (솔루션 인식 클라우드 흐름)

Dataverse `workflow` 테이블(`category = 5`)의 `clientdata`(흐름 정의 JSON 문자열)를 직접 다룬다. **솔루션 안의 흐름만** 지원 (My Flows는 API 미지원).

| 도구 | 동작 |
|---|---|
| `flow_list` | 솔루션/전체 흐름: 이름, 상태(켜짐/꺼짐), 트리거 종류, 소유자, 수정일 |
| `flow_get` | 정의를 **트리거·액션 트리 요약** + 원본 JSON으로 반환, 연결 참조 목록 |
| `flow_create_plan` / `_apply` | 정의 JSON + 연결 참조로 새 흐름 생성 (기본 **꺼짐** 상태로 생성) |
| `flow_update_plan` / `_apply` | 정의 수정 — 원본 스냅샷 + 액션 단위 diff |
| `flow_set_state` | 켜기/끄기 (`statecode`) |
| `connref_list` | 연결 참조(`connectionreference`)와 연결 상태 — 새 흐름에 재사용 |
| `flow_runs` | 최근 실행 이력·실패 액션 (Dataverse `flowrun` 테이블 사용 가능 시. 불가하면 1차 범위 외로 표시) |

- `plan` 검증: JSON 스키마(`$schema`, `triggers`, `actions`), `runAfter` 참조 무결성, 사용 커넥터에 대응하는 연결 참조 존재 여부
- 스킬 `flow-patterns`: Dataverse 트리거(행 추가/수정), 조건, Apply to each, 오류 처리 범위(Scope + runAfter Failed) 예시 정의

### 4.6 R6 — Power Pages 커스터마이즈

PAC CLI의 `pac pages download/upload`로 사이트를 **로컬 폴더(YAML + Liquid/HTML/CSS/JS)**로 내려받아 Claude Code가 파일을 직접 편집하는 방식.

| 도구 | 동작 |
|---|---|
| `pages_list` | 환경의 사이트 목록, 데이터 모델(표준/향상), 사이트 URL |
| `pages_download` | `pac pages download --modelVersion 2` → `src/pages/<site>`, 다운로드 직후 git 커밋(기준점) |
| `pages_diff` | 로컬 변경사항 요약 (웹 페이지/템플릿/스니펫/사이트 설정/테이블 권한별) |
| `pages_upload` (dev 전용) | 업로드 전 **R7 정적 보안 감사 자동 실행 → Critical 있으면 차단** → `pac pages upload` |
| `pages_clear_cache` | 업로드 후 캐시 갱신 안내/실행 |
| `pages_find` | 사이트 구성요소 검색 (예: "Contact 테이블을 쓰는 곳") |

- 코드 사이트(SPA)는 Microsoft `power-pages` 플러그인과 겹치므로 1차 범위에서는 `pac pages upload-code-site` 래핑만

### 4.7 R7 — Power Pages 보안 점검

두 단계: **정적 감사**(다운로드한 사이트 파일 분석, 안전·빠름) + **라이브 점검**(실제 URL, 본인 사이트에만).

#### 정적 감사 `pages_security_audit` 규칙

| ID | 심각도 | 점검 |
|---|---|---|
| PP-TP-01 | Critical | **익명(Anonymous Users) 웹 역할**에 Global 범위 테이블 권한 |
| PP-TP-02 | Critical | 익명 역할에 Create/Write/Delete/Append 권한 |
| PP-TP-03 | High | 인증 사용자에 Global 범위 + Write/Delete |
| PP-TP-04 | Medium | 테이블 권한이 어떤 웹 역할에도 연결 안 됨 / 사용 안 되는 권한 |
| PP-API-01 | Critical | `Webapi/<table>/enabled = true` 이면서 익명 읽기 권한 존재 |
| PP-API-02 | High | `Webapi/<table>/fields = *` (모든 컬럼 노출) |
| PP-API-03 | Medium | 민감 컬럼(이메일·전화·주민번호류·금액 등 설정 가능 목록) Web API 노출 |
| PP-LIQ-01 | High | Liquid `{% fetchxml %}`에서 테이블 권한 우회 가능 패턴 / 민감 테이블 조회 |
| PP-LIQ-02 | Medium | 사용자 입력(`request.params`)을 이스케이프 없이 출력 (XSS) |
| PP-FORM-01 | High | 익명 접근 가능 페이지의 기본/다단계 폼이 Insert/Edit 모드 + 민감 컬럼 |
| PP-LIST-01 | Medium | 리스트(엔터티 목록)가 민감 컬럼 표시 또는 테이블 권한 비활성 |
| PP-PAGE-01 | Medium | 관리/내부용으로 보이는 페이지에 페이지 권한(웹 역할 제한) 없음 |
| PP-AUTH-01 | Medium | `Authentication/Registration/OpenRegistrationEnabled = true` (공개 가입) |
| PP-AUTH-02 | Info | Entra ID 외 외부 ID 공급자 사용 |
| PP-HDR-01 | Medium | `HTTP/Content-Security-Policy` 미설정 / `unsafe-inline`·`*` 포함 |
| PP-HDR-02 | Medium | `HTTP/Access-Control-Allow-Origin = *` |
| PP-HDR-03 | Low | `X-Frame-Options`/`frame-ancestors` 미설정 |
| PP-FILE-01 | Medium | 첨부 업로드 허용 확장자/크기 제한 없음 |
| PP-SEC-01 | High | 템플릿·JS·사이트 설정에 하드코딩된 키/토큰/비밀번호 패턴 |

출력: 심각도별 표 + 근거 파일 경로·라인 + 수정 방법. `reports/pages-security-<site>-<날짜>.md`

#### 라이브 점검 `pages_security_live` (본인 소유 사이트, 확인 후 실행)
- 응답 헤더 실검사 (CSP, HSTS, X-Frame-Options, 쿠키 플래그)
- **로그인 없이** `/_api/<table>` 호출해 실제 익명 노출 여부 확인 (읽기 GET만)
- WAF 활성 여부(가능 시), 사이트 가시성(공개/비공개)
- Microsoft 공식 **딥 스캔**(Power Pages 보안 스캔)은 API 인터페이스가 공개 문서로 확인되지 않아 1차는 "디자인 스튜디오에서 실행" 안내 + 결과 병합은 추후

### 4.8 R8 — 접근성 점검 (선택)

| 도구 | 동작 |
|---|---|
| `a11y_scan` | Playwright(헤드리스 Chromium) + **axe-core**로 지정 URL들 검사 → WCAG 2.1 AA 위반 목록(규칙, 영향도, 요소 셀렉터, 수정 가이드) |
| `a11y_static` | 다운로드한 Pages 템플릿 정적 검사: `img` alt 누락, 폼 라벨 연결, 헤딩 순서, 대비가 의심되는 CSS 색 조합 |
| 출력 | `reports/a11y-<site>-<날짜>.md` (+ 원본 JSON) |

- 인증이 필요한 페이지는 1차에서 제외 (공개 페이지만)
- 모델 기반 앱 폼은 Microsoft가 접근성을 관리하므로 대상 외

### 4.9 (부록) v1의 조회/지원 도구
v1 설계의 `dv_query`, `dv_fetchxml`, `support_user_profile`, `support_check_access` 등은 **읽기 전용 보조 모듈**로 유지 (커스터마이징 중 데이터 확인·권한 디버깅에 유용). 구현 우선순위는 낮춤.

---

## 5. 스킬 (`.claude/skills/`)

| 스킬 | 내용 |
|---|---|
| `crm-customize` | 엔터티→컬럼→관계→폼→뷰→게시 순서, 명명 규칙, 솔루션·접두사 규칙 |
| `formxml-patterns` | 폼 XML 구조, 컨트롤 classid, 이벤트 핸들러, 흔한 오류 |
| `pcf-dev-loop` | PCF 개발 루프 (4.4) |
| `flow-patterns` | 흐름 정의 JSON 예시·검증 규칙 (4.5) |
| `pages-customize` | Pages 폴더 구조, Liquid 패턴, 업로드 절차 |
| `pages-security` | 4.7 규칙의 근거와 수정 방법 |

---

## 6. 기술 스택 / 환경

| 항목 | 선택 | 현재 PC |
|---|---|---|
| 런타임 | TypeScript + Node.js | Node v25.8.1 ✅ |
| MCP | `@modelcontextprotocol/sdk` (stdio) | |
| 인증 (Web API) | `@azure/msal-node` 대화형 로그인 + DPAPI 토큰 캐시 | Entra 앱 등록 필요 |
| 인증 (PAC) | `pac auth create --environment <url>` (별도 1회 로그인) | |
| PAC CLI | 빌드·배포 엔진 | 1.39.3 ✅ (업데이트 권장) |
| .NET SDK | PCF 솔루션 패키징 | 8.0.426 ✅ |
| XML | `fast-xml-parser` 또는 `@xmldom/xmldom` (폼/뷰 XML 패치, 원본 서식 보존) | |
| 접근성 | `playwright` + `@axe-core/playwright` | 설치 필요 |
| 버전 관리 | git — `backups/`, `src/solutions/`, `src/pages/`, `src/pcf/` | git 2.53 ✅ |

---

## 7. 프로젝트 구조

```
crmmcp/
├─ DESIGN.md
├─ config.example.json          # 환경 프로필(dev/test/prod), 솔루션, 접두사, 민감 컬럼 목록
├─ .claude/skills/              # 5장 스킬
├─ server/                      # MCP 서버
│  ├─ src/index.ts
│  ├─ src/auth/  src/dataverse/  src/pac/
│  ├─ src/pipeline/             # plan/apply, changeToken, snapshot, publish, rollback
│  ├─ src/tools/                # solution, meta, form, view, webresource, pcf, flow, pages, a11y
│  └─ src/audit/pages-rules/    # R7 규칙 (규칙당 1파일)
├─ src/                         # 작업 산출물 (git 관리)
│  ├─ solutions/<name>/         # unpack된 솔루션
│  ├─ pcf/<control>/
│  └─ pages/<site>/
├─ backups/                     # 변경 전 스냅샷
├─ reports/                     # 보안·접근성 리포트
└─ logs/
```

---

## 8. 구현 단계

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **0. 기반** | 인증, 환경 프로필, 솔루션 지정, plan/apply 파이프라인, 스냅샷, 감사 로그, `env_info` | dev에서 `env_info`, `solution_list` 동작 |
| **1. R1** | meta/entity/column/relationship/optionset | 테스트 솔루션에 테이블+컬럼 5종+1:N 관계 생성·게시 |
| **2. R2·R3** | form/view/webresource, form_patch 연산 | 폼에 섹션·필드·OnChange 스크립트 추가, 뷰 생성 |
| **3. R6·R7** | pages download/diff/upload, 정적 보안 감사 | 실제 dev 사이트 감사 리포트 생성, Critical 시 업로드 차단 확인 |
| **4. R4** | pcf 도구 + bindControl | 샘플 PCF를 폼 필드에 바인딩해 동작 |
| **5. R5** | flow 도구 | 솔루션 흐름 조회·수정·켜기/끄기, 신규 생성(꺼짐) |
| **6. R8·라이브 점검** | a11y_scan, pages_security_live | 공개 페이지 접근성 리포트 |

> 우선순위 근거: 사용 빈도·위험도가 높은 R1~R3를 먼저, Pages(R6·R7)는 감사가 독립적으로 가치가 커서 다음, PCF·흐름은 PAC/기존 도구로 당장 일부 대체 가능하므로 뒤로.

---

## 9. 열린 질문
1. Entra 앱 등록 가능 여부 (Web API용 공개 클라이언트, `Dynamics CRM / user_impersonation`)
2. dev 환경 외 test/prod URL, 그리고 작업용 비관리 솔루션 이름·퍼블리셔 접두사
3. Power Pages 사이트: 표준/향상 데이터 모델 여부, 사이트 URL
4. 흐름 실행 이력(`flowrun`) 테이블이 환경에 있는지 — `flow_runs` 범위 결정
5. 민감 컬럼 기준 (보안 감사 PP-API-03 등에 사용)

## 참고 자료
- [Dataverse MCP](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp) · [FAQ](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp-faq) · [non-Microsoft clients](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/data-platform-mcp-other-clients)
- [microsoft/Dataverse-skills](https://github.com/microsoft/dataverse-skills) · [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
- [Power Pages plugin for Claude Code](https://learn.microsoft.com/en-us/power-pages/configure/create-code-site-using-claude-code)
- [Power Pages & PAC CLI](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli) · [CLI tutorial](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-tutorial)
- [Power Pages admin center security](https://learn.microsoft.com/en-us/power-pages/admin/admin-center-security)
- [Manage flows with code (Dataverse Web API)](https://learn.microsoft.com/en-us/power-automate/manage-flows-with-code)
- [Customer Service MCP tools overview](https://learn.microsoft.com/en-us/dynamics365/customer-service/develop/mcp-tools-overview)
