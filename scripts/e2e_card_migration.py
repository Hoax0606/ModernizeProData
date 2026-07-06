#!/usr/bin/env python3
"""
카드 PoC e2e 자동화 — 도구 REST API 로 site~run 전체를 돌려 Oracle->PG 이행을 검증.

전제 (실행 전):
  1. backend 기동 (SPRING_PROFILES_ACTIVE=local, MPD_PERF=true 권장 — capacity 로그).
  2. 메타 PG (5433/mpd_meta).
  3. TO-BE PG (카드 적재 대상) — card_tobe_pg.sql 적용된 DB. 접속정보를 아래 TOBE_DB 에.
  4. fixture 생성됨: python scripts/gen_card_fixture.py test  (auth 1M).

흐름: login -> site -> project -> AS-IS/TO-BE DDL import -> mapping import ->
      snapshot -> baseline pin -> phase=test -> run(test) -> stages 폴링 -> 검증.

각 단계 HTTP 응답을 출력하고, 4xx/5xx 면 그 단계에서 중단(어디서 막혔는지 명확).
payload 가 백엔드 DTO 와 안 맞아 막히면 그 응답 body 를 보고 CONFIG/payload 조정.

실행: python scripts/e2e_card_migration.py
의존: pip install requests
"""
from __future__ import annotations
import sys, time
from pathlib import Path

try:
    import requests
except ImportError:
    print("pip install requests 필요"); sys.exit(1)

REPO = Path(__file__).resolve().parent.parent
BASE = "http://localhost:8080"
USER, PASS = "master", "password"

CSV_DIR    = REPO / "db" / "sample_data" / "asis_card" / "test"
ASIS_DDL   = REPO / "db" / "asis_card"  / "card_asis_oracle.sql"
TOBE_DDL   = REPO / "db" / "tobe_card"  / "card_tobe_pg.sql"
COLUMN_MAP = REPO / "db" / "mapping_card" / "column_mapping.csv"
CODE_MAP   = REPO / "db" / "mapping_card" / "code_mapping.csv"

ENV = "test"   # asisEnv/tobeEnv/environment 라벨

# TO-BE PG 접속 — card_tobe_pg.sql 이 적용된 DB. 내부 필드명은 백엔드 TobeDb DTO 와 맞춰야 함
# (안 맞으면 site create 또는 conn-tobe preflight 에서 막힘 — 응답 보고 조정).
TOBE_DB = {
    "type": "postgresql",
    "host": "localhost",
    "port": 5440,                 # compose.tobe-stages.yaml 의 test stage 포트 (확인 필요)
    "database": "card_tobe",
    "username": "mpd",
    "password": "mpd",
}

s = requests.Session()


def show(label, r):
    print(f"  [{r.status_code}] {label}: {r.text[:600]}")
    if r.status_code >= 400:
        raise SystemExit(f"!! 중단 — {label} 실패 ({r.status_code})")
    try:
        return r.json().get("data")
    except Exception:
        return None


def main():
    print("== 1. login ==")
    tok = show("login", s.post(f"{BASE}/api/v1/auth/login",
                               json={"username": USER, "password": PASS}))["token"]
    s.headers["Authorization"] = f"Bearer {tok}"

    print("== 2. create site ==")
    site = show("site", s.post(f"{BASE}/api/v1/sites", json={
        "name": f"Card PoC e2e {int(time.time())}",
        "asisEnv": ENV, "tobeEnv": ENV,
        "asisEncoding": "shift_jis", "tobeEncoding": "utf-8",
        "csvPath": str(CSV_DIR),
        "asisDbType": "oracle", "asisDbVersion": "19c",
        "notes": "card e2e", "environment": ENV,
        "tobeDbScope": "site",
        "tobeDbByEnv": {ENV: TOBE_DB},
        "tobeDbLocks": {ENV: True},
    }))
    sid = site["id"]; print("  siteId =", sid)

    print("== 3. create project ==")
    proj = show("project", s.post(f"{BASE}/api/v1/sites/{sid}/projects",
                                  json={"name": "card-migration", "phase": "planning",
                                        "tableCount": 0, "ddlFiles": []}))
    pid = proj["id"]; print("  projectId =", pid)

    print("== 4. import DDL (AS-IS / TO-BE) ==")
    with open(ASIS_DDL, "rb") as f:
        show("asis-ddl", s.post(f"{BASE}/api/v1/projects/{pid}/asis-ddl/import",
                                files={"file": (ASIS_DDL.name, f, "text/plain")}))
    with open(TOBE_DDL, "rb") as f:
        show("tobe-ddl", s.post(f"{BASE}/api/v1/projects/{pid}/tobe-ddl/import",
                                files={"file": (TOBE_DDL.name, f, "text/plain")}))

    print("== 5. import mapping (column + code) ==")
    # column + code 를 한 import 에 같이 올리는지, 분리인지는 MappingImportController 확인 필요.
    # 막히면 응답 보고 endpoint/필드명 조정.
    with open(COLUMN_MAP, "rb") as cf, open(CODE_MAP, "rb") as kf:
        show("mapping-import", s.post(f"{BASE}/api/v1/projects/{pid}/mapping/import",
                                      files={"columnMapping": (COLUMN_MAP.name, cf, "text/csv"),
                                             "codeMapping": (CODE_MAP.name, kf, "text/csv")}))

    print("== 6. snapshot + baseline pin ==")
    snap = show("snapshot", s.post(f"{BASE}/api/v1/projects/{pid}/snapshots",
                                   json={"name": "e2e v1", "type": "mapping", "description": "card e2e"}))
    snid = snap["id"]; print("  snapshotId =", snid)
    show("baseline", s.post(f"{BASE}/api/v1/snapshots/{snid}/baseline"))

    print("== 7. phase -> test ==")
    show("phase", s.patch(f"{BASE}/api/v1/projects/{pid}", json={"phase": "test"}))

    print("== 8. start run (test) ==")
    run = show("run", s.post(f"{BASE}/api/v1/runs", json={
        "projectId": pid, "runType": "test", "tables": None,
        "useCache": False, "resumeFromRunId": None,
    }))
    rid = run["runId"]; print("  runId =", rid, "status =", run["status"])
    if run["status"] != "STARTED":
        raise SystemExit(f"!! run rejected: {run.get('reason')}")

    print("== 9. poll stages ==")
    t0 = time.time()
    while True:
        time.sleep(3)
        stages = s.get(f"{BASE}/api/v1/runs/{rid}/stages").json().get("data", [])
        line = " ".join(f"{x['stageKey']}:{x['status']}({x.get('tablesSuccess',0)}/{x.get('tablesTotal',0)})"
                        for x in stages)
        print(f"  [{int(time.time()-t0)}s] {line}")
        terminal = bool(stages) and all(
            x["status"] in ("success", "failed", "failed_with_pending_warnings") for x in stages)
        if terminal or time.time() - t0 > 1800:
            break

    print("== 10. table-results (검증) ==")
    res = s.get(f"{BASE}/api/v1/runs/{rid}/table-results").json().get("data", [])
    ok = sum(1 for x in res if x["status"] == "success")
    rows = sum(x.get("rows", 0) for x in res)
    print(f"  tables success={ok}/{len(res)}  rows loaded={rows:,}")
    print("  실패 테이블:", [x["tobeTable"] for x in res if x["status"] != "success"] or "없음")
    print("\n메모리/capacity 는 backend boot.log 의 'RunCapacity' + 'memory_limit' 라인 확인.")


if __name__ == "__main__":
    main()
