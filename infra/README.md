# TO-BE PostgreSQL stage fixtures

Self-contained PostgreSQL 4-stage environment (dev / test / staging / prod)
for development, demos, and PoC verification. Each container boots with
the full Japanese-securities domain DDL **and** stage-appropriate sample
data already loaded — so `docker compose up` once and you can run the
migration tool end-to-end immediately.

These containers are **separate from the meta DB** (`backend/compose.yaml`)
on purpose: stage data gets wiped and reloaded frequently, the meta DB
does not.

---

## Prerequisites

- Docker Desktop (or any docker engine with compose v2)
- ~500 MB free disk for the four volumes
- Ports 5440–5443 free on the host (override in `.env` if not)

---

## Quick start

```bash
# from repo root
cp infra/.env.example .env
docker compose -f infra/compose.tobe-stages.yaml up -d
docker compose -f infra/compose.tobe-stages.yaml ps      # wait for "healthy"

# connect to a stage
psql -h localhost -p 5440 -U tobe -d tobe_dev            # password: tobe (default)
\dt                                                       # 5 tables expected
SELECT count(*) FROM customer;                            # 10 (dev)
```

---

## Connection matrix

| Stage   | Host port | Database     | User | Default password |
|---------|-----------|--------------|------|------------------|
| dev     | 5440      | `tobe_dev`     | `tobe` | `tobe` (override via `.env`) |
| test    | 5441      | `tobe_test`    | `tobe` | `tobe` |
| staging | 5442      | `tobe_staging` | `tobe` | `tobe` |
| prod    | 5443      | `tobe_prod`    | `tobe` | `tobe` |

Per-stage row counts:

| Stage   | customer | account | product | trade | account_product |
|---------|----------|---------|---------|-------|-----------------|
| dev     | 10       | 15      | 8       | 20    | 18              |
| test    | 50       | 80      | 20      | 100   | 90              |
| staging | 100      | 180     | 40      | 200   | 200             |
| prod    | 200      | 380     | 60      | 400   | 420             |

`test` is the only stage with PII masking applied (`山田 太郎` → `山田 **`,
`taro.x@…` → `ta****@…`, `090-1234-5678` → `090-****-5678`). Other stages
hold realistic synthetic values.

---

## LAN access (same Wi-Fi)

```bash
# on the host running docker:
ipconfig getifaddr en0          # macOS — your LAN IP, e.g. 192.168.1.50

# on a teammate's machine (same network):
psql -h 192.168.1.50 -p 5440 -U tobe -d tobe_dev
```

Container `ports:` are bound to `0.0.0.0` already, so no extra config is
needed inside the container. Make sure the host firewall lets through
the relevant ports (macOS: System Settings → Network → Firewall, or
turn it off on a trusted LAN).

---

## Tailscale (remote access — home / off-site)

Already in use by the team. After `tailscale up`:

```bash
tailscale ip -4                 # e.g. 100.75.87.36

# from anywhere on your tailnet:
psql -h 100.75.87.36 -p 5440 -U tobe -d tobe_dev
```

No extra config. Tailscale is the recommended path for remote work
because it's a private mesh — no port on the public internet.

### Why not ngrok

- Public TCP endpoint — exposes a database to anyone with the URL
- Stable TCP requires a paid plan
- We already run Tailscale, which solves the same problem privately

---

## Reset / wipe

Bring everything down and delete volumes (sample data reloads on next
`up`):

```bash
docker compose -f infra/compose.tobe-stages.yaml down -v
docker compose -f infra/compose.tobe-stages.yaml up -d
```

The meta DB compose (`backend/compose.yaml`) is on a different project
name (`mpd-tobe` vs default) and a different volume, so it is **not**
affected.

---

## Port conflicts

If any of 5440–5443 are taken, override in `.env`:

```ini
DEV_PORT=5450
TEST_PORT=5451
STAGING_PORT=5452
PROD_PORT=5453
```

then `docker compose -f infra/compose.tobe-stages.yaml up -d` again.

---

## Regenerating sample data

Sample CSVs are generated deterministically by
`scripts/gen_sample_data.py`. If the schema changes, re-run it and then
re-init the containers:

```bash
python3 scripts/gen_sample_data.py
docker compose -f infra/compose.tobe-stages.yaml down -v
docker compose -f infra/compose.tobe-stages.yaml up -d
```

The seed is keyed off the stage name, so re-runs yield byte-identical
output.

---

## Important: sample CSVs are NOT tool inputs

The migration tool's "AS-IS DDL import" UI accepts `.sql / .ddl / .txt`,
not `.csv`. The CSVs in `db/sample_data/` exist to seed these stage
databases — they are not consumed by the application's AS-IS ingest
pipeline. Don't try to upload them through the DDL import button.

---

## File layout

```
infra/
├── compose.tobe-stages.yaml   ← this dir
├── .env.example
└── README.md (this file)

db/
├── asis/oracle_ddl.sql        ← reference only — no Oracle container
├── tobe/{stage}/init.sql      ← mounted as 01_schema.sql per stage
└── sample_data/{stage}/
    ├── load.sql               ← mounted as 02_load_sample.sql
    └── {table}.csv            ← seeded via \copy from /sample/
```
