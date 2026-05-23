#!/usr/bin/env python3
"""Generate stage-keyed sample CSVs for the TO-BE PostgreSQL fixtures.

Outputs: db/sample_data/{stage}/{table}.csv for stage in
{dev, test, staging, prod} and table in
{customer, product, account, account_product, trade}.

- Deterministic: same seed per stage → byte-identical CSVs on every run.
- FK integrity preserved (customer → account → trade; account ↔ product).
- Masking applied to the `test` stage only:
    customer_name "山田 太郎"        → "山田 **"
    email         "taro.x@example.jp" → "ta****@example.jp"
    phone         "090-1234-5678"   → "090-****-5678"
- Encoding: UTF-8 with BOM (Excel-friendly). PG \\copy tolerates BOM in PG 14+.

Run from repo root:
    python3 scripts/gen_sample_data.py

Re-run any time after schema or row-count tweaks. Update the MANIFEST below.
"""
from __future__ import annotations

import csv
import hashlib
import os
import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = REPO_ROOT / "db" / "sample_data"

STAGES = ("dev", "test", "staging", "prod")

# ────────────────────────────────────────────────────────────────────────────
# Row counts per stage (must match the plan / DDL constraints).
# ────────────────────────────────────────────────────────────────────────────
ROW_COUNTS: dict[str, dict[str, int]] = {
    "dev":     {"customer":  10, "product":  8,  "account":  15, "account_product":  18, "trade":  20},
    "test":    {"customer":  50, "product": 20,  "account":  80, "account_product":  90, "trade": 100},
    "staging": {"customer": 100, "product": 40,  "account": 180, "account_product": 200, "trade": 200},
    "prod":    {"customer": 200, "product": 60,  "account": 380, "account_product": 420, "trade": 400},
}

# ────────────────────────────────────────────────────────────────────────────
# Japanese name pools.
# ────────────────────────────────────────────────────────────────────────────
SURNAMES = [
    "山田", "鈴木", "佐藤", "田中", "高橋", "渡辺", "中村", "小林", "加藤", "吉田",
    "山本", "斎藤", "松本", "井上", "木村", "林", "清水", "山口", "池田", "阿部",
    "橋本", "山崎", "森", "石川", "前田", "藤田", "後藤", "岡田", "長谷川", "村上",
]
SURNAMES_KANA = [
    "ヤマダ", "スズキ", "サトウ", "タナカ", "タカハシ", "ワタナベ", "ナカムラ", "コバヤシ", "カトウ", "ヨシダ",
    "ヤマモト", "サイトウ", "マツモト", "イノウエ", "キムラ", "ハヤシ", "シミズ", "ヤマグチ", "イケダ", "アベ",
    "ハシモト", "ヤマザキ", "モリ", "イシカワ", "マエダ", "フジタ", "ゴトウ", "オカダ", "ハセガワ", "ムラカミ",
]
GIVEN_M = [
    "太郎", "健一", "雄太", "翔", "大輔", "拓也", "隆", "浩二", "剛", "誠",
    "浩", "智", "智之", "直樹", "一郎", "修", "哲也", "達也", "慎一", "圭",
    "亮", "健太", "諒", "翼", "蓮", "颯太", "陽介", "大樹", "雄一", "慎太郎",
]
GIVEN_M_KANA = [
    "タロウ", "ケンイチ", "ユウタ", "ショウ", "ダイスケ", "タクヤ", "タカシ", "コウジ", "ツヨシ", "マコト",
    "ヒロシ", "サトシ", "トモユキ", "ナオキ", "イチロウ", "オサム", "テツヤ", "タツヤ", "シンイチ", "ケイ",
    "リョウ", "ケンタ", "リョウ", "ツバサ", "レン", "ソウタ", "ヨウスケ", "ダイキ", "ユウイチ", "シンタロウ",
]
GIVEN_F = [
    "花子", "美咲", "由美", "智子", "真理", "香織", "恵子", "直美", "加奈", "京子",
    "麻衣", "久美子", "千恵", "千秋", "知美", "裕子", "麻美", "結衣", "萌", "美穂",
    "葵", "凜", "桜", "美月", "玲奈", "陽菜", "莉子", "杏", "詩織", "七海",
]
GIVEN_F_KANA = [
    "ハナコ", "ミサキ", "ユミ", "トモコ", "マリ", "カオリ", "ケイコ", "ナオミ", "カナ", "キョウコ",
    "マイ", "クミコ", "チエ", "チアキ", "トモミ", "ユウコ", "アサミ", "ユイ", "モエ", "ミホ",
    "アオイ", "リン", "サクラ", "ミツキ", "レイナ", "ヒナ", "リコ", "アン", "シオリ", "ナナミ",
]

# ────────────────────────────────────────────────────────────────────────────
# Products (商品マスタ).
# kind: 10=株式  20=債券  30=投資信託
# ────────────────────────────────────────────────────────────────────────────
PRODUCT_POOL: list[tuple[str, str, str]] = [
    # (kind, code_prefix, name)
    ("10", "STK001", "トヨタ自動車"),
    ("10", "STK002", "ソニーグループ"),
    ("10", "STK003", "任天堂"),
    ("10", "STK004", "三菱UFJフィナンシャル"),
    ("10", "STK005", "日立製作所"),
    ("10", "STK006", "パナソニック"),
    ("10", "STK007", "本田技研工業"),
    ("10", "STK008", "NTT"),
    ("10", "STK009", "ソフトバンクグループ"),
    ("10", "STK010", "武田薬品工業"),
    ("10", "STK011", "キーエンス"),
    ("10", "STK012", "ファーストリテイリング"),
    ("10", "STK013", "東京エレクトロン"),
    ("10", "STK014", "信越化学工業"),
    ("10", "STK015", "村田製作所"),
    ("10", "STK016", "三井住友フィナンシャル"),
    ("10", "STK017", "JR東日本"),
    ("10", "STK018", "オリエンタルランド"),
    ("10", "STK019", "リクルートホールディングス"),
    ("10", "STK020", "KDDI"),
    ("20", "BND001", "日本国債10年"),
    ("20", "BND002", "日本国債20年"),
    ("20", "BND003", "日本国債30年"),
    ("20", "BND004", "米国債5年"),
    ("20", "BND005", "米国債10年"),
    ("20", "BND006", "豪国債10年"),
    ("20", "BND007", "三菱UFJ社債A"),
    ("20", "BND008", "三井住友社債B"),
    ("20", "BND009", "東京電力社債"),
    ("20", "BND010", "政府保証債J1"),
    ("20", "BND011", "政府保証債J2"),
    ("20", "BND012", "ソフトバンク社債"),
    ("20", "BND013", "JR東日本社債"),
    ("20", "BND014", "NTT社債"),
    ("20", "BND015", "日本郵政社債"),
    ("30", "MFD001", "グローバル株式ファンド"),
    ("30", "MFD002", "国内債券ファンド"),
    ("30", "MFD003", "アジアREITファンド"),
    ("30", "MFD004", "テクノロジー集中投信"),
    ("30", "MFD005", "ESGバランスファンド"),
    ("30", "MFD006", "新興国株式ファンド"),
    ("30", "MFD007", "国内中小型株ファンド"),
    ("30", "MFD008", "米国株式インデックス"),
    ("30", "MFD009", "ヘルスケア集中投信"),
    ("30", "MFD010", "グローバルREITファンド"),
    ("30", "MFD011", "高配当株ファンド"),
    ("30", "MFD012", "コモディティファンド"),
    ("30", "MFD013", "AI関連株ファンド"),
    ("30", "MFD014", "クリーンエネルギー投信"),
    ("30", "MFD015", "オールカントリー株式"),
    ("30", "MFD016", "為替ヘッジ債券F"),
    ("30", "MFD017", "新興国債券ファンド"),
    ("30", "MFD018", "短期金融F"),
    ("30", "MFD019", "バランス型F"),
    ("30", "MFD020", "アクティブ運用F"),
    ("30", "MFD021", "リスク抑制F"),
    ("30", "MFD022", "成長株集中F"),
    ("30", "MFD023", "バリュー株F"),
    ("30", "MFD024", "海外REITF"),
    ("30", "MFD025", "国内REITF"),
]

EMAIL_DOMAINS = ["example.jp", "example.co.jp", "test.jp"]


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────
def stage_seed(stage: str) -> int:
    """Deterministic seed per stage so re-runs are byte-identical."""
    h = hashlib.sha256(stage.encode("utf-8")).hexdigest()
    return int(h[:16], 16)


def romaji(surname: str, given: str) -> str:
    """Cheap romaji for email local parts. Not real translit — deterministic placeholder."""
    # Use kana index → ASCII letter rotation; this is purely for email local part.
    pool = "abcdefghijklmnopqrstuvwxyz"
    src = surname + given
    out = []
    for ch in src:
        idx = ord(ch) % 26
        out.append(pool[idx])
    return "".join(out)[:8]


def mask_name(name: str) -> str:
    """山田 太郎 → 山田 ** (mask given-name characters with *)."""
    parts = name.split(" ", 1)
    if len(parts) != 2:
        return name
    surname, given = parts
    return f"{surname} {'*' * len(given)}"


def mask_email(email: str) -> str:
    """taro.x@example.jp → ta****@example.jp."""
    if "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        return f"{local}****@{domain}"
    return f"{local[:2]}****@{domain}"


def mask_phone(phone: str) -> str:
    """090-1234-5678 → 090-****-5678."""
    segs = phone.split("-")
    if len(segs) != 3:
        return phone
    return f"{segs[0]}-****-{segs[2]}"


def iso_date(d: date) -> str:
    return d.isoformat()


def iso_ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# ────────────────────────────────────────────────────────────────────────────
# Generators (one per table). All return list[dict].
# ────────────────────────────────────────────────────────────────────────────
def gen_customer(n: int, rng: random.Random, mask: bool) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        si = rng.randrange(len(SURNAMES))
        is_male = rng.random() < 0.55
        if is_male:
            gi = rng.randrange(len(GIVEN_M))
            given, given_kana = GIVEN_M[gi], GIVEN_M_KANA[gi]
            gender = "M"
        else:
            gi = rng.randrange(len(GIVEN_F))
            given, given_kana = GIVEN_F[gi], GIVEN_F_KANA[gi]
            gender = "F"
        name = f"{SURNAMES[si]} {given}"
        name_kana = f"{SURNAMES_KANA[si]} {given_kana}"
        # birthdate: roughly 25–70 years old as of 2024-01-01
        age_days = rng.randrange(25 * 365, 70 * 365)
        birth = date(2024, 1, 1) - timedelta(days=age_days)
        local = romaji(SURNAMES_KANA[si], given_kana) + str(i)
        email = f"{local}@{EMAIL_DOMAINS[i % len(EMAIL_DOMAINS)]}"
        phone = f"090-{rng.randrange(1000, 10000)}-{rng.randrange(1000, 10000)}"
        entered = datetime(2020, 1, 1) + timedelta(
            days=rng.randrange(0, 1500), seconds=rng.randrange(0, 86400)
        )
        updated_at = ""  # mostly null

        rows.append({
            "customer_id":        i,
            "customer_code":      f"C{i:06d}",
            "customer_name":      mask_name(name) if mask else name,
            "customer_name_kana": name_kana,  # kana is not personally identifying
            "birth_date":         iso_date(birth),
            "gender":             gender,
            "email":              mask_email(email) if mask else email,
            "phone":              mask_phone(phone) if mask else phone,
            "created_at":         iso_ts(entered),
            "updated_at":         updated_at,
        })
    return rows


def gen_product(n: int, rng: random.Random) -> list[dict]:
    rows = []
    pool = PRODUCT_POOL[:n] if n <= len(PRODUCT_POOL) else PRODUCT_POOL[:]
    for i, (kind, code, name) in enumerate(pool, start=1):
        if kind == "10":
            price = round(rng.uniform(500, 50000), 2)
        elif kind == "20":
            price = round(rng.uniform(95, 105), 4)  # bonds around par
        else:
            price = round(rng.uniform(8000, 25000), 4)
        entered = datetime(2019, 1, 1) + timedelta(days=rng.randrange(0, 1800))
        rows.append({
            "product_id":     i,
            "product_code":   code,
            "product_name":   name,
            "product_kind":   kind,
            "unit_price":     f"{price}",
            "currency_code":  "JPY",
            "created_at":     iso_ts(entered),
        })
    return rows


def gen_account(n: int, n_customer: int, rng: random.Random) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        cust_id = rng.randint(1, n_customer)  # FK
        kind = "01" if rng.random() < 0.6 else "02"  # 普通 vs 特定
        balance = round(rng.uniform(0, 5_000_000), 2)
        opened = date(2020, 1, 1) + timedelta(days=rng.randrange(0, 1500))
        status = rng.choices(["A", "C", "F"], weights=[80, 15, 5])[0]
        entered = datetime.combine(opened, datetime.min.time()) + timedelta(
            seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "account_id":   i,
            "customer_id":  cust_id,
            "account_no":   f"{rng.randrange(1000, 10000)}-{rng.randrange(100000, 1000000)}",
            "account_kind": kind,
            "balance":      f"{balance}",
            "opened_date":  iso_date(opened),
            "status":       status,
            "created_at":   iso_ts(entered),
            "updated_at":   "",
        })
    return rows


def gen_account_product(
    n: int, n_account: int, n_product: int, rng: random.Random
) -> list[dict]:
    seen: set[tuple[int, int]] = set()
    rows = []
    attempts = 0
    while len(rows) < n and attempts < n * 20:
        attempts += 1
        aid = rng.randint(1, n_account)
        pid = rng.randint(1, n_product)
        if (aid, pid) in seen:
            continue
        seen.add((aid, pid))
        qty = round(rng.uniform(1, 1000), 4)
        start = date(2021, 1, 1) + timedelta(days=rng.randrange(0, 1000))
        end = "" if rng.random() < 0.8 else iso_date(start + timedelta(days=rng.randrange(30, 1000)))
        entered = datetime.combine(start, datetime.min.time()) + timedelta(
            seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "account_id":  aid,
            "product_id":  pid,
            "holding_qty": f"{qty}",
            "start_date":  iso_date(start),
            "end_date":    end,
            "created_at":  iso_ts(entered),
        })
    return rows


def gen_trade(
    n: int, n_account: int, n_product: int, rng: random.Random
) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        aid = rng.randint(1, n_account)
        pid = rng.randint(1, n_product)
        ttype = "B" if rng.random() < 0.55 else "S"
        qty = rng.randint(10, 5000)
        price = round(rng.uniform(95, 50000), 4)
        td = date(2023, 1, 1) + timedelta(days=rng.randrange(0, 700))
        entered = datetime.combine(td, datetime.min.time()) + timedelta(
            seconds=rng.randrange(28800, 64800)  # 08:00–18:00 ish
        )
        rows.append({
            "trade_id":    i,
            "account_id":  aid,
            "product_id":  pid,
            "trade_type":  ttype,
            "trade_qty":   qty,
            "trade_price": f"{price}",
            "trade_date":  iso_date(td),
            "created_at":  iso_ts(entered),
        })
    return rows


# ────────────────────────────────────────────────────────────────────────────
# Output
# ────────────────────────────────────────────────────────────────────────────
COLUMN_ORDER: dict[str, list[str]] = {
    "customer": [
        "customer_id", "customer_code", "customer_name", "customer_name_kana",
        "birth_date", "gender", "email", "phone", "created_at", "updated_at",
    ],
    "product": [
        "product_id", "product_code", "product_name", "product_kind",
        "unit_price", "currency_code", "created_at",
    ],
    "account": [
        "account_id", "customer_id", "account_no", "account_kind",
        "balance", "opened_date", "status", "created_at", "updated_at",
    ],
    "account_product": [
        "account_id", "product_id", "holding_qty",
        "start_date", "end_date", "created_at",
    ],
    "trade": [
        "trade_id", "account_id", "product_id", "trade_type",
        "trade_qty", "trade_price", "trade_date", "created_at",
    ],
}


def write_csv(path: Path, rows: Iterable[dict], columns: list[str]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        for row in rows:
            w.writerow(row)
            n += 1
    return n


# ────────────────────────────────────────────────────────────────────────────
# Driver
# ────────────────────────────────────────────────────────────────────────────
@dataclass
class StageResult:
    stage: str
    counts: dict[str, int]


def generate_stage(stage: str) -> StageResult:
    counts = ROW_COUNTS[stage]
    rng = random.Random(stage_seed(stage))
    mask = stage == "test"

    customers = gen_customer(counts["customer"], rng, mask=mask)
    products  = gen_product(counts["product"], rng)
    accounts  = gen_account(counts["account"], counts["customer"], rng)
    account_products = gen_account_product(
        counts["account_product"], counts["account"], counts["product"], rng,
    )
    trades = gen_trade(counts["trade"], counts["account"], counts["product"], rng)

    out_dir = OUT_ROOT / stage
    rc = {
        "customer":        write_csv(out_dir / "customer.csv",        customers,        COLUMN_ORDER["customer"]),
        "product":         write_csv(out_dir / "product.csv",         products,         COLUMN_ORDER["product"]),
        "account":         write_csv(out_dir / "account.csv",         accounts,         COLUMN_ORDER["account"]),
        "account_product": write_csv(out_dir / "account_product.csv", account_products, COLUMN_ORDER["account_product"]),
        "trade":           write_csv(out_dir / "trade.csv",           trades,           COLUMN_ORDER["trade"]),
    }
    return StageResult(stage=stage, counts=rc)


def main() -> int:
    print(f"Repo root: {REPO_ROOT}")
    print(f"Output:    {OUT_ROOT}")
    for stage in STAGES:
        r = generate_stage(stage)
        print(f"  [{stage:7}] customer={r.counts['customer']:4}  "
              f"product={r.counts['product']:3}  "
              f"account={r.counts['account']:4}  "
              f"account_product={r.counts['account_product']:4}  "
              f"trade={r.counts['trade']:4}")
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
