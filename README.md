# crmmcp

Dynamics 365 / Power Platform 개발자용 로컬 MCP 서버 — 엔터티·폼·뷰 커스터마이즈, PCF, Power Automate, Power Pages(보안·접근성 점검 포함).

- 설계서: [DESIGN.md](DESIGN.md)
- 상태: 0단계(기반) + 1단계(엔터티·컬럼·관계·선택 항목·대체 키) 구현 완료 — 실제 환경 연결 테스트 전

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

모든 `*_plan` 도구는 미리보기와 `changeToken`을 반환하며, `change_apply` 후 해당 테이블/선택 항목만 자동 게시됩니다. 수정 전 메타데이터는 `backups/`에 스냅샷으로 저장됩니다.
