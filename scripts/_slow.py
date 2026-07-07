p = "C:/Users/Hoax Japan/AppData/Local/ModernizeProDataBridge/launcher.log"
rows = []
for line in open(p, encoding="utf-8", errors="ignore"):
    if "perf" not in line or "ms)" not in line:
        continue
    try:
        ms = int(line.rsplit("(", 1)[1].split("ms")[0])
    except Exception:
        continue
    ep = line.split("PerfTraceFilter - ")[-1].strip()
    rows.append((ms, ep))
rows.sort(reverse=True)
print("total perf lines:", len(rows))
print("--- slowest 25 ---")
for ms, ep in rows[:25]:
    print(ms, ep)
