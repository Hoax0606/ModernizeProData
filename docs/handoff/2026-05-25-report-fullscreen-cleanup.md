# 2026-05-25 — report-fullscreen-cleanup (Suhyun Jin)

Report 화면에서 데이터 그리드 영역을 더 넓게 쓰기 위한 UI 정리.

## 한 일

- **상단 context bar 숨김**: `reportOpen === true` 일 때 `TO-BE 칩 + 테이블 칩 + status counts + Trial + Report` 줄을 `display: 'none'` 으로. DBeaver UI 자체 타이틀바·툴바·탭바·breadcrumb 가 같은 컨텍스트를 다 보여주므로 중복.
- **DBeaver 서브탭 제거**: `Properties / Data / Diagram` 줄 통째 삭제. 디자인-only 였고 클릭 동작 없었음. 데이터 그리드가 그만큼 위로 확장.

## 다음 사람이 할 일

- Report 닫기 (`X`) 동선은 그대로 — 우상단 타이틀바 ✕ 가 `onClose()` 호출. 만약 사용자가 Report 안에서 `Trial` 을 재실행하길 원하면 별도 액션 노출 필요 (현재는 닫고 외부에서 다시).

## 함정 / 결정 이력

- 서브탭이 사라져도 외부 상태에 영향 없음 — `Data` 가 default 였고 다른 탭은 미구현.
