import requests
B = "http://localhost:8080"
t = requests.post(B + "/api/v1/auth/login",
                  json={"username": "master", "password": "password"}).json()["data"]["token"]
h = {"Authorization": "Bearer " + t}
runs = requests.get(B + "/api/v1/runs", headers=h).json()["data"]
r = runs[0]
rid = r["id"]
print("LATEST run", rid, "status=", r["status"])
print("--- stages ---")
for x in requests.get(f"{B}/api/v1/runs/{rid}/stages", headers=h).json()["data"]:
    print(x["stageKey"], x["status"], "succ=" + str(x.get("tablesSuccess")),
          "fail=" + str(x.get("tablesFailed")), "err=" + str(x.get("errorSummary")))
print("--- table-results (first 6) ---")
for x in requests.get(f"{B}/api/v1/runs/{rid}/table-results", headers=h).json()["data"][:6]:
    print(x.get("tobeTable"), x.get("status"), "rows=" + str(x.get("rows")), str(x.get("errorDetail"))[:160])
