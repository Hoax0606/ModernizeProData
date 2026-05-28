---
title: "ModernizeProData 사용자 매뉴얼"
subtitle: "User Manual · Enterprise Edition"
author: "KS Info System Co., Ltd."
date: "2026"
lang: ko
---

## 목차

1. 머리말
2. 시작하기
3. 사이트와 프로젝트
4. Dashboard — 마이그레이션 준비도
5. Mapping — 데이터 매핑
6. Versions — 스냅샷과 승인
7. Execution — 실행과 모니터링
8. Artifacts — 산출물
9. Log Viewer — 로그 조회
10. Settings — 프로젝트 설정
11. 알림 (Notification Inbox)
12. Solution Settings — 솔루션 전역 설정
13. 부록 A. 단축키 일람
14. 부록 B. 용어집
15. 부록 C. 자주 묻는 질문
16. 부록 D. 트러블슈팅

---

## 1. 머리말

본 매뉴얼은 ModernizeProData(이하 “본 도구”)의 사용자 인터페이스를 통해 데이터 이행 작업을 수행하는 모든 작업자가 읽는 표준 안내서입니다.

본 도구는 레거시(AS-IS) 데이터베이스의 데이터를 신규(TO-BE) 데이터베이스로 안전하게 이행하기 위한 워크플로우 기반 도구이며, 다음 단계를 표준화합니다.

- 분석 (Analysis) — 양쪽 DDL 도입 및 스키마 비교
- 매핑 (Mapping) — 테이블 바인딩 및 컬럼 매핑 규칙 정의
- 리허설 (Rehearsal) — 테스트 환경에서의 반복 검증
- 승인 (Sign-off) — 매핑 스냅샷 승인
- 컷오버 (Cutover) — 운영 환경 이행 실행
- 하이퍼케어 (Hypercare) — 이행 후 안정화 모니터링

---

## 2. 시작하기

### 2.1 시스템 요구 사항

| 항목 | 최소 사양 | 권장 사양 |
|---|---|---|
| 클라이언트 OS | Windows 10 / macOS 12 / Ubuntu 20.04 | 동일 |
| 브라우저 | Chrome 110+ / Edge 110+ | 최신 안정판 |
| 화면 해상도 | 1366 × 768 | 1920 × 1080 이상 |
| 네트워크 | 사이트 내부망 접근 | 동일 |

데스크탑 설치형으로 배포된 경우 별도 브라우저 없이 단일 실행 파일로 구동됩니다.

### 2.2 로그인

1. 사이트 관리자로부터 발급받은 사용자명과 초기 비밀번호로 로그인합니다.
2. 첫 로그인 시 비밀번호 변경 화면이 나타납니다.
3. 로그인 성공 시 마지막으로 작업한 프로젝트의 Dashboard로 이동합니다.

### 2.3 화면 구성

본 도구의 화면은 좌측 **사이드바**, 상단 **탑바**, 우측 **컨텐츠 영역** 세 부분으로 구성됩니다.

- **사이드바** — 솔루션 브랜드, 사이트 전환, 프로젝트 목록(단계별 그룹), 사용자 메뉴
- **탑바** — 화면 컨텍스트 정보, 알림 벨, AS-IS / TO-BE 연결 상태 뱃지
- **컨텐츠 영역** — 선택된 탭의 본 작업 화면 (Dashboard / Mapping / Versions / Execution / Artifacts / Logs / Settings)

좌상단의 패널 토글 버튼 또는 단축키 **Ctrl + B**(Windows·Linux) / **⌘ + B**(macOS)로 사이드바를 접거나 펼 수 있습니다.

---

## 3. 사이트와 프로젝트

### 3.1 사이트 (Site)

“사이트”는 한 고객사 또는 한 데이터센터의 작업 영역을 의미합니다. 한 도구 인스턴스에 여러 사이트를 등록할 수 있으며, 각 사이트는 독립된 데이터베이스 자격증명·프로젝트 목록·환경 메타데이터를 가집니다.

사이드바 상단의 사이트 스위처 드롭다운에서 사이트를 전환합니다. 사이트 전환 시 현재 작업하던 프로젝트는 사이트 단위로 격리되므로 다른 사이트의 프로젝트는 노출되지 않습니다.

### 3.2 프로젝트 (Project)

프로젝트는 단일 마이그레이션 단위입니다. 일반적으로 도메인(예: Core Ledger, FX Treasury) 또는 시스템(예: 카드 인증)별로 분할합니다.

#### 프로젝트 단계 (Phase)

각 프로젝트는 다음 7단계 중 하나에 위치합니다.

| 단계 | 의미 | 뱃지 색상 | 현재 업무 |
|---|---|---|---|
| planning | 아이디어·구상 단계, 차분한 시작 | 연보라 | 송금허브 |
| analysis | 데이터 분석, 논리적·기술적 | 하늘파랑 | 외환 · 여신 |
| rehearsal | 반복 훈련, 에너지·진행감 | 주황 | 계정원장 |
| sign-off | 대기 중, 주의·보류 상태 | 노랑 | 수신원장 |
| cutover | 고긴장 구간, 즉각 인지 필요 | 빨강 | 인터넷뱅킹 |
| hypercare | 안정화 중, 회복·모니터링 | 연두 | 카드승인 |
| done | 종료·아카이브, 조용히 마무리 | 회색 | 총계정원장 · 무역금융 |

사이드바의 프로젝트 목록은 *In progress · Cutover · Hypercare · Completed* 세 그룹으로 자동 묶여 표시되고, 탑바의 프로젝트명 옆에는 현재 단계 뱃지가 위 색상으로 노출됩니다. 빨강(cutover) 뱃지는 *지금 운영 데이터를 다루는 중* 임을, 노랑(sign-off) 뱃지는 *리뷰어 결정 대기 중* 임을 가장 시인성 높게 환기시킵니다.

#### 프로젝트 생성

1. 사이드바 하단 **+ New project** 버튼을 클릭합니다.
2. 프로젝트 이름·도메인·설명을 입력합니다.
3. 생성 직후의 프로젝트는 빈 상태이므로, **Settings › Source / Target** 에서 DDL을 도입해야 본격 작업이 가능합니다.

#### 프로젝트 복제·삭제

프로젝트 항목 우측 메뉴(⋯)에서 다음 동작을 수행할 수 있습니다.

- **Duplicate** — 매핑 규칙·바인딩을 복사하여 신규 프로젝트 생성. 자격증명·DDL은 복사되지 않습니다.
- **Rename** — 표시 이름 변경.
- **Delete** — 프로젝트 영구 삭제. 매핑·스냅샷·실행 이력이 모두 제거되며 복구되지 않습니다.

---

## 4. Dashboard — 마이그레이션 준비도

Dashboard 탭은 현재 프로젝트의 **모든 TO-BE 테이블이 이행 가능한 상태인지**를 한눈에 보여줍니다.

### 4.1 KPI 스트립

화면 상단 6 개 KPI 카드의 의미는 다음과 같습니다.

| KPI | 의미 |
|---|---|
| TO-BE tables | 프로젝트의 전체 TO-BE 테이블 수 |
| Ready | 모든 검증을 통과한 테이블 수 |
| Review | 오류·경고·미매핑 등 사람의 확인이 필요한 테이블 수 |
| Unbound | AS-IS 소스가 한 건도 바인딩되지 않은 테이블 수 |
| Snapshot | 가장 최근 매핑 스냅샷의 버전과 상태 |
| Last run | 가장 최근 실행 결과와 실행일 |

### 4.2 테이블 목록

KPI 아래 테이블 목록은 다음 컬럼으로 구성됩니다.

| 컬럼 | 설명 |
|---|---|
| TO-BE table | 대상 테이블의 정규화된 이름 |
| AS-IS sources | 바인딩된 AS-IS 테이블 (JOIN은 ⋈, UNION은 ∪) |
| Column coverage | 매핑 완료된 컬럼 비율(`mapped/total`) 및 진행 바 |
| Issues | 오류·경고·미매핑 컬럼 수 |
| Approval | 매핑 스냅샷 승인 상태 |
| Readiness | 테이블 단위 준비도 (`ready` / `review` / `unbound`) |

`Column coverage` 분모는 사용자가 매핑해야 하는 컬럼의 수입니다. `(new in TO-BE)` 컬럼과 명시적 `drop` 처리한 컬럼은 분모에서 제외됩니다.

### 4.3 필터와 정렬

상단 필터 칩으로 `All / Ready / Review / Partial / Unbound` 중 하나를 선택할 수 있습니다. 각 컬럼 헤더 클릭 시 해당 컬럼 기준 오름차순/내림차순 정렬이 토글됩니다.

### 4.4 행 동작

- 테이블 이름 또는 행 본체 클릭 → Mapping 탭으로 이동하여 해당 테이블 디테일 표시
- 승인 칩(Approval) 클릭 → Versions 탭으로 이동
- AS-IS / TO-BE 뱃지 클릭(탑바) → Settings 의 Source / Target 섹션으로 이동

---

## 5. Mapping — 데이터 매핑

Mapping 탭은 본 도구의 핵심 작업 화면입니다. 좌측 듀얼 인벤토리에서 테이블을 선택하고, 우측 디테일에서 바인딩과 컬럼 매핑을 정의합니다.

### 5.1 듀얼 인벤토리

좌측 사이드바는 **AS-IS 트리** 와 **TO-BE 트리** 로 분할됩니다.

각 항목 옆 뱃지는 다음을 의미합니다.

- 흰색 점 — 라우팅·매핑 정보 없음
- 회색 점 — 일부 라우팅
- 녹색 점 — 모든 라우팅·매핑 완료
- 호박색 점 — 검토 필요 (오류·경고 또는 미매핑)
- ⋈ N — JOIN N개 소스로 구성된 TO-BE
- ∪ N — UNION N개 소스로 구성된 TO-BE

### 5.2 Table Binding

TO-BE 테이블을 선택하면 **Table binding** 영역이 화면 상단에 펼쳐집니다. 바인딩 카드는 어떤 AS-IS 테이블이 어떤 합성(JOIN 또는 UNION)으로 이 TO-BE 를 채우는지를 정의합니다.

#### 바인딩 추가

1. **Add source** 버튼을 클릭합니다.
2. AS-IS 인벤토리에서 후보 테이블을 선택합니다.
3. 첫 번째 소스는 자동으로 `primary` 역할을 부여받습니다.

#### 합성 모드 (JOIN / UNION)

소스가 2개 이상일 때 모드 토글이 활성화됩니다.

- **JOIN** — primary 외 나머지 소스는 `join` 역할이며, 개별 소스마다 JOIN 타입(LEFT / INNER / RIGHT / FULL)과 ON 절을 편집할 수 있습니다.
- **UNION** — 모든 소스가 `union` 역할이며, 컬럼 이름 기준으로 자동 정렬됩니다.

ON 절은 다음 형식입니다.

```
<primary alias>.<column> = <other alias>.<column>
```

#### WHERE 필터 (1:N 분할)

같은 AS-IS 테이블이 여러 TO-BE 테이블의 분할 슬라이스로 사용되는 경우, 각 TO-BE 바인딩에 WHERE 필터를 지정해 범위를 한정할 수 있습니다.

WHERE 필터가 설정된 바인딩의 헤더에는 ⚲ WHERE 뱃지가 노출되며, 동일 AS-IS 를 공유하는 다른 바인딩이 존재할 경우 *Coverage warning* 이 표시됩니다.

### 5.3 컬럼 매핑 그리드

바인딩 영역 아래의 그리드는 한 행이 한 TO-BE 컬럼에 대응합니다. 본 도구는 자동 매핑을 수행하지 않으므로 신규 프로젝트의 모든 행은 `unmapped` 상태로 시작합니다.

#### 컬럼 의미

| 컬럼 | 의미 |
|---|---|
| (헤더 없음 · 좌측 첫 칼럼) | TO-BE 컬럼이 Primary Key 일 때 🔑 아이콘이 표시됩니다 |
| Source field | 바인딩된 AS-IS 컬럼 이름 또는 매핑 전략(NULL / DEFAULT) |
| Src table | 소스 테이블 별칭 |
| Source type | AS-IS 컬럼의 자료형 |
| Target field | TO-BE 컬럼 이름 |
| Target type | TO-BE 컬럼 자료형 |
| Rule | 적용된 규칙(`passthrough` / `transform` / `null` / `default` / `unmapped`) |
| Status | 검증 결과(`ok` / `warn` / `error` / `queued`) |

#### 필터와 검색

상단 필터 칩으로 `All / Unmapped / Passthrough / Transform / Added` 를 토글합니다. 검색창에 컬럼 이름 일부를 입력하면 즉시 필터링됩니다.

### 5.4 Inspector — 컬럼 매핑 편집

그리드에서 행을 선택하면 우측 Inspector 패널이 열립니다. Inspector는 다음을 제공합니다.

- 선택 컬럼의 메타 정보 (이름·타입·PK 여부·NOT NULL 여부)
- 적용된 규칙 표시
- AS-IS 소스가 있는 경우 데이터 프로파일 미니카드(NULL 비율, 고유값, 상위 값 등)
- 변환 SQL 미리보기

#### 매핑 전략 지정

**Edit rule**(unmapped 행에서는 **Assign source**) 버튼을 누르면 단일 드롭다운 형태의 매핑 편집기가 열립니다. 다음 세 가지 전략 중 하나를 명시적으로 선택해야 합니다.

| 그룹 | 옵션 | 활성 조건 |
|---|---|---|
| AS-IS columns | 바인딩에 포함된 모든 컬럼 | 바인딩이 1개 이상일 때 |
| No source | Use NULL | TO-BE 컬럼이 nullable 일 때 |
| No source | Use DDL default | TO-BE DDL 에 DEFAULT 절이 정의되어 있을 때 |

본 도구는 Rename / Transform 구분을 자동으로 수행합니다. 사용자가 AS-IS 컬럼만 선택하면 다음 규칙으로 결정됩니다.

- AS-IS 와 TO-BE 의 자료형이 동일하면 `passthrough`
- 자료형이 다르거나 사용자가 SQL 변환식을 입력했으면 `transform`

#### Advanced — SQL 변환식

AS-IS 컬럼을 선택한 경우 **Advanced** 토글이 노출됩니다. 펼치면 자유 형식의 SQL 변환식을 입력할 수 있습니다. 비워두면 본 도구가 타입 차이만 보고 표준 변환을 자동 적용합니다.

```
UPPER(TRIM(ACCT_NO))
TO_DATE(OPEN_DT, 'YYYYMMDD')
unpack_comp3(BAL_AMT)
iconv('ebcdic-kana', 'utf-8', NAME_KANJI)
```

#### Note

선택한 매핑의 의도를 자유 텍스트로 기록할 수 있습니다. 감사(Audit) 로그와 변경 이력에 함께 기록됩니다.

### 5.5 매핑 안 한 컬럼의 실행 시 동작

매핑을 명시하지 않은 컬럼은 실행 시 다음 규칙으로 처리됩니다.

| 컬럼 상태 | 실행 시 동작 | Preflight 검증 |
|---|---|---|
| nullable | NULL 채움 | queued (실행 가능) |
| NOT NULL · DDL default 있음 | DEFAULT 값 사용 | queued (실행 가능) |
| NOT NULL · DDL default 없음 | 실행 차단 | error (실행 불가) |

마지막 케이스를 해결하려면 (1) AS-IS 컬럼을 매핑하거나 (2) DDL에 DEFAULT 절을 추가해야 합니다.

### 5.6 AS-IS 테이블 디테일

AS-IS 트리에서 항목을 선택하면 읽기 전용 디테일이 표시됩니다. 다음 세 개 하위 탭을 제공합니다.

- **Columns** — DDL 파싱 결과 컬럼 목록과 각 컬럼이 어느 TO-BE 로 라우팅되는지(Maps to)
- **Samples** — 상위 10건 표본 데이터(연결 시 실제, 미연결 시 mock)
- **Profile** — 컬럼별 NULL 비율·고유값·상위값 등 분포 통계

`Maps to` 컬럼이 비어 있는 AS-IS 컬럼은 어디에도 사용되지 않는 컬럼이며, *unmapped* 로 표시됩니다.

---

## 6. Versions — 스냅샷과 승인

매핑 정의는 살아 있는 작업물이지만, 실행은 **승인된 스냅샷** 에 대해서만 가능합니다. Versions 탭은 스냅샷의 생성·승인·이력을 관리합니다.

### 6.1 상태 배너

화면 최상단 배너는 가장 최근 승인 상태와 미반영 변경의 개수를 보여줍니다.

- 녹색 — 최신 매핑이 모두 승인된 상태
- 호박색 — 검토 대기 또는 미반영 변경 존재

배너 우측의 **Create snapshot** 버튼은 항상 표시되며, 클릭 시 현재 매핑 상태를 새 버전으로 동결합니다.

### 6.2 스냅샷 생성

1. **Create snapshot** 클릭
2. 새 스냅샷이 `pending` 상태로 생성됩니다.
3. 시스템이 버전 번호를 자동 부여합니다(예: 직전 1.2 → 1.3).
4. Audit log 에 자동으로 `snapshot` 이벤트가 기록됩니다.

### 6.3 승인 워크플로우

스냅샷의 상태는 다음 네 가지입니다.

| 상태 | 의미 |
|---|---|
| draft | 이전 승인본 이후 미반영 변경 (가상 행) |
| pending | 리뷰어 검토 대기 |
| approved | 승인 완료 — 실행 가능 |
| rejected | 변경 요청 — 다시 작업 후 재스냅샷 필요 |

승인 권한이 있는 사용자는 `pending` 스냅샷의 디테일에서 다음 동작을 수행할 수 있습니다.

- **Approve** — 스냅샷을 `approved` 로 전환. 이 시점부터 실행 가능
- **Request changes** — `rejected` 로 전환. 거부 사유를 입력
- **Reassign reviewer** — 다른 리뷰어로 변경 *(V1 예정)*

### 6.4 변경 이력 (Changes)

각 스냅샷의 디테일 우측에는 직전 스냅샷 대비 변경된 항목이 색상별로 표시됩니다.

- 녹색(+) — 신규 추가
- 청색(~) — 기존 항목 수정
- 적색(−) — 항목 제거

### 6.5 Audit log

화면 하단의 접이식 영역은 프로젝트 전체의 이벤트 로그입니다. 다음 종류의 이벤트가 자동 기록됩니다.

- 프로젝트 생성·삭제·이름 변경
- DDL 도입·삭제
- 바인딩 변경
- 컬럼 오버라이드 추가·수정·삭제
- 스냅샷 생성·승인·거부
- 실행 시작·종료·실패

Audit log 는 변경할 수 없으며, 컴플라이언스 추적용으로 활용됩니다.

---

## 7. Execution — 실행과 모니터링

Execution 탭은 실제 데이터 이행을 실행하고 진행률을 모니터링하는 화면입니다.

### 7.1 Run header

활성 Run 이 있으면 다음 정보가 표시됩니다.

- Run ID
- 모드 뱃지 — `REHEARSAL`(파란색) 또는 `⚠ CUTOVER`(빨간색)
- 시작 시각·경과 시간·예상 완료
- 트리거 정보 — 사용자명 또는 스케줄러 이름

활성 Run 이 없을 때는 마지막 실행 정보 또는 “run 이력 없음” 안내가 표시됩니다.

#### Run 모드 결정 경로

Run 모드(`REHEARSAL` 또는 `CUTOVER`)는 다음 세 경로 중 하나로 정해집니다. 사용자가 매핑 화면이나 General 설정에서 모드를 미리 고르는 항목은 없습니다.

- **(V1) Start run 다이얼로그** — Execution 탭 우상단의 *Start run* 버튼을 누르면 모드 선택 다이얼로그가 열립니다. *Rehearsal* 은 테스트 타겟에 dry-run 으로 실행되고, *Cutover* 는 운영 타겟에 실제 적용됩니다. *Cutover* 선택 시 승인된 매핑 스냅샷·Preflight 통과·D-day 일정 일치 등 추가 게이트가 함께 검증됩니다.
- **내장 스케줄러 — Nightly rehearsal** (Project Settings › Schedule) — 매일 정해진 시각에 *Rehearsal 모드 전용* 으로 자동 실행됩니다. 본 카드에서 Cutover 를 트리거하지는 않습니다.
- **외부 스케줄러** (Solution Settings › External integrations 활성화 시) — Control-M·Airflow·Jenkins·cron 등에서 다음 명령을 호출해 모드를 직접 지정합니다.
  ```
  migrate run --project <pid> --mode rehearsal --dry-run
  migrate run --project <pid> --mode cutover
  ```

Run 의 *환경* 표기(예: `prod` 타겟인지 `stg` 타겟인지)는 Project Settings › General 의 **Environment** 라벨로 관리되며, 본 라벨은 모드와 별개입니다(§10.1 참조).

### 7.2 Preflight 체크

실행 전 통과해야 하는 검증 목록입니다. 각 항목은 다음 상태 중 하나입니다.

- pass — 통과
- warn — 경고 (실행은 가능하나 검토 권장)
- fail — 차단 (실행 불가)
- skip — 검증 불가능한 단계 (예: DDL 미도입)

#### 표준 Preflight 항목

| ID | 검증 내용 | 차단 여부 |
|---|---|---|
| conn-asis | AS-IS 데이터베이스 접속 가능 | 차단 |
| conn-tobe | TO-BE 데이터베이스 접속 가능 | 차단 |
| ddl-asis | AS-IS DDL 도입 완료 | 차단 |
| ddl-tobe | TO-BE DDL 도입 완료 | 차단 |
| tobe-bindings | 모든 TO-BE 테이블 소스 바인딩 | 차단 |
| asis-orphans | 미사용 AS-IS 테이블 확인 | 경고 |
| added-not-null | NOT NULL 신규 컬럼의 default 지정 | 차단 |
| unmapped-cols | 모든 TO-BE 컬럼 매핑 지정 | 차단 |
| approved-snapshot | 승인된 매핑 스냅샷 존재 | 차단 |

각 항목에는 **Fix** 버튼이 있어 클릭 시 해당 문제를 해결할 수 있는 화면으로 자동 이동합니다. 문제가 컬럼 단위인 경우 해당 행이 약 2.5초간 노란 펄스로 강조됩니다.

### 7.3 진행률

상단의 전체 진행률 바와 Stage 별 세부 진행률(extract / transform / load / validate / commit 등)을 함께 표시합니다.

- 처리량(rows/sec)
- 큐 길이
- 오류·경고 누적 카운트

### 7.4 Quarantine — 격리된 행

이행 도중 검증에 실패한 행은 즉시 중단하지 않고 격리(Quarantine)됩니다. Quarantine 뷰는 다음을 제공합니다.

- 검증 단계 (validate.fk / validate.notnull / convert.encoding 등)
- 사유 — “FK violation — child key not found in parent” 등
- 영향 받은 테이블·건수
- 표본 행 (재현용)
- 처리 옵션 — *Skip and continue*, *Retry with rule*, *Block run*

### 7.5 Run 이력

화면 하단의 Run history 영역은 과거 실행 기록을 표시합니다. 각 실행 항목 클릭 시 해당 실행의 로그·Quarantine 통계로 이동할 수 있습니다.

### 7.6 Run 제어

활성 Run 이 없을 때:

- **Start run** *(V1)* — 모드 선택 다이얼로그를 엽니다(§7.1 *Run 모드 결정 경로* 참조). Preflight 가 모두 통과해야 본 버튼이 활성화됩니다.

활성 Run 시:

- **Pause** — 일시 정지 (재시작 가능)
- **Resume** — 재시작
- **Abort** — 즉시 중단. 컷오버 모드에서는 추가 확인 다이얼로그가 표시됩니다.

---

## 8. Artifacts — 산출물

Artifacts 탭은 매핑 정의로부터 생성되는 산출물을 조회·내보내기 합니다.

| 산출물 | 설명 |
|---|---|
| Mapping YAML | 컬럼 매핑 규칙 전체 |
| Bindings YAML | 테이블 바인딩 정의 |
| TO-BE DDL | 합성된 TO-BE 스키마 |
| Migration SQL | 실행될 INSERT/SELECT 모음 |
| Validation report | 마지막 실행의 검증 결과 |

각 산출물은 **Download** 버튼으로 파일로 내보낼 수 있으며, **Copy** 로 클립보드에 복사할 수 있습니다. 실행이 완료된 경우 산출물은 해당 Run ID 와 함께 보관됩니다.

---

## 9. Log Viewer — 로그 조회

Log Viewer 탭은 시스템 로그를 시간 순으로 표시합니다.

- 레벨 필터 (DEBUG / INFO / WARN / ERROR)
- 컴포넌트 필터 (extract / transform / load / quarantine / scheduler 등)
- 본문 검색
- 시간 범위 지정

활성 Run 중에는 새로 생성되는 로그가 실시간으로 추가됩니다(WebSocket).

---

## 10. Settings — 프로젝트 설정

Settings 탭은 다음 6개 섹션을 좌측 메뉴로 분리합니다.

### 10.1 General

- 프로젝트 이름·도메인·설명·태그
- 단계(phase) 수동 변경
- Cutover 예정일
- 프로젝트 복제·삭제

### 10.2 Source — AS-IS

- DDL 도입 (파일 업로드 / 드래그 앤 드롭)
- DDL 메타 정보 (테이블 수·컬럼 수·도입 시각·파일명)
- 데이터베이스 자격증명 (host / port / user / password)
- **Test connection** 버튼 — 실제 접속 시도 후 결과 표시
- DDL 삭제 (재도입 시)

### 10.3 Target — TO-BE

Source 섹션과 동일한 구조입니다. 자격증명·DDL이 별도로 관리됩니다.

### 10.4 Schedule

- **Nightly rehearsal** — 내장 스케줄러로 매일 정해진 시각에 자동 실행. 시각·요일·타겟 환경(test/prod)을 설정합니다.
- **Cutover window** — 컷오버 D-day 일정과 사전 freeze 시각, 자동 알림 설정
- **External trigger (선택)** — 외부 스케줄러(Control-M / Airflow / Jenkins / cron)에서 트리거하는 명령. *Solution Settings › External integrations* 가 활성화된 경우에만 동작합니다.

내장 스케줄러와 External trigger 의 동시 사용은 권장되지 않습니다(중복 실행 위험).

### 10.5 Notifications

이 프로젝트에 대한 인앱 알림 구독을 관리합니다. 폐쇄망 환경에서는 외부 채널(Slack / Email / Webhook) 대신 인앱 알림 인박스가 유일한 채널입니다.

이벤트 종류:

- Run 시작·완료·실패
- Preflight 차단 발생
- 스냅샷 승인 요청 / 승인 / 거부
- DDL 도입·삭제
- 바인딩 큰 변경 (컬럼 5개 이상 영향)

### 10.6 Danger zone

프로젝트의 위험 동작을 모은 영역입니다. 다음 동작이 포함됩니다.

- **Project 삭제** — 매핑·스냅샷·실행 이력을 영구 제거합니다. 복구 불가합니다.
- **DDL 초기화** — 도입한 AS-IS / TO-BE DDL 을 모두 제거하고 매핑을 잃습니다.
- **모든 매핑 override 초기화** — 사용자 매핑 결정을 일괄 삭제합니다.

각 동작은 클릭 시 확인 다이얼로그가 한 번 더 표시됩니다.

---

## 11. 알림 (Notification Inbox)

탑바 우측의 🔔 벨 아이콘은 인앱 알림 인박스입니다. 폐쇄망 환경에서는 본 인박스가 모든 알림의 진입점입니다.

### 11.1 알림 행

각 알림은 다음 정보를 포함합니다.

- 심각도(severity) 아이콘 — info / warn / error
- 프로젝트 칩 (어느 프로젝트의 이벤트인지)
- 본문
- 발생 시각

### 11.2 동작

- 알림 클릭 → 관련 화면으로 자동 이동 (예: run-failed → 해당 Run 의 Logs 탭)
- **Mark all read** — 전체 읽음 처리
- **Clear all** — 인박스 비우기 (Audit log 에는 영향 없음)

### 11.3 보관 정책 *(V1 예정)*

읽지 않은 알림은 30일간 보관되고, 읽은 알림은 7일 후 자동 삭제됩니다. 본 정책은 V1 본 개발 단계에서 적용됩니다. 현재 빌드에서는 **Clear all** 로 사용자가 직접 비우기까지 인박스에 보존됩니다.

---

## 12. Solution Settings — 솔루션 전역 설정

사이드바 사용자 메뉴 → **Solution settings** 로 진입합니다. 모달 형태로 열리며, 다음 카드를 포함합니다.

### 12.1 Appearance

- **Language** — 인터페이스 언어 (영어 / 한국어 / 일본어 / 중국어 간체)
- **Theme** — Light / Dark

### 12.2 Notifications

인앱 알림과 브라우저 푸시(데스크탑 앱일 경우 OS 알림)의 표시 시점을 정합니다.

- Run completion — Run 종료 시 알림
- Errors — 오류(severity ≥ error) 발생 시 알림

### 12.3 External integrations

기본은 비활성화 상태이며, 운영팀이 기존 외부 스케줄러(Control-M / Airflow / Jenkins / cron)로 본 도구를 트리거하고 싶을 때만 토글을 활성화합니다.

활성화 시 다음 정보를 관리합니다.

- 외부 스케줄러 종류
- CLI 경로
- API endpoint
- API 토큰
- Syslog 전달 대상

비활성 상태에서는 모든 외부 진입점(CLI / API)이 응답하지 않습니다.

---

## 13. 부록 A. 단축키 일람

본 절의 단축키는 Help & shortcuts 모달(F1)에 노출되는 표와 동일합니다. macOS 사용자는 `Ctrl` 을 `⌘` 로 대체하시기 바랍니다.

### Navigation

| 단축키 | 동작 |
|---|---|
| Alt + 1 | Dashboard 로 이동 |
| Alt + 2 | Mapping 으로 이동 |
| Alt + 3 | Execution 으로 이동 |
| Alt + 4 | Log Viewer 로 이동 |
| Alt + 5 | Artifacts 로 이동 |

### Run control

| 단축키 | 동작 |
|---|---|
| F5 | Run all — 활성 프로젝트의 매핑 실행 |
| Shift + F5 | 활성 Run 중단 |
| F6 | 매핑 검증 (Validate) |
| F7 | 직전 실행에서 실패한 항목만 재실행 |
| F8 | 다음 Stage 로 단계 이동 |
| Ctrl + S | 현재 프로젝트 저장 |

### Project & windows

| 단축키 | 동작 |
|---|---|
| Ctrl + B | 사이드바 토글 |
| Ctrl + N | 새 프로젝트 |
| Ctrl + O | 프로젝트 열기 |
| Ctrl + W | 현재 탭 닫기 |
| Ctrl + , | Settings 열기 |
| F1 | Help & shortcuts 모달 |
| Esc | 모달 닫기 / 인라인 편집 취소 |

### Tables & rows

| 단축키 | 동작 |
|---|---|
| Ctrl + F | 필터 입력란에 포커스 |
| ↑ / ↓ | 행 선택 이동 |
| Space | 행 선택 토글 |
| Enter | 선택한 행 열기 |
| Ctrl + A | 필터 결과 전체 선택 |
| Ctrl + D | 선택 해제 |
| Ctrl + Enter | 매핑 변경사항 적용 |

---

## 14. 부록 B. 용어집

| 용어 | 정의 |
|---|---|
| AS-IS | 이행 전 레거시 시스템 측 데이터베이스·스키마 |
| TO-BE | 이행 후 신규 시스템 측 데이터베이스·스키마 |
| DDL | Data Definition Language. 본 도구에서는 CREATE TABLE 문의 모음 |
| Binding | 한 TO-BE 테이블에 어떤 AS-IS 테이블이 어떤 합성으로 매핑되는지 정의 |
| Mapping | 한 TO-BE 컬럼이 AS-IS 어디에서 어떻게 채워지는지 정의 |
| Override | 사용자가 매핑을 수동 지정한 항목 |
| Snapshot | 특정 시점의 매핑 정의 전체를 동결한 버전 |
| Approval | 리뷰어가 스냅샷에 사인오프하는 절차 |
| Rehearsal | 테스트 환경에서 수행하는 연습 실행 |
| Cutover | 운영 환경으로 실제 이행을 수행하는 단계 |
| Hypercare | 컷오버 직후의 안정화 모니터링 기간 |
| Quarantine | 이행 중 검증 실패로 격리된 행 |
| Preflight | 실행 전 차단 검증 |

---

## 15. 부록 C. 자주 묻는 질문

**Q1. 자동 매핑은 왜 없습니까?**
이름이 같다는 이유로 컬럼을 자동으로 매핑할 경우 의미가 다른 컬럼끼리 잘못 연결될 위험이 있습니다(예: `STATUS` 가 한쪽은 계좌 상태, 다른 쪽은 거래 상태). 본 도구는 모든 매핑을 사용자가 명시적으로 결정하는 정책을 채택합니다.

**Q2. 같은 AS-IS 테이블을 여러 TO-BE 에 분할 사용할 수 있습니까?**
네. 각 TO-BE 바인딩에 WHERE 필터를 지정하면 됩니다. 분할이 완전한지(누락 행이 없는지) Coverage warning 으로 확인할 수 있습니다.

**Q3. 컷오버 중 실행이 실패하면 어떻게 됩니까?**
컷오버 모드는 트랜잭션 단위로 커밋을 분할 적용합니다. 실패 시 마지막 성공 커밋 시점으로의 롤백 절차가 Run 디테일에 표시됩니다. 운영 절차서의 “Cutover 실패 대응” 절을 참조하시기 바랍니다.

**Q4. 외부 스케줄러를 쓰면 내장 스케줄러는 자동으로 꺼집니까?**
아닙니다. 두 곳 모두 활성화되어 있으면 동시 실행이 발생할 수 있습니다. *Project Settings › Schedule* 의 Nightly rehearsal 토글을 명시적으로 비활성화하시기 바랍니다.

**Q5. 스냅샷을 잘못 만들었습니다. 삭제할 수 있습니까?**
스냅샷 자체는 삭제되지 않습니다. *rejected* 로 변경하면 실행에서 자동 제외되며, 새 스냅샷을 생성하여 다음 작업을 이어가시면 됩니다.

**Q6. 외부 채널(Slack / Email)로 알림을 받을 수 없습니까?**
폐쇄망 환경에서는 인앱 알림 인박스가 유일한 채널입니다. *Solution Settings › External integrations* 활성화 시 Syslog 전달이 가능하나, 사용자에게 직접 전달되는 채널은 없습니다.

---

## 16. 부록 D. 트러블슈팅

### 16.1 “Test connection” 버튼이 항상 실패합니다

다음을 순서대로 확인하시기 바랍니다.

1. 호스트명·포트가 정확한가
2. 사이트의 방화벽이 본 도구 노드에서 해당 DB 포트로 outbound 를 허용하는가
3. JDBC 드라이버가 *Solution Settings › Drivers* 에 등록되어 있는가
4. 비밀번호가 만료되지 않았는가 (특히 Oracle, DB2)

### 16.2 Mapping 그리드의 컬럼이 모두 unmapped 로 보입니다

신규 프로젝트의 정상 상태입니다. *Table binding* 부터 추가한 후, 각 컬럼을 Inspector 에서 매핑하시기 바랍니다.

### 16.3 Preflight 의 “unmapped-cols” 항목이 사라지지 않습니다

`unmapped` 룰의 컬럼이 한 개라도 남아 있으면 차단됩니다. Mapping 탭에서 *Unmapped* 필터 칩을 눌러 잔여 컬럼을 확인하시기 바랍니다.

### 16.4 “added-not-null” 으로 실행이 차단됩니다

TO-BE DDL 의 NOT NULL 컬럼 중 DEFAULT 절이 정의되지 않은 항목입니다. 다음 중 하나로 해결합니다.

- AS-IS 컬럼을 매핑한다 (Inspector → 컬럼 선택)
- TO-BE DDL 에 DEFAULT 절을 추가하고 재도입한다

### 16.5 컷오버 직전 “approved snapshot” 이 비어 있습니다

가장 최근 스냅샷이 `pending` 또는 `rejected` 상태입니다. 리뷰어가 *Versions* 탭에서 **Approve** 를 수행해야 컷오버가 가능합니다.

### 16.6 알림이 너무 많이 옵니다

*Project Settings › Notifications* 에서 구독 이벤트를 줄입니다. 또는 *Solution Settings › Notifications* 에서 Run 완료·오류 알림을 끌 수 있습니다.

### 16.7 Quarantine 가 계속 누적됩니다

Quarantine 패널에서 반복 발생 사유를 확인하고, 해당 컬럼의 매핑 규칙을 수정한 뒤 새 스냅샷을 생성하여 재실행하시기 바랍니다. 사유별 권장 대응:

- FK violation — 부모 테이블 이행 순서 확인
- NULL on NOT NULL — 매핑 규칙에 NULL guard 추가 (`COALESCE(src, default)`)
- Encoding error — Source 인코딩 설정 확인 (EBCDIC-KANA / EBCDIC-KANJI)
- Type overflow — 변환식에 자릿수 검증 추가

---

**문서 끝.**
