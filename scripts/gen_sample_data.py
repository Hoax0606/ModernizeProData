#!/usr/bin/env python3
"""Generate stage-keyed sample CSVs for both TO-BE (PostgreSQL) and AS-IS (Oracle extract).

Outputs:
  db/sample_data/tobe/{stage}/{table}.csv          — UTF-8 BOM, LF, Excel-friendly
  db/sample_data/asis/{stage}/{ORACLE_TABLE}.csv   — UTF-8 no BOM, CRLF, ops-extract style

Stages: dev / test / staging / prod
Tables: customer, product, branch, employee, account, account_product, trade, market_quote, settlement

- Deterministic: same seed per stage → byte-identical CSVs on every run.
- FK integrity: customer → product → branch → employee → account → account_product → trade → market_quote → settlement.
- Self-ref FK guarded: employee.manager_id and branch.parent_branch_id always reference smaller ids.
- Masking applied to the TO-BE `test` stage only (customer_name, email, phone). AS-IS extracts are never masked (operations dump is raw).
- Encodings:
    TO-BE  → UTF-8 with BOM  (Excel mojibake-free)
    AS-IS  → UTF-8 no BOM, CRLF  (canonical Oracle SQL*Plus / nightly extract style)

Run from repo root:
    python3 scripts/gen_sample_data.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT_TOBE = REPO_ROOT / "db" / "sample_data" / "tobe"
OUT_ROOT_ASIS = REPO_ROOT / "db" / "sample_data" / "asis"

STAGES = ("dev", "test", "staging", "prod")

# ────────────────────────────────────────────────────────────────────────────
# Row counts per stage
# ────────────────────────────────────────────────────────────────────────────
ROW_COUNTS: dict[str, dict[str, int]] = {
    "dev":     {"customer":  10, "product":  8, "branch":  5,  "employee":  12, "account":  15, "account_product":  18, "trade":  20, "market_quote":  30, "settlement":  15},
    "test":    {"customer":  50, "product": 20, "branch":  8,  "employee":  40, "account":  80, "account_product":  90, "trade": 100, "market_quote": 150, "settlement":  80},
    "staging": {"customer": 100, "product": 40, "branch": 12,  "employee":  80, "account": 180, "account_product": 200, "trade": 200, "market_quote": 400, "settlement": 160},
    "prod":    {"customer": 200, "product": 60, "branch": 20,  "employee": 150, "account": 380, "account_product": 420, "trade": 400, "market_quote":1000, "settlement": 320},
}

# ────────────────────────────────────────────────────────────────────────────
# Japanese name pools
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

EMAIL_DOMAINS = ["example.jp", "example.co.jp", "test.jp"]

# ────────────────────────────────────────────────────────────────────────────
# Product pool (securities domain)
# ────────────────────────────────────────────────────────────────────────────
PRODUCT_POOL: list[tuple[str, str, str]] = [
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

# ────────────────────────────────────────────────────────────────────────────
# Branch pool — (code, name, parent_code or None). Parent must appear before child.
# ────────────────────────────────────────────────────────────────────────────
BRANCH_POOL: list[tuple[str, str, str | None]] = [
    ("HQ001", "本部",         None),
    ("BR001", "東京本店",     "HQ001"),
    ("BR002", "大阪本店",     "HQ001"),
    ("BR003", "渋谷支店",     "BR001"),
    ("BR004", "新宿支店",     "BR001"),
    ("BR005", "横浜支店",     "BR001"),
    ("BR006", "千葉支店",     "BR001"),
    ("BR007", "梅田支店",     "BR002"),
    ("BR008", "難波支店",     "BR002"),
    ("BR009", "京都支店",     "BR002"),
    ("BR010", "名古屋支店",   "HQ001"),
    ("BR011", "福岡支店",     "HQ001"),
    ("BR012", "札幌支店",     "HQ001"),
    ("BR013", "仙台支店",     "HQ001"),
    ("BR014", "広島支店",     "BR002"),
    ("BR015", "神戸支店",     "BR002"),
    ("BR016", "天王寺支店",   "BR002"),
    ("BR017", "鎌倉出張所",   "BR005"),
    ("BR018", "立川出張所",   "BR001"),
    ("BR019", "さいたま支店", "BR001"),
]

ADDRESS_POOL = [
    "東京都千代田区大手町1-1-1",
    "東京都中央区銀座2-3-4",
    "東京都港区六本木3-1-2",
    "東京都新宿区西新宿2-8-1",
    "東京都渋谷区道玄坂1-9-2",
    "東京都目黒区中目黒1-4-5",
    "大阪府大阪市北区梅田1-1-3",
    "大阪府大阪市中央区難波5-1-60",
    "神奈川県横浜市西区高島2-19-12",
    "愛知県名古屋市中村区名駅1-1-4",
    "福岡県福岡市中央区天神2-14-13",
    "北海道札幌市中央区大通西4-1",
    "京都府京都市下京区烏丸通四条下る5",
    "兵庫県神戸市中央区三宮町1-1-1",
    "宮城県仙台市青葉区中央1-2-3",
    "広島県広島市中区基町6-78",
]

EMPLOYEE_ROLES = ["営業", "営業", "営業", "営業", "営業", "管理", "管理", "事務", "事務", "事務", "監査", "IT"]
TRADE_SOURCES = ["EXCHANGE", "OTC", "EXCHANGE", "EXCHANGE"]

# ────────────────────────────────────────────────────────────────────────────
# ASIS Oracle column name mapping per TO-BE table
# ────────────────────────────────────────────────────────────────────────────
ASIS_COLUMN_MAP: dict[str, dict[str, str]] = {
    "customer": {
        "customer_id":        "CUSTOMER_ID",
        "customer_code":      "CUSTOMER_CD",
        "customer_name":      "CUSTOMER_NM",
        "customer_name_kana": "CUSTOMER_NM_KANA",
        "birth_date":         "BIRTH_DT",
        "gender":             "GENDER_CD",
        "email":              "EMAIL",
        "phone":              "PHONE",
        "created_at":         "ENTRY_TS",
        "updated_at":         "UPDATE_TS",
    },
    "product": {
        "product_id":     "PRODUCT_ID",
        "product_code":   "PRODUCT_CD",
        "product_name":   "PRODUCT_NM",
        "product_kind":   "PRODUCT_KIND_CD",
        "unit_price":     "UNIT_PRICE",
        "currency_code":  "CURRENCY_CD",
        "created_at":     "ENTRY_TS",
    },
    "branch": {
        "branch_id":        "BRANCH_ID",
        "branch_code":      "BRANCH_CD",
        "branch_name":      "BRANCH_NM",
        "parent_branch_id": "PARENT_BRANCH_ID",
        "address":          "ADDRESS",
        "opened_date":      "OPENED_DT",
        "is_active":        "ACTIVE_FLG",
        "created_at":       "ENTRY_TS",
    },
    "employee": {
        "employee_id":   "EMPLOYEE_ID",
        "employee_code": "EMPLOYEE_CD",
        "employee_name": "EMPLOYEE_NM",
        "branch_id":     "BRANCH_ID",
        "manager_id":    "MANAGER_ID",
        "role":          "ROLE_CD",
        "email":         "EMAIL",
        "hired_date":    "HIRED_DT",
        "is_active":     "ACTIVE_FLG",
        "created_at":    "ENTRY_TS",
    },
    "account": {
        "account_id":   "ACCOUNT_ID",
        "customer_id":  "CUSTOMER_ID",
        "branch_id":    "BRANCH_ID",
        "account_no":   "ACCOUNT_NO",
        "account_kind": "ACCOUNT_KIND_CD",
        "balance":      "BALANCE",
        "opened_date":  "OPENED_DT",
        "status":       "STATUS_CD",
        "created_at":   "ENTRY_TS",
        "updated_at":   "UPDATE_TS",
    },
    "account_product": {
        "account_id":  "ACCOUNT_ID",
        "product_id":  "PRODUCT_ID",
        "holding_qty": "HOLDING_QTY",
        "start_date":  "START_DT",
        "end_date":    "END_DT",
        "created_at":  "ENTRY_TS",
    },
    "trade": {
        "trade_id":    "TRADE_ID",
        "account_id":  "ACCOUNT_ID",
        "product_id":  "PRODUCT_ID",
        "trade_type":  "TRADE_TYPE_CD",
        "trade_qty":   "TRADE_QTY",
        "trade_price": "TRADE_PRICE",
        "trade_date":  "TRADE_DT",
        "created_at":  "ENTRY_TS",
    },
    "settlement": {
        "trade_id":          "TRADE_ID",
        "settlement_date":   "SETTLEMENT_DT",
        "account_id":        "ACCOUNT_ID",
        "settlement_amount": "SETTLEMENT_AMOUNT",
        "fee":               "FEE",
        "status":            "STATUS_CD",
        "settled_at":        "SETTLED_TS",
        "created_at":        "ENTRY_TS",
    },
}


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────
def stage_seed(stage: str) -> int:
    h = hashlib.sha256(stage.encode("utf-8")).hexdigest()
    return int(h[:16], 16)


def romaji(surname_kana: str, given_kana: str) -> str:
    pool = "abcdefghijklmnopqrstuvwxyz"
    src = surname_kana + given_kana
    return "".join(pool[ord(ch) % 26] for ch in src)[:8]


def mask_name(name: str) -> str:
    parts = name.split(" ", 1)
    if len(parts) != 2:
        return name
    surname, given = parts
    return f"{surname} {'*' * len(given)}"


def mask_email(email: str) -> str:
    if "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        return f"{local}****@{domain}"
    return f"{local[:2]}****@{domain}"


def mask_phone(phone: str) -> str:
    segs = phone.split("-")
    if len(segs) != 3:
        return phone
    return f"{segs[0]}-****-{segs[2]}"


def iso_date(d: date) -> str:
    return d.isoformat()


def iso_ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# ────────────────────────────────────────────────────────────────────────────
# Generators
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
        age_days = rng.randrange(25 * 365, 70 * 365)
        birth = date(2024, 1, 1) - timedelta(days=age_days)
        local = romaji(SURNAMES_KANA[si], given_kana) + str(i)
        email = f"{local}@{EMAIL_DOMAINS[i % len(EMAIL_DOMAINS)]}"
        phone = f"090-{rng.randrange(1000, 10000)}-{rng.randrange(1000, 10000)}"
        entered = datetime(2020, 1, 1) + timedelta(
            days=rng.randrange(0, 1500), seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "customer_id":        i,
            "customer_code":      f"C{i:06d}",
            "customer_name":      mask_name(name) if mask else name,
            "customer_name_kana": name_kana,
            "birth_date":         iso_date(birth),
            "gender":             gender,
            "email":              mask_email(email) if mask else email,
            "phone":              mask_phone(phone) if mask else phone,
            "created_at":         iso_ts(entered),
            "updated_at":         "",
        })
    return rows


def gen_product(n: int, rng: random.Random) -> list[dict]:
    rows = []
    pool = PRODUCT_POOL[:n] if n <= len(PRODUCT_POOL) else PRODUCT_POOL[:]
    for i, (kind, code, name) in enumerate(pool, start=1):
        if kind == "10":
            price = round(rng.uniform(500, 50000), 2)
        elif kind == "20":
            price = round(rng.uniform(95, 105), 4)
        else:
            price = round(rng.uniform(8000, 25000), 4)
        entered = datetime(2019, 1, 1) + timedelta(days=rng.randrange(0, 1800))
        rows.append({
            "product_id":    i,
            "product_code":  code,
            "product_name":  name,
            "product_kind":  kind,
            "unit_price":    f"{price}",
            "currency_code": "JPY",
            "created_at":    iso_ts(entered),
        })
    return rows


def gen_branch(n: int, rng: random.Random) -> list[dict]:
    """Branch with self-ref FK parent_branch_id. Parent always has smaller id."""
    pool = BRANCH_POOL[:n] if n <= len(BRANCH_POOL) else BRANCH_POOL[:]
    code_to_id = {code: i for i, (code, _, _) in enumerate(pool, start=1)}
    rows = []
    for i, (code, name, parent_code) in enumerate(pool, start=1):
        parent_id: int | str = code_to_id[parent_code] if parent_code else ""
        if isinstance(parent_id, int) and parent_id >= i:
            parent_id = ""  # safety net
        address = ADDRESS_POOL[i % len(ADDRESS_POOL)]
        opened = date(2010, 4, 1) + timedelta(days=rng.randrange(0, 4500))
        active = rng.random() > 0.05
        entered = datetime.combine(opened, datetime.min.time()) + timedelta(
            seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "branch_id":        i,
            "branch_code":      code,
            "branch_name":      name,
            "parent_branch_id": parent_id,
            "address":          address,
            "opened_date":      iso_date(opened),
            "is_active":        active,
            "created_at":       iso_ts(entered),
        })
    return rows


def gen_employee(n: int, n_branch: int, rng: random.Random) -> list[dict]:
    """manager_id always references a previously-inserted (smaller id) employee."""
    rows = []
    for i in range(1, n + 1):
        si = rng.randrange(len(SURNAMES))
        is_male = rng.random() < 0.6
        given_pool = GIVEN_M if is_male else GIVEN_F
        gi = rng.randrange(len(given_pool))
        name = f"{SURNAMES[si]} {given_pool[gi]}"
        branch_id = rng.randint(1, n_branch)
        if i <= max(1, n // 10):
            manager_id: int | str = ""
        else:
            manager_id = rng.randint(1, max(1, i - 1))
        role = rng.choice(EMPLOYEE_ROLES)
        email = f"emp{i:05d}@{EMAIL_DOMAINS[i % len(EMAIL_DOMAINS)]}"
        hired = date(2015, 4, 1) + timedelta(days=rng.randrange(0, 3500))
        active = rng.random() > 0.10
        entered = datetime.combine(hired, datetime.min.time()) + timedelta(
            seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "employee_id":   i,
            "employee_code": f"E{i:06d}",
            "employee_name": name,
            "branch_id":     branch_id,
            "manager_id":    manager_id,
            "role":          role,
            "email":         email,
            "hired_date":    iso_date(hired),
            "is_active":     active,
            "created_at":    iso_ts(entered),
        })
    return rows


def gen_account(n: int, n_customer: int, n_branch: int, rng: random.Random) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        cust_id = rng.randint(1, n_customer)
        branch_id = rng.randint(1, n_branch)
        kind = "01" if rng.random() < 0.6 else "02"
        balance = round(rng.uniform(0, 5_000_000), 2)
        opened = date(2020, 1, 1) + timedelta(days=rng.randrange(0, 1500))
        status = rng.choices(["A", "C", "F"], weights=[80, 15, 5])[0]
        entered = datetime.combine(opened, datetime.min.time()) + timedelta(
            seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "account_id":   i,
            "customer_id":  cust_id,
            "branch_id":    branch_id,
            "account_no":   f"{rng.randrange(1000, 10000)}-{rng.randrange(100000, 1000000)}",
            "account_kind": kind,
            "balance":      f"{balance}",
            "opened_date":  iso_date(opened),
            "status":       status,
            "created_at":   iso_ts(entered),
            "updated_at":   "",
        })
    return rows


def gen_account_product(n: int, n_account: int, n_product: int, rng: random.Random) -> list[dict]:
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


def gen_trade(n: int, n_account: int, n_product: int, rng: random.Random) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        aid = rng.randint(1, n_account)
        pid = rng.randint(1, n_product)
        ttype = "B" if rng.random() < 0.55 else "S"
        qty = rng.randint(10, 5000)
        price = round(rng.uniform(95, 50000), 4)
        td = date(2023, 1, 1) + timedelta(days=rng.randrange(0, 700))
        entered = datetime.combine(td, datetime.min.time()) + timedelta(
            seconds=rng.randrange(28800, 64800)
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


def gen_market_quote(n: int, n_product: int, rng: random.Random) -> list[dict]:
    """TOBE: source + payload JSONB. ASIS: BID_PRICE/ASK_PRICE/VOLUME split + PAYLOAD_JSON."""
    rows = []
    for i in range(1, n + 1):
        pid = rng.randint(1, n_product)
        ts = datetime(2024, 1, 1) + timedelta(
            days=rng.randrange(0, 400), seconds=rng.randrange(0, 86400)
        )
        bid = round(rng.uniform(95, 50000), 4)
        ask = round(bid + rng.uniform(0.01, 5), 4)
        volume = rng.randint(100, 1_000_000)
        source = rng.choice(TRADE_SOURCES)
        payload = json.dumps(
            {"bid": bid, "ask": ask, "volume": volume, "spread": round(ask - bid, 4)},
            ensure_ascii=False,
        )
        rows.append({
            "quote_id":   i,
            "product_id": pid,
            "quote_ts":   iso_ts(ts),
            "bid":        bid,
            "ask":        ask,
            "volume":     volume,
            "source":     source,
            "payload":    payload,
        })
    return rows


def gen_settlement(n: int, trade_rows: list[dict], rng: random.Random) -> list[dict]:
    """Settlement references trade. settlement_date = trade_date + T+2."""
    if not trade_rows:
        return []
    chosen = rng.sample(trade_rows, min(n, len(trade_rows)))
    rows = []
    for t in chosen:
        td = datetime.strptime(t["trade_date"], "%Y-%m-%d").date()
        settle_dt = td + timedelta(days=2)
        amount = round(float(t["trade_price"]) * int(t["trade_qty"]), 2)
        fee = round(amount * 0.001, 2)
        status = rng.choices(["S", "P", "F"], weights=[75, 20, 5])[0]
        settled_at = ""
        if status == "S":
            settled_at = iso_ts(
                datetime.combine(settle_dt, datetime.min.time())
                + timedelta(hours=rng.randint(9, 17))
            )
        entered = datetime.combine(settle_dt, datetime.min.time()) + timedelta(
            seconds=rng.randrange(0, 86400)
        )
        rows.append({
            "trade_id":          t["trade_id"],
            "settlement_date":   iso_date(settle_dt),
            "account_id":        t["account_id"],
            "settlement_amount": f"{amount}",
            "fee":               f"{fee}",
            "status":            status,
            "settled_at":        settled_at,
            "created_at":        iso_ts(entered),
        })
    return rows


# ────────────────────────────────────────────────────────────────────────────
# Column order (TOBE)
# ────────────────────────────────────────────────────────────────────────────
COLUMN_ORDER: dict[str, list[str]] = {
    "customer":        ["customer_id", "customer_code", "customer_name", "customer_name_kana", "birth_date", "gender", "email", "phone", "created_at", "updated_at"],
    "product":         ["product_id", "product_code", "product_name", "product_kind", "unit_price", "currency_code", "created_at"],
    "branch":          ["branch_id", "branch_code", "branch_name", "parent_branch_id", "address", "opened_date", "is_active", "created_at"],
    "employee":        ["employee_id", "employee_code", "employee_name", "branch_id", "manager_id", "role", "email", "hired_date", "is_active", "created_at"],
    "account":         ["account_id", "customer_id", "branch_id", "account_no", "account_kind", "balance", "opened_date", "status", "created_at", "updated_at"],
    "account_product": ["account_id", "product_id", "holding_qty", "start_date", "end_date", "created_at"],
    "trade":           ["trade_id", "account_id", "product_id", "trade_type", "trade_qty", "trade_price", "trade_date", "created_at"],
    "market_quote":    ["quote_id", "product_id", "quote_ts", "source", "payload"],
    "settlement":      ["trade_id", "settlement_date", "account_id", "settlement_amount", "fee", "status", "settled_at", "created_at"],
}


# ────────────────────────────────────────────────────────────────────────────
# CSV writers
# ────────────────────────────────────────────────────────────────────────────
def _tobe_cell(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    return v


def _asis_cell(v):
    if isinstance(v, bool):
        return "Y" if v else "N"
    return v


def write_csv_tobe(path: Path, rows: Iterable[dict], columns: list[str]) -> int:
    """TO-BE CSV: UTF-8 BOM, LF, Excel-friendly."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(columns)
        for row in rows:
            w.writerow([_tobe_cell(row.get(c, "")) for c in columns])
            n += 1
    return n


def write_csv_asis(path: Path, rows: Iterable[dict], columns: list[str], asis_mapping: dict[str, str]) -> int:
    """AS-IS CSV: UTF-8 NO BOM, CRLF, Oracle uppercase headers."""
    path.parent.mkdir(parents=True, exist_ok=True)
    headers = [asis_mapping[c] for c in columns]
    n = 0
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
        w.writerow(headers)
        for row in rows:
            w.writerow([_asis_cell(row.get(c, "")) for c in columns])
            n += 1
    return n


def write_asis_market_quote(path: Path, rows: Iterable[dict]) -> int:
    """ASIS market_quote uses legacy split layout (separate BID/ASK/VOLUME columns)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    headers = ["QUOTE_ID", "PRODUCT_ID", "QUOTE_TS", "BID_PRICE", "ASK_PRICE", "VOLUME", "SOURCE_CD", "PAYLOAD_JSON"]
    n = 0
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
        w.writerow(headers)
        for r in rows:
            w.writerow([
                r["quote_id"], r["product_id"], r["quote_ts"],
                r["bid"], r["ask"], r["volume"], r["source"], r["payload"],
            ])
            n += 1
    return n


# ────────────────────────────────────────────────────────────────────────────
# Driver
# ────────────────────────────────────────────────────────────────────────────
def generate_stage(stage: str) -> dict[str, int]:
    counts = ROW_COUNTS[stage]
    rng = random.Random(stage_seed(stage))
    mask = (stage == "test")

    customers = gen_customer(counts["customer"], rng, mask=mask)
    products  = gen_product(counts["product"], rng)
    branches  = gen_branch(counts["branch"], rng)
    employees = gen_employee(counts["employee"], counts["branch"], rng)
    accounts  = gen_account(counts["account"], counts["customer"], counts["branch"], rng)
    account_products = gen_account_product(counts["account_product"], counts["account"], counts["product"], rng)
    trades = gen_trade(counts["trade"], counts["account"], counts["product"], rng)
    quotes = gen_market_quote(counts["market_quote"], counts["product"], rng)
    settlements = gen_settlement(counts["settlement"], trades, rng)

    tobe_dir = OUT_ROOT_TOBE / stage
    asis_dir = OUT_ROOT_ASIS / stage

    out: dict[str, int] = {}
    out["customer"]        = write_csv_tobe(tobe_dir / "customer.csv",        customers,        COLUMN_ORDER["customer"])
    out["product"]         = write_csv_tobe(tobe_dir / "product.csv",         products,         COLUMN_ORDER["product"])
    out["branch"]          = write_csv_tobe(tobe_dir / "branch.csv",          branches,         COLUMN_ORDER["branch"])
    out["employee"]        = write_csv_tobe(tobe_dir / "employee.csv",        employees,        COLUMN_ORDER["employee"])
    out["account"]         = write_csv_tobe(tobe_dir / "account.csv",         accounts,         COLUMN_ORDER["account"])
    out["account_product"] = write_csv_tobe(tobe_dir / "account_product.csv", account_products, COLUMN_ORDER["account_product"])
    out["trade"]           = write_csv_tobe(tobe_dir / "trade.csv",           trades,           COLUMN_ORDER["trade"])
    out["market_quote"]    = write_csv_tobe(tobe_dir / "market_quote.csv",    quotes,           COLUMN_ORDER["market_quote"])
    out["settlement"]      = write_csv_tobe(tobe_dir / "settlement.csv",      settlements,      COLUMN_ORDER["settlement"])

    write_csv_asis(asis_dir / "M_CUSTOMER.csv",        customers,        COLUMN_ORDER["customer"],        ASIS_COLUMN_MAP["customer"])
    write_csv_asis(asis_dir / "M_PRODUCT.csv",         products,         COLUMN_ORDER["product"],         ASIS_COLUMN_MAP["product"])
    write_csv_asis(asis_dir / "M_BRANCH.csv",          branches,         COLUMN_ORDER["branch"],          ASIS_COLUMN_MAP["branch"])
    write_csv_asis(asis_dir / "M_EMPLOYEE.csv",        employees,        COLUMN_ORDER["employee"],        ASIS_COLUMN_MAP["employee"])
    write_csv_asis(asis_dir / "M_ACCOUNT.csv",         accounts,         COLUMN_ORDER["account"],         ASIS_COLUMN_MAP["account"])
    write_csv_asis(asis_dir / "R_ACCOUNT_PRODUCT.csv", account_products, COLUMN_ORDER["account_product"], ASIS_COLUMN_MAP["account_product"])
    write_csv_asis(asis_dir / "T_TRADE.csv",           trades,           COLUMN_ORDER["trade"],           ASIS_COLUMN_MAP["trade"])
    write_asis_market_quote(asis_dir / "T_MARKET_QUOTE.csv", quotes)
    write_csv_asis(asis_dir / "T_SETTLEMENT.csv",      settlements,      COLUMN_ORDER["settlement"],      ASIS_COLUMN_MAP["settlement"])

    return out


def main() -> int:
    print(f"Repo root: {REPO_ROOT}")
    print(f"TOBE out:  {OUT_ROOT_TOBE}")
    print(f"ASIS out:  {OUT_ROOT_ASIS}")
    for stage in STAGES:
        c = generate_stage(stage)
        print(f"  [{stage:7}] " + "  ".join(f"{k}={v}" for k, v in c.items()))
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
