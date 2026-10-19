# crmmcp

Dynamics 365 / Power Platform 개발자용 로컬 MCP 서버 — 엔터티·폼·뷰 커스터마이즈, PCF, Power Automate, Power Pages(보안·접근성 점검 포함).

- 설계서: [DESIGN.md](DESIGN.md)
- 상태: 0단계(기반) + 1단계(엔터티·컬럼·관계·선택 항목·대체 키) + 2단계(폼·뷰·웹 리소스) + 3단계(Power Pages·보안 감사) + 4단계(PCF) + 5단계(Power Automate) 구현 완료 — 실제 환경 연결 테스트 전

## 설치

```bash
cd server
npm install
npm run build
```

## Entra 앱 등록 요구사항

기존 앱을 재사용해도 되며, 다음 조건을 만족해야 합니다.

| 항목 | 값 |
|---|---|
| 플랫폼 | **Mobile and desktop applications**, 리디렉션 URI `http://localhost` |
| 공개 클라이언트 흐름 허용 | Yes (디바이스 코드 로그인 사용 시 필수) |
| API 권한 | `Dynamics CRM` → `user_impersonation` (Delegated), 필요 시 관리자 동의 |
| 클라이언트 시크릿 | 필요 없음 |

## 설정

`config.example.json`을 `config.json`으로 복사하고 `tenantId`, `clientId`, 환경 URL을 채웁니다. (`config.json`은 git에 올라가지 않습니다.)

- `readOnly: true`인 환경에서는 모든 쓰기 도구가 거부됩니다.
- 모든 변경은 환경의 `solution`(또는 `solution_set_active`로 지정한 솔루션)에 들어갑니다.

## Claude 연결

Claude Code:

```bash
claude mcp add crmmcp -- node C:/Projects/DynamicsMCP/server/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "crmmcp": { "command": "node", "args": ["C:/Projects/DynamicsMCP/server/dist/index.js"] } } }
```

첫 도구 호출 시 브라우저가 열려 로그인합니다. 토큰은 `%LOCALAPPDATA%\crmmcp\token-cache.bin`에 DPAPI로 암호화되어 저장됩니다.

## 현재 도구

| 도구 | 설명 |
|---|---|
| `env_info` | 환경·사용자·버전·작업 솔루션·쓰기 가능 여부 |
| `solution_list` / `solution_components` | 비관리 솔루션 목록 / 구성요소 |
| `solution_set_active` | 작업 솔루션 지정 |
| `solution_create_plan` | 솔루션(+퍼블리셔 `dwmcp`) 생성 계획 |
| `change_apply` / `change_list` / `change_discard` | 계획된 변경 실행·조회·취소 |
| `publish_all` | 전체 게시 |
| `dv_get` | 읽기 전용 Web API GET |
| `meta_find` / `meta_describe` | 테이블 검색 / 테이블 상세(컬럼·관계·키·선택 값) |
| `entity_plan` | 테이블 생성(기본 이름 컬럼 + 추가 컬럼) / 설정 수정 |
| `column_plan` | 컬럼 생성(text, email, url, phone, memo, integer, decimal, float, money, date, datetime, boolean, choice, multichoice, file, image) / 라벨·필수·길이·감사 수정 |
| `relationship_plan` | 1:N(조회 컬럼 생성) / N:N |
| `optionset_plan` | 글로벌 선택 항목 생성, 옵션 추가, 라벨 변경 |
| `key_plan` | 대체 키 |
| `form_list` / `form_get` | 폼 목록 / 폼 구조 트리(헤더·탭·섹션·필드·서브그리드·라이브러리·이벤트) |
| `form_create_plan` | 새 폼(Main/Quick Create/Quick View/Card) — 기존 폼 복제 또는 레이아웃 연산으로 구성 |
| `form_patch_plan` | 폼 커스터마이즈 연산: addTab, addSection, addField(본문/헤더), removeField, moveField, setFieldProps, setTabProps, setSectionProps, addSubgrid, addLibrary, addEventHandler, removeEventHandler |
| `view_list` / `view_get` | 뷰 목록 / 컬럼·정렬·필터·연결 테이블 |
| `view_create_plan` / `view_update_plan` | 뷰 생성·수정 (관련 테이블 컬럼은 `lookup.column` 표기) |
| `webresource_list` / `webresource_get` / `webresource_upsert_plan` | 웹 리소스 조회 / 로컬 파일 업로드(생성·수정) |
| `snapshot_restore_plan` | `backups/` 스냅샷으로 폼·뷰·웹 리소스 되돌리기 |
| `pages_list` | 환경의 Power Pages 사이트(향상/표준 데이터 모델)와 로컬 다운로드 여부 |
| `pages_download` | `pac pages download`로 `src/pages/`에 내려받고 변경 비교용 기준점 저장 |
| `pages_local_list` / `pages_diff` / `pages_find` | 로컬 사이트 목록·변경사항(구성요소별, 변경 줄)·텍스트 검색 |
| `pages_security_audit` | 정적 보안 감사 → `reports/pages-security-<site>-<날짜>.md` |
| `pages_upload_plan` | 업로드 전 보안 감사 자동 실행, Critical 있으면 차단 → `pac pages upload` |
| `pcf_list` | 로컬 PCF 프로젝트(`src/pcf/`) — 컨트롤 이름·버전·속성 |
| `pcf_scaffold` | `pac pcf init`(field/dataset, React/HTML) + npm install + 호환 `@types/node` 고정 |
| `pcf_build` | `npm run build` — 실패 시 파일·줄 단위 오류 |
| `pcf_test_harness` | 로컬 테스트 하네스 시작/중지/상태 (`http://localhost:8181`) |
| `pcf_push_plan` | 패치 버전 자동 증가 후 `pac pcf push`로 작업 솔루션에 배포 |
| `pcf_package` | 배포용 솔루션 zip 빌드 (관리/비관리) |
| `pcf_list_installed` | 환경에 등록된 코드 구성요소 |

| `flow_list` / `flow_get` | 솔루션 클라우드 흐름 목록(상태·트리거) / 트리거·액션 개요(분기·runAfter), 연결 참조, 검증 경고 |
| `connref_list` | 연결 참조(커넥터, 연결 설정 여부) |
| `flow_create_plan` | 정의(`{ triggers, actions }`) + 연결 매핑으로 새 흐름 생성 — **꺼진 상태로** 생성 |
| `flow_update_plan` | 정의·연결·이름 변경 — 액션 단위 추가/삭제/변경 표시, 켜진 흐름은 끄고 수정 후 다시 켬 |
| `flow_set_state_plan` | 흐름 켜기/끄기 (연결 없는 연결 참조가 있으면 켜기 거부) |
| `flow_runs` | 최근 실행 이력 (환경에 Dataverse 실행 기록이 있을 때) |

흐름 정의는 저장 전에 검증합니다: 트리거 1개, `runAfter`가 같은 범위의 액션을 가리키는지, 순환, 잘못된 상태값, 커넥터 액션의 `operationId`, 액션이 쓰는 연결이 연결 참조에 있는지. 오류 처리(runAfter Failed)가 없으면 경고합니다. 흐름 정의 스냅샷도 `snapshot_restore_plan`으로 되돌릴 수 있습니다.

폼에 PCF를 붙일 때는 `form_patch_plan`의 `bindControl` 연산을 씁니다 (`unbindControl`로 제거). 매니페스트를 읽어 속성 이름·필수 속성을 검증하고, 첫 번째 bound 속성은 기본으로 해당 필드에 연결합니다.

### Power Pages 보안 감사 규칙

| 규칙 | 심각도 | 내용 |
|---|---|---|
| PP-TP-01 | Critical/High | 익명 웹 역할 + Global 범위 읽기 (민감 테이블이면 Critical) |
| PP-TP-02 | Critical | 익명 웹 역할에 생성/수정/삭제/추가 권한 |
| PP-TP-03 | High (공개 가입 시 Critical) | 인증 사용자 + Global 범위 수정/삭제 |
| PP-TP-04 / 05 | Medium | 웹 역할 없는 권한 / 부모 없는 Parent 범위 |
| PP-API-01 | Critical | Web API 활성 + 익명 읽기 권한 |
| PP-API-02 | High/Medium | `Webapi/<table>/fields` 미설정 또는 `*` |
| PP-AUTH-01 | Medium | 공개 가입(OpenRegistrationEnabled) |
| PP-HDR-01~03 | Medium/Low | CSP 없음·약함, CORS `*`, 클릭재킹 보호 없음 |
| PP-SEC-01 / 02 | High | 코드의 하드코딩된 키·토큰 / 사이트 설정의 평문 비밀값 |
| PP-FORM-01 / PP-LIST-01 | High/Medium | 테이블 권한을 적용하지 않는 기본 폼 / 리스트 |
| PP-PAGE-01 | Medium | 관리용으로 보이는 페이지에 페이지 권한 없음 |
| PP-LIQ-01 / 02, PP-JS-01 | Info/Medium/Low | Liquid FetchXML, 이스케이프 없는 요청 파라미터 출력, URL 값의 innerHTML |

민감 테이블 기본 목록은 `server/src/pages/audit.ts`에 있고, `config.json`의 `pages.sensitiveTables`로 추가할 수 있습니다. 다운로드한 사이트(`src/pages/`)와 리포트(`reports/`)는 비밀값이 섞일 수 있어 git에 올리지 않습니다.

> Power Pages 도구는 PAC CLI 인증 프로필이 필요합니다. 처음 한 번 터미널에서 `pac auth create --environment <환경 URL>`을 실행하세요.

모든 `*_plan` 도구는 미리보기와 `changeToken`을 반환하며, `change_apply` 후 변경된 구성요소만 자동 게시됩니다. 수정 전 상태는 `backups/`에 스냅샷으로 저장됩니다.
