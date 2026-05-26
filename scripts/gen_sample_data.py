#!/usr/bin/env python3
"""
Generate sample CSVs for both AS-IS (Oracle extract) and TO-BE (PostgreSQL).

새 schema (16 + 18 tables). 매핑 시나리오를 의도적으로 포함:
  - 1:N column split  : CUST_ADDR → zip/prefecture/city/street_line1/2
                        CUST_NM_FULL → family_kanji/given_kanji
                        KOZA_KBN 4桁 → account_type/member_tier/permission_flag
                        TANTO_CD 8桁 → department_code/position_code/permission_flag
  - 1:N table  split  : T_TRADE (wide) → trade + trade_fee + trade_settlement_link
                        M_PRODUCT_HIST.CLOB → product_history.old/new_snapshot JSONB
  - N:1 table  merge  : M_BRANCH + M_BRANCH_CONTACT → branch
                        M_CUSTOMER_KANA + M_CUSTOMER 의 일부 → customer_name
  - code value mapping: GENDER 1/2 → M/F, TORIHIKI_KBN 1/2/3 → BUY/SELL/TRANSFER
                        BRANCH_KBN 01/02/03/04 → HQ/BRANCH/SATELLITE/ONLINE
                        STATUS_CD A/C/F/P → ACTIVE/CLOSED/FROZEN/PENDING

Outputs:
  db/sample_data/asis/{stage}/{ORACLE_TABLE}.csv   — UTF-8 no BOM, CRLF, uppercase headers
  db/sample_data/tobe/{stage}/{table}.csv          — UTF-8 BOM, LF, snake_case headers

Run from repo root:
    python scripts/gen_sample_data.py            # all stages
    python scripts/gen_sample_data.py dev test   # only those stages
"""
from __future__ import annotations

import csv
import json
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

# Make sibling module importable whether run from repo root or scripts/ dir.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixtures_jp as F   # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_ASIS = REPO_ROOT / "db" / "sample_data" / "asis"
OUT_TOBE = REPO_ROOT / "db" / "sample_data" / "tobe"

ALL_STAGES = ("dev", "test", "staging", "prod")

# ────────────────────────────────────────────────────────────────────────────
# Row counts per stage (driven by user spec: dev=light, prod=heavy).
# Numbers are tuned so trade≈customer×1, market_quote≈product×days, etc.
# Tables not listed are derived (e.g. customer_name is per-customer 1:1).
# ────────────────────────────────────────────────────────────────────────────
ROW_COUNTS: dict[str, dict[str, int]] = {
    "dev": {
        "customer": 100, "product": 50, "branch": 5, "employee": 20,
        "account": 150, "account_product": 200, "trade": 500,
        "trade_detail_per_trade_max": 2, "trade_log_per_trade": 2,
        "market_quote_days": 30,  "settlement": 500, "product_history": 100,
    },
    "test": {
        "customer": 5000, "product": 200, "branch": 20, "employee": 100,
        "account": 8000, "account_product": 10000, "trade": 10000,
        "trade_detail_per_trade_max": 2, "trade_log_per_trade": 2,
        "market_quote_days": 60, "settlement": 9000, "product_history": 1000,
    },
    "staging": {
        "customer": 50000, "product": 500, "branch": 50, "employee": 500,
        "account": 80000, "account_product": 100000, "trade": 100000,
        "trade_detail_per_trade_max": 1, "trade_log_per_trade": 2,
        "market_quote_days": 120, "settlement": 90000, "product_history": 5000,
    },
    "prod": {
        "customer": 500000, "product": 1000, "branch": 200, "employee": 2000,
        "account": 800000, "account_product": 1000000, "trade": 1000000,
        "trade_detail_per_trade_max": 1, "trade_log_per_trade": 1,
        "market_quote_days": 250, "settlement": 900000, "product_history": 50000,
    },
}

# Deterministic seed per stage so re-runs produce byte-identical CSVs.
STAGE_SEEDS = {"dev": 1001, "test": 1002, "staging": 1003, "prod": 1004}


# ────────────────────────────────────────────────────────────────────────────
# CSV writer helpers — AS-IS vs TO-BE differ by encoding/EOL/header case.
# ────────────────────────────────────────────────────────────────────────────
class AsIsWriter:
    """Oracle extract style: UTF-8 no BOM, CRLF, UPPERCASE headers, empty string for NULL."""
    def __init__(self, path: Path, headers: list[str]):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(path, "w", encoding="utf-8", newline="")
        self.w = csv.writer(self.f, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
        self.w.writerow([h.upper() for h in headers])

    def write(self, row: list):
        self.w.writerow(["" if v is None else v for v in row])

    def close(self):
        self.f.close()


class ToBeWriter:
    """TO-BE PG style: UTF-8 with BOM, LF, snake_case headers, empty string for NULL."""
    def __init__(self, path: Path, headers: list[str]):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write BOM manually then UTF-8 (utf-8-sig appends ZWNBSP on each row in some libs).
        self.f = open(path, "wb")
        self.f.write(b"\xef\xbb\xbf")
        self.f.close()
        self.f = open(path, "a", encoding="utf-8", newline="")
        self.w = csv.writer(self.f, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
        self.w.writerow(headers)

    def write(self, row: list):
        self.w.writerow(["" if v is None else v for v in row])

    def close(self):
        self.f.close()


# ────────────────────────────────────────────────────────────────────────────
# Utility — sample helpers
# ────────────────────────────────────────────────────────────────────────────
def random_date(rnd: random.Random, start: date, end: date) -> date:
    days = (end - start).days
    return start + timedelta(days=rnd.randrange(days + 1))


def fmt_oracle_dt(d: date | datetime | None) -> str | None:
    """Oracle DATE / TIMESTAMP literal form used in nightly extracts."""
    if d is None:
        return None
    if isinstance(d, datetime):
        return d.strftime("%Y-%m-%d %H:%M:%S")
    return d.strftime("%Y-%m-%d")


def fmt_pg_ts(d: datetime | None) -> str | None:
    if d is None:
        return None
    return d.strftime("%Y-%m-%d %H:%M:%S")


def jp_zip(rnd: random.Random) -> str:
    return f"{rnd.randint(100, 999):03d}-{rnd.randint(0, 9999):04d}"


def fictional_address(rnd: random.Random):
    pref_kj, pref_kn, city = rnd.choice(F.PREFECTURES)
    block = f"{rnd.randint(1, 9)}-{rnd.randint(1, 30)}-{rnd.randint(1, 30)}"
    bldg_choices = ["", "メゾン桜", "プラザビル", "中央タワー", "サンライズ館"]
    bldg = rnd.choice(bldg_choices)
    return pref_kj, city, block, bldg


def jp_phone(rnd: random.Random) -> str:
    return f"0{rnd.randint(3, 9)}-{rnd.randint(1000, 9999)}-{rnd.randint(1000, 9999)}"


def jp_email(rnd: random.Random, romaji_seed: str) -> str:
    domain = rnd.choice(["example.jp", "example.co.jp", "test.jp", "modernizepro.jp"])
    suffix = rnd.randint(1, 9999)
    return f"{romaji_seed.lower().replace(' ', '')}.{suffix}@{domain}"


def to_romaji(family_kana: str, given_kana: str) -> str:
    """Crude katakana → romaji.  Good enough for sample addresses / emails."""
    table = str.maketrans({
        "ア": "A", "イ": "I", "ウ": "U", "エ": "E", "オ": "O",
        "カ": "KA", "キ": "KI", "ク": "KU", "ケ": "KE", "コ": "KO",
        "サ": "SA", "シ": "SHI", "ス": "SU", "セ": "SE", "ソ": "SO",
        "タ": "TA", "チ": "CHI", "ツ": "TSU", "テ": "TE", "ト": "TO",
        "ナ": "NA", "ニ": "NI", "ヌ": "NU", "ネ": "NE", "ノ": "NO",
        "ハ": "HA", "ヒ": "HI", "フ": "FU", "ヘ": "HE", "ホ": "HO",
        "マ": "MA", "ミ": "MI", "ム": "MU", "メ": "ME", "モ": "MO",
        "ヤ": "YA", "ユ": "YU", "ヨ": "YO",
        "ラ": "RA", "リ": "RI", "ル": "RU", "レ": "RE", "ロ": "RO",
        "ワ": "WA", "ン": "N", "ガ": "GA", "ギ": "GI", "グ": "GU",
        "ゲ": "GE", "ゴ": "GO", "ザ": "ZA", "ジ": "JI", "ズ": "ZU",
        "ゼ": "ZE", "ゾ": "ZO", "ダ": "DA", "ヂ": "JI", "ヅ": "ZU",
        "デ": "DE", "ド": "DO", "バ": "BA", "ビ": "BI", "ブ": "BU",
        "ベ": "BE", "ボ": "BO", "パ": "PA", "ピ": "PI", "プ": "PU",
        "ペ": "PE", "ポ": "PO", "ョ": "YO", "ュ": "YU", "ャ": "YA",
        "ッ": "", "ー": "",
    })
    fam = "".join(c if c.isascii() else c.translate(table) for c in family_kana)
    giv = "".join(c if c.isascii() else c.translate(table) for c in given_kana)
    return f"{fam} {giv}"


# ────────────────────────────────────────────────────────────────────────────
# Main: generate one stage end-to-end.
# ────────────────────────────────────────────────────────────────────────────
def generate_stage(stage: str) -> dict[str, int]:
    """Generate all AS-IS + TO-BE CSVs for one stage. Returns row counts."""
    rnd = random.Random(STAGE_SEEDS[stage])
    cfg = ROW_COUNTS[stage]
    asis_dir = OUT_ASIS / stage
    tobe_dir = OUT_TOBE / stage
    asis_dir.mkdir(parents=True, exist_ok=True)
    tobe_dir.mkdir(parents=True, exist_ok=True)

    counts: dict[str, int] = {}
    today = date(2026, 5, 26)

    # ---------- 07_code: M_CODE_MASTER / M_CURRENCY (small + static) -----
    w_code_asis = AsIsWriter(asis_dir / "M_CODE_MASTER.csv",
                             ["DOMAIN_CD", "SOURCE_CD", "TARGET_CD", "LABEL_JA", "LABEL_EN",
                              "SORT_NO", "ACTIVE_FLG", "ENTRY_TS", "UPDATE_TS"])
    w_code_tobe = ToBeWriter(tobe_dir / "code_dictionary.csv",
                             ["domain", "source_code", "target_code", "label_ja", "label_en",
                              "sort_order", "active", "created_at", "updated_at"])
    now = datetime(2026, 1, 1, 9, 0, 0)
    for (domain, src, tgt, ja, en, sort) in F.CODE_DICTIONARY:
        w_code_asis.write([domain, src, tgt, ja, en, sort, "Y", fmt_oracle_dt(now), None])
        w_code_tobe.write([domain, src, tgt, ja, en, sort, "true", fmt_pg_ts(now), None])
    w_code_asis.close()
    w_code_tobe.close()
    counts["code_dictionary"] = len(F.CODE_DICTIONARY)

    w_cur_asis = AsIsWriter(asis_dir / "M_CURRENCY.csv",
                            ["CURRENCY_CD", "CURRENCY_NM_JA", "CURRENCY_NM_EN",
                             "DECIMAL_DIGITS", "SYMBOL"])
    w_cur_tobe = ToBeWriter(tobe_dir / "currency.csv",
                            ["currency_code", "name_ja", "name_en",
                             "decimal_digits", "symbol"])
    for (code, ja, en, dig, sym) in F.CURRENCIES:
        w_cur_asis.write([code, ja, en, dig, sym])
        w_cur_tobe.write([code, ja, en, dig, sym])
    w_cur_asis.close()
    w_cur_tobe.close()
    counts["currency"] = len(F.CURRENCIES)

    # ---------- 02_organization: M_BRANCH / M_BRANCH_CONTACT → branch ----
    n_branch = cfg["branch"]
    w_br_asis = AsIsWriter(asis_dir / "M_BRANCH.csv",
                           ["BRANCH_ID", "SHITEN_CD", "SHITEN_NM", "SHITEN_NM_KANA",
                            "BRANCH_KBN", "PARENT_BRANCH_ID", "OPEN_DT", "CLOSE_DT",
                            "ENTRY_TS", "UPDATE_TS"])
    w_brc_asis = AsIsWriter(asis_dir / "M_BRANCH_CONTACT.csv",
                            ["BRANCH_ID", "PHONE", "FAX", "EMAIL", "ADDR_ZIP",
                             "ADDR_LINE", "OPENING_HOURS"])
    w_br_tobe = ToBeWriter(tobe_dir / "branch.csv",
                           ["branch_id", "branch_code", "branch_kind", "parent_branch_id",
                            "name_kanji", "name_kana", "phone", "fax", "email",
                            "zip", "address_line", "opening_hours",
                            "opened_at", "closed_at", "created_at", "updated_at"])

    branches: list[tuple[int, str]] = []  # (branch_id, currency hint)
    for i in range(1, n_branch + 1):
        if i == 1:
            kj, kn = "東京本店", "トウキョウホンテン"
            kbn = "01"; parent = None
            kind_pg = "HQ"
        else:
            city_kj, city_kn = rnd.choice(F.BRANCH_CITY_BASE)
            suf_kj, suf_kn = rnd.choice(F.BRANCH_KIND_SUFFIX)
            kj, kn = f"{city_kj}{suf_kj}", f"{city_kn}{suf_kn}"
            kbn = "02"; parent = 1
            kind_pg = "BRANCH"
        shiten_cd = f"{i:03d}-{rnd.randint(10, 99):02d}"
        opened = random_date(rnd, date(2010, 1, 1), date(2024, 12, 31))
        phone = jp_phone(rnd); fax = jp_phone(rnd)
        email = f"branch{i:03d}@modernizepro.jp"
        zip_ = jp_zip(rnd)
        pref_kj, _, city = rnd.choice(F.PREFECTURES)[:3]
        addr = f"{pref_kj}{city}{rnd.randint(1, 9)}-{rnd.randint(1, 20)}-{rnd.randint(1, 20)}"
        hours = "平日 9:00-17:00 / 土日祝休"
        entry_ts = datetime.combine(opened, datetime.min.time())
        w_br_asis.write([i, shiten_cd, kj, kn, kbn, parent,
                         fmt_oracle_dt(opened), None,
                         fmt_oracle_dt(entry_ts), None])
        w_brc_asis.write([i, phone, fax, email, zip_, addr, hours])
        w_br_tobe.write([i, shiten_cd, kind_pg, parent, kj, kn,
                         phone, fax, email, zip_, addr, hours,
                         fmt_pg_ts(datetime.combine(opened, datetime.min.time())),
                         None, fmt_pg_ts(entry_ts), None])
        branches.append((i, "JPY"))
    w_br_asis.close(); w_brc_asis.close(); w_br_tobe.close()
    counts["branch"] = n_branch

    # ---------- 02_organization: M_EMPLOYEE → employee -------------------
    n_emp = cfg["employee"]
    w_emp_asis = AsIsWriter(asis_dir / "M_EMPLOYEE.csv",
                            ["EMPLOYEE_ID", "EMPLOYEE_CD", "BRANCH_ID", "TANTO_CD",
                             "EMP_NM_FULL", "EMP_NM_KANA", "ROLE_CD", "MANAGER_ID",
                             "JOIN_DT", "LEAVE_DT", "ENTRY_TS", "UPDATE_TS"])
    w_emp_tobe = ToBeWriter(tobe_dir / "employee.csv",
                            ["employee_id", "employee_code", "branch_id", "manager_id",
                             "department_code", "position_code", "permission_flag",
                             "family_kanji", "given_kanji", "family_kana", "given_kana",
                             "role_code", "joined_at", "left_at",
                             "created_at", "updated_at"])
    role_map = {"10": "SALES", "20": "ADMIN", "30": "OPS"}
    for i in range(1, n_emp + 1):
        fam_kj, fam_kn = rnd.choice(F.FAMILY_NAMES)
        is_male = rnd.random() < 0.55
        giv_kj, giv_kn = rnd.choice(F.GIVEN_NAMES_MALE if is_male else F.GIVEN_NAMES_FEMALE)
        nm_full = f"{fam_kj} {giv_kj}"
        nm_kana = f"{fam_kn} {giv_kn}"
        tanto = rnd.choice(F.TANTO_CD_SAMPLES)
        dept, pos, perm = tanto[:2], tanto[2:4], tanto[4:5]
        role_cd = rnd.choice(list(role_map.keys()))
        branch_id = rnd.choice(branches)[0]
        manager_id = rnd.randint(1, max(1, i - 1)) if i > 5 else None
        joined = random_date(rnd, date(2015, 1, 1), date(2025, 6, 30))
        left = None if rnd.random() < 0.95 else random_date(rnd, joined, date(2026, 4, 30))
        entry_ts = datetime.combine(joined, datetime.min.time())
        emp_cd = f"E{i:06d}"
        w_emp_asis.write([i, emp_cd, branch_id, tanto, nm_full, nm_kana, role_cd, manager_id,
                          fmt_oracle_dt(joined), fmt_oracle_dt(left),
                          fmt_oracle_dt(entry_ts), None])
        w_emp_tobe.write([i, emp_cd, branch_id, manager_id, dept, pos, perm,
                          fam_kj, giv_kj, fam_kn, giv_kn, role_map[role_cd],
                          fmt_pg_ts(datetime.combine(joined, datetime.min.time())),
                          fmt_pg_ts(datetime.combine(left, datetime.min.time())) if left else None,
                          fmt_pg_ts(entry_ts), None])
    w_emp_asis.close(); w_emp_tobe.close()
    counts["employee"] = n_emp

    # ---------- 01_master: M_CUSTOMER (+_KANA) → customer + name + addr + acctype -
    n_cust = cfg["customer"]
    w_cu_asis = AsIsWriter(asis_dir / "M_CUSTOMER.csv",
                           ["CUSTOMER_ID", "CUSTOMER_CD", "CUST_NM_FULL", "CUST_NM_KANA",
                            "CUST_ADDR", "BIRTH_DT", "GENDER_CD", "KOZA_KBN",
                            "EMAIL", "PHONE", "ENTRY_TS", "UPDATE_TS"])
    w_cuk_asis = AsIsWriter(asis_dir / "M_CUSTOMER_KANA.csv",
                            ["CUSTOMER_ID", "NM_KANJI_FAMILY", "NM_KANJI_GIVEN",
                             "NM_KANA_FAMILY", "NM_KANA_GIVEN", "NM_ROMAJI"])
    w_cu_tobe   = ToBeWriter(tobe_dir / "customer.csv",
                             ["customer_id", "customer_code", "gender", "birth_date",
                              "email", "phone", "created_at", "updated_at"])
    w_cun_tobe  = ToBeWriter(tobe_dir / "customer_name.csv",
                             ["customer_id", "family_kanji", "given_kanji",
                              "family_kana", "given_kana", "romaji"])
    w_cua_tobe  = ToBeWriter(tobe_dir / "customer_address.csv",
                             ["customer_id", "zip", "prefecture", "city",
                              "street_line1", "street_line2"])
    w_cuat_tobe = ToBeWriter(tobe_dir / "customer_account_type.csv",
                             ["customer_id", "account_type", "member_tier", "permission_flag"])

    koza_type_map = {"01": "GENERAL", "02": "SPECIFIC", "03": "NISA", "04": "JUNIOR_NISA"}
    koza_tier_map = {"1": "BRONZE", "2": "SILVER", "3": "GOLD", "9": "VIP"}
    koza_perm_map = {"0": "R", "1": "W", "X": "A"}

    for i in range(1, n_cust + 1):
        fam_kj, fam_kn = rnd.choice(F.FAMILY_NAMES)
        is_male = rnd.random() < 0.5
        giv_kj, giv_kn = rnd.choice(F.GIVEN_NAMES_MALE if is_male else F.GIVEN_NAMES_FEMALE)
        gender_asis = "1" if is_male else "2"
        gender_tobe = "M" if is_male else "F"
        nm_full = f"{fam_kj} {giv_kj}"
        nm_kana = f"{fam_kn} {giv_kn}"
        romaji = to_romaji(fam_kn, giv_kn)
        zip_ = jp_zip(rnd)
        pref_kj, city, block, bldg = fictional_address(rnd)
        addr_full = f"{zip_} {pref_kj}{city}{block}" + (f" {bldg}" if bldg else "")
        birth = random_date(rnd, date(1955, 1, 1), date(2005, 12, 31))
        koza_kbn = rnd.choice(F.KOZA_KBN_SAMPLES)
        k_type = koza_kbn[0:2]
        k_tier = koza_kbn[2]
        k_perm = koza_kbn[3]
        email = jp_email(rnd, romaji)
        phone = jp_phone(rnd)
        entry = datetime(2018, 1, 1) + timedelta(days=rnd.randint(0, 2500),
                                                 seconds=rnd.randint(0, 86399))
        cust_cd = f"C{i:08d}"
        w_cu_asis.write([i, cust_cd, nm_full, nm_kana, addr_full,
                         fmt_oracle_dt(birth), gender_asis, koza_kbn,
                         email, phone, fmt_oracle_dt(entry), None])
        w_cuk_asis.write([i, fam_kj, giv_kj, fam_kn, giv_kn, romaji])
        w_cu_tobe.write([i, cust_cd, gender_tobe, fmt_oracle_dt(birth),
                         email, phone, fmt_pg_ts(entry), None])
        w_cun_tobe.write([i, fam_kj, giv_kj, fam_kn, giv_kn, romaji])
        w_cua_tobe.write([i, zip_, pref_kj, city, block, bldg or None])
        w_cuat_tobe.write([i,
                           koza_type_map.get(k_type, "GENERAL"),
                           koza_tier_map.get(k_tier, "BRONZE"),
                           koza_perm_map.get(k_perm, "W")])
    w_cu_asis.close(); w_cuk_asis.close()
    w_cu_tobe.close(); w_cun_tobe.close(); w_cua_tobe.close(); w_cuat_tobe.close()
    counts["customer"] = n_cust

    # ---------- 01_master: M_PRODUCT → product ---------------------------
    n_prod = cfg["product"]
    w_pr_asis = AsIsWriter(asis_dir / "M_PRODUCT.csv",
                           ["PRODUCT_ID", "PRODUCT_CD", "PRODUCT_NM", "PRODUCT_NM_KANA",
                            "PRODUCT_KIND_CD", "CURRENCY_CD", "LISTING_DT", "DELISTING_DT",
                            "ENTRY_TS", "UPDATE_TS"])
    w_pr_tobe = ToBeWriter(tobe_dir / "product.csv",
                           ["product_id", "product_code", "name_kanji", "name_kana",
                            "product_kind", "currency_code", "listing_date", "delisting_date",
                            "created_at", "updated_at"])
    prodkind_map = {"10": "EQUITY", "20": "FUND", "30": "BOND", "40": "FX_MMF"}

    products: list[tuple[int, str, str]] = []  # (id, kind_asis, currency)
    for i in range(1, n_prod + 1):
        pref = rnd.choice(F.PRODUCT_PREFIXES)
        suf_kj, suf_kn, kind_pg = rnd.choice(F.PRODUCT_SUFFIXES)
        if kind_pg == "EQUITY":
            kind_asis = "10"; cur = "JPY"
        elif kind_pg == "FUND":
            kind_asis = "20"; cur = "JPY"
        elif kind_pg == "BOND":
            kind_asis = "30"; cur = "JPY"
        else:
            kind_asis = "40"; cur = rnd.choice(["USD", "EUR", "AUD"])
        nm_kj = f"{pref}{suf_kj}"
        nm_kn = f"{pref}{suf_kn}" if not suf_kn.startswith("ジェイ") else suf_kn
        listing = random_date(rnd, date(1995, 1, 1), date(2023, 12, 31))
        delist = None if rnd.random() < 0.95 else random_date(rnd, listing, date(2026, 5, 1))
        entry = datetime.combine(listing, datetime.min.time())
        prod_cd = f"P{i:06d}"
        w_pr_asis.write([i, prod_cd, nm_kj, nm_kn, kind_asis, cur,
                         fmt_oracle_dt(listing), fmt_oracle_dt(delist),
                         fmt_oracle_dt(entry), None])
        w_pr_tobe.write([i, prod_cd, nm_kj, nm_kn, prodkind_map[kind_asis], cur,
                         fmt_oracle_dt(listing),
                         fmt_oracle_dt(delist) if delist else None,
                         fmt_pg_ts(entry), None])
        products.append((i, kind_asis, cur))
    w_pr_asis.close(); w_pr_tobe.close()
    counts["product"] = n_prod

    # ---------- 01_master: M_PRODUCT_HIST → product_history --------------
    n_phist = cfg["product_history"]
    w_phist_asis = AsIsWriter(asis_dir / "M_PRODUCT_HIST.csv",
                              ["HIST_ID", "PRODUCT_ID", "CHANGE_DT", "CHANGE_TYPE_CD",
                               "OLD_VALUES", "NEW_VALUES", "CHANGED_BY"])
    w_phist_tobe = ToBeWriter(tobe_dir / "product_history.csv",
                              ["history_id", "product_id", "change_date", "change_type",
                               "old_snapshot", "new_snapshot", "changed_by"])
    type_map = {"I": "INSERT", "U": "UPDATE", "D": "DELETE"}
    for i in range(1, n_phist + 1):
        pid = rnd.randint(1, n_prod)
        cdt = random_date(rnd, date(2018, 1, 1), date(2026, 4, 30))
        ctype = rnd.choice(["I", "U", "U", "U", "D"])
        old_v = {"name_kanji": f"OLD_{pid}", "currency": "JPY"} if ctype != "I" else None
        new_v = {"name_kanji": f"NEW_{pid}", "currency": "JPY"} if ctype != "D" else None
        # Oracle CLOB JSON-like with single quotes (legacy escape style)
        old_str = json.dumps(old_v, ensure_ascii=False) if old_v else None
        new_str = json.dumps(new_v, ensure_ascii=False) if new_v else None
        changed_by = f"BATCH_{rnd.randint(1, 9)}"
        w_phist_asis.write([i, pid, fmt_oracle_dt(cdt), ctype, old_str, new_str, changed_by])
        w_phist_tobe.write([i, pid, fmt_oracle_dt(cdt), type_map[ctype],
                            old_str, new_str, changed_by])
    w_phist_asis.close(); w_phist_tobe.close()
    counts["product_history"] = n_phist

    # ---------- 03_account: M_ACCOUNT + R_ACCOUNT_PRODUCT → account + account_product -
    n_acct = cfg["account"]
    n_acct_prod = cfg["account_product"]
    w_ac_asis = AsIsWriter(asis_dir / "M_ACCOUNT.csv",
                           ["ACCOUNT_ID", "ACCOUNT_NO", "CUSTOMER_ID", "BRANCH_ID",
                            "KOZA_KBN", "CURRENCY_CD", "STATUS_CD",
                            "OPEN_DT", "CLOSE_DT", "ENTRY_TS", "UPDATE_TS"])
    w_acp_asis = AsIsWriter(asis_dir / "R_ACCOUNT_PRODUCT.csv",
                            ["ACCOUNT_ID", "PRODUCT_ID", "START_DT", "END_DT",
                             "QUANTITY", "AVG_COST", "ENTRY_TS", "UPDATE_TS"])
    w_ac_tobe = ToBeWriter(tobe_dir / "account.csv",
                           ["account_id", "account_number", "customer_id", "branch_id",
                            "account_type", "member_tier", "permission_flag",
                            "currency_code", "status", "opened_at", "closed_at",
                            "created_at", "updated_at"])
    w_acp_tobe = ToBeWriter(tobe_dir / "account_product.csv",
                            ["account_id", "product_id", "start_date", "end_date",
                             "quantity", "average_cost", "created_at", "updated_at"])
    status_map = {"A": "ACTIVE", "C": "CLOSED", "F": "FROZEN", "P": "PENDING"}
    accounts: list[tuple[int, str]] = []  # (id, currency)
    for i in range(1, n_acct + 1):
        cust = rnd.randint(1, n_cust)
        br = rnd.choice(branches)[0]
        koza = rnd.choice(F.KOZA_KBN_SAMPLES)
        cur = rnd.choices(["JPY", "USD", "EUR"], weights=[0.85, 0.10, 0.05])[0]
        status_a = rnd.choices(["A", "A", "A", "C", "F", "P"], k=1)[0]
        opened = random_date(rnd, date(2019, 1, 1), date(2025, 12, 31))
        closed = random_date(rnd, opened, date(2026, 4, 30)) if status_a == "C" else None
        acct_no = f"{br:03d}-{koza[:2]}-{rnd.randint(1000000, 9999999)}"
        entry = datetime.combine(opened, datetime.min.time())
        k_type = koza[0:2]; k_tier = koza[2]; k_perm = koza[3]
        w_ac_asis.write([i, acct_no, cust, br, koza, cur, status_a,
                         fmt_oracle_dt(opened), fmt_oracle_dt(closed),
                         fmt_oracle_dt(entry), None])
        w_ac_tobe.write([i, acct_no, cust, br,
                         koza_type_map.get(k_type, "GENERAL"),
                         koza_tier_map.get(k_tier, "BRONZE"),
                         koza_perm_map.get(k_perm, "W"),
                         cur, status_map[status_a],
                         fmt_oracle_dt(opened),
                         fmt_oracle_dt(closed) if closed else None,
                         fmt_pg_ts(entry), None])
        accounts.append((i, cur))
    w_ac_asis.close(); w_ac_tobe.close()
    counts["account"] = n_acct

    # account_product: unique (account, product) pairs
    seen = set()
    written_ap = 0
    while written_ap < n_acct_prod:
        a = rnd.randint(1, n_acct)
        p = rnd.randint(1, n_prod)
        if (a, p) in seen:
            continue
        seen.add((a, p))
        start = random_date(rnd, date(2020, 1, 1), date(2025, 12, 31))
        end = random_date(rnd, start, date(2026, 4, 30)) if rnd.random() < 0.1 else None
        qty = round(rnd.uniform(10, 10000), 2)
        avg = round(rnd.uniform(50, 5000), 4)
        entry = datetime.combine(start, datetime.min.time())
        w_acp_asis.write([a, p, fmt_oracle_dt(start), fmt_oracle_dt(end), qty, avg,
                          fmt_oracle_dt(entry), None])
        w_acp_tobe.write([a, p, fmt_oracle_dt(start),
                          fmt_oracle_dt(end) if end else None, qty, avg,
                          fmt_pg_ts(entry), None])
        written_ap += 1
    w_acp_asis.close(); w_acp_tobe.close()
    counts["account_product"] = written_ap

    # ---------- 04_trade: T_TRADE (+ DETAIL + LOG) → trade + fee + settlement_link + audit -
    n_trade = cfg["trade"]
    w_tr_asis = AsIsWriter(asis_dir / "T_TRADE.csv",
                           ["TRADE_ID", "TRADE_NO", "TRADE_DT", "ACCOUNT_ID", "PRODUCT_ID",
                            "TORIHIKI_KBN", "QUANTITY", "UNIT_PRICE", "GROSS_AMT",
                            "FEE_AMT", "TAX_AMT", "NET_AMT", "SETTLEMENT_ID",
                            "SETTLEMENT_DT", "SETTLEMENT_STATUS_CD", "MEMO",
                            "ENTRY_TS", "UPDATE_TS"])
    w_trd_asis = AsIsWriter(asis_dir / "T_TRADE_DETAIL.csv",
                            ["TRADE_ID", "SEQ", "DETAIL_KBN", "AMOUNT", "DESCRIPTION"])
    w_trl_asis = AsIsWriter(asis_dir / "T_TRADE_LOG.csv",
                            ["LOG_ID", "TRADE_ID", "EVENT_KBN", "EVENT_TS",
                             "ACTOR_CD", "PAYLOAD"])
    w_tr_tobe   = ToBeWriter(tobe_dir / "trade.csv",
                             ["trade_id", "trade_number", "trade_date", "account_id",
                              "product_id", "trade_type", "quantity", "unit_price",
                              "gross_amount", "net_amount", "memo",
                              "created_at", "updated_at"])
    w_fee_tobe  = ToBeWriter(tobe_dir / "trade_fee.csv",
                             ["fee_id", "trade_id", "fee_kind", "amount",
                              "currency_code", "description", "created_at"])
    w_tsl_tobe  = ToBeWriter(tobe_dir / "trade_settlement_link.csv",
                             ["trade_id", "settlement_id", "settled_amount",
                              "settled_at", "status"])
    w_tau_tobe  = ToBeWriter(tobe_dir / "trade_audit.csv",
                             ["audit_id", "trade_id", "event_type", "event_at",
                              "actor_code", "payload"])

    trade_map = {"1": "BUY", "2": "SELL", "3": "TRANSFER"}
    set_status_map = {"P": "PENDING", "C": "CONFIRMED", "X": "CANCELLED"}
    fee_id = 0
    audit_id = 0
    for i in range(1, n_trade + 1):
        acc_id, acc_cur = accounts[rnd.randint(0, len(accounts) - 1)]
        prod_id, _, prod_cur = products[rnd.randint(0, len(products) - 1)]
        kbn = rnd.choices(["1", "2", "3"], weights=[0.55, 0.40, 0.05])[0]
        qty = round(rnd.uniform(10, 5000), 2)
        unit = round(rnd.uniform(50, 8000), 4)
        gross = round(qty * unit, 2)
        fee = round(gross * 0.001, 2)
        tax = round(gross * 0.001, 2)
        net = round(gross - (fee + tax) if kbn == "2" else gross + fee + tax, 2)
        tdt = random_date(rnd, date(2024, 1, 1), date(2026, 5, 25))
        set_id = i  # 1:1 mapping for simplicity
        sdt = tdt + timedelta(days=2)
        sst_a = rnd.choices(["C", "C", "P", "X"], k=1)[0]
        memo = rnd.choice([None, None, "通常取引", "成行注文", "指値注文", "夜間処理分"])
        entry = datetime.combine(tdt, datetime.min.time()) + timedelta(seconds=rnd.randint(28800, 64799))
        trade_no = f"TR{tdt.strftime('%Y%m%d')}{i:08d}"
        w_tr_asis.write([i, trade_no, fmt_oracle_dt(tdt), acc_id, prod_id, kbn,
                         qty, unit, gross, fee, tax, net,
                         set_id, fmt_oracle_dt(sdt), sst_a, memo,
                         fmt_oracle_dt(entry), None])
        w_tr_tobe.write([i, trade_no, fmt_oracle_dt(tdt), acc_id, prod_id,
                         trade_map[kbn], qty, unit, gross, net, memo,
                         fmt_pg_ts(entry), None])
        # fee/tax split into trade_fee rows
        fee_id += 1
        w_fee_tobe.write([fee_id, i, "BROKER_FEE", fee, acc_cur,
                          "委託手数料 0.1%", fmt_pg_ts(entry)])
        fee_id += 1
        w_fee_tobe.write([fee_id, i, "TAX", tax, acc_cur,
                          "消費税相当", fmt_pg_ts(entry)])
        # settlement_link 1:1 (could be 1:N for partial settlements)
        w_tsl_tobe.write([i, set_id, net, fmt_oracle_dt(sdt), set_status_map[sst_a]])
        # T_TRADE_DETAIL — small number per trade (dividend / interest)
        if rnd.random() < 0.10:
            seq = 1
            kind = rnd.choice(["D", "I", "X"])
            amount = round(rnd.uniform(10, 5000), 2)
            desc = {"D": "配当金", "I": "利息", "X": "その他費用"}[kind]
            w_trd_asis.write([i, seq, kind, amount, desc])
            # 同じ事象を trade_fee 側で表現 (DIVIDEND/INTEREST/OTHER)
            fee_id += 1
            kind_pg = {"D": "DIVIDEND", "I": "INTEREST", "X": "OTHER"}[kind]
            w_fee_tobe.write([fee_id, i, kind_pg, amount, acc_cur, desc, fmt_pg_ts(entry)])
        # T_TRADE_LOG — 1-2 events
        for ev_kind_a, ev_kind_pg in (("CR", "CREATE"), ("SE", "SETTLE")):
            audit_id += 1
            log_id = audit_id
            ts = entry + timedelta(seconds=rnd.randint(60, 86400))
            actor = f"BATCH_{rnd.randint(1, 9)}"
            payload = json.dumps({"trade_id": i, "amount": net}, ensure_ascii=False)
            w_trl_asis.write([log_id, i, ev_kind_a, fmt_oracle_dt(ts), actor, payload])
            w_tau_tobe.write([log_id, i, ev_kind_pg, fmt_pg_ts(ts), actor, payload])
    w_tr_asis.close(); w_trd_asis.close(); w_trl_asis.close()
    w_tr_tobe.close(); w_fee_tobe.close(); w_tsl_tobe.close(); w_tau_tobe.close()
    counts["trade"] = n_trade

    # ---------- 05_market: T_MARKET_QUOTE → market_quote -----------------
    n_market_days = cfg["market_quote_days"]
    w_mq_asis = AsIsWriter(asis_dir / "T_MARKET_QUOTE.csv",
                           ["QUOTE_DT", "PRODUCT_ID", "OPEN_PRICE", "HIGH_PRICE",
                            "LOW_PRICE", "CLOSE_PRICE", "VOLUME", "VWAP",
                            "SOURCE_CD", "ENTRY_TS"])
    w_mq_tobe = ToBeWriter(tobe_dir / "market_quote.csv",
                           ["quote_date", "product_id", "open_price", "high_price",
                            "low_price", "close_price", "volume", "vwap",
                            "source", "created_at"])
    market_rows = 0
    for d in range(n_market_days):
        qd = today - timedelta(days=d)
        for (pid, _, _) in products:
            o = round(rnd.uniform(100, 5000), 4)
            h = round(o * rnd.uniform(1.0, 1.05), 4)
            lo = round(o * rnd.uniform(0.95, 1.0), 4)
            c = round(rnd.uniform(lo, h), 4)
            vol = round(rnd.uniform(1000, 1000000), 2)
            vwap = round((h + lo + c) / 3, 4)
            src = rnd.choice(["TSE", "OSE", "NSE", "FUKU"])
            entry = datetime.combine(qd, datetime.min.time()).replace(hour=15, minute=30)
            w_mq_asis.write([fmt_oracle_dt(qd), pid, o, h, lo, c, vol, vwap, src,
                             fmt_oracle_dt(entry)])
            w_mq_tobe.write([fmt_oracle_dt(qd), pid, o, h, lo, c, vol, vwap, src,
                             fmt_pg_ts(entry)])
            market_rows += 1
    w_mq_asis.close(); w_mq_tobe.close()
    counts["market_quote"] = market_rows

    # ---------- 06_settlement: T_SETTLEMENT → settlement -----------------
    n_set = cfg["settlement"]
    w_st_asis = AsIsWriter(asis_dir / "T_SETTLEMENT.csv",
                           ["SETTLEMENT_ID", "SETTLEMENT_DT", "ACCOUNT_ID", "TRADE_ID",
                            "GROSS_AMT", "FEE_AMT", "TAX_AMT", "NET_AMT",
                            "CURRENCY_CD", "STATUS_CD", "CONFIRMED_DT",
                            "ENTRY_TS", "UPDATE_TS"])
    w_st_tobe = ToBeWriter(tobe_dir / "settlement.csv",
                           ["settlement_id", "settlement_date", "account_id",
                            "gross_amount", "fee_amount", "tax_amount", "net_amount",
                            "currency_code", "status", "confirmed_at",
                            "created_at", "updated_at"])
    for i in range(1, n_set + 1):
        # link to a real trade if possible (trade_id == settlement_id 1:1 above)
        trade_id = min(i, n_trade) if n_trade > 0 else 1
        acc_id = accounts[rnd.randint(0, len(accounts) - 1)][0]
        sdt = today - timedelta(days=rnd.randint(0, 365))
        gross = round(rnd.uniform(1000, 5000000), 2)
        fee = round(gross * 0.001, 2)
        tax = round(gross * 0.001, 2)
        net = round(gross - fee - tax, 2)
        status_a = rnd.choices(["C", "C", "P", "X"], k=1)[0]
        confirmed = sdt + timedelta(days=1) if status_a == "C" else None
        entry = datetime.combine(sdt, datetime.min.time())
        w_st_asis.write([i, fmt_oracle_dt(sdt), acc_id, trade_id,
                         gross, fee, tax, net, "JPY", status_a,
                         fmt_oracle_dt(confirmed) if confirmed else None,
                         fmt_oracle_dt(entry), None])
        w_st_tobe.write([i, fmt_oracle_dt(sdt), acc_id,
                         gross, fee, tax, net, "JPY", set_status_map[status_a],
                         fmt_oracle_dt(confirmed) if confirmed else None,
                         fmt_pg_ts(entry), None])
    w_st_asis.close(); w_st_tobe.close()
    counts["settlement"] = n_set

    # ---------- emit load.sql for docker init -----------------------------
    # Mounted at /docker-entrypoint-initdb.d/07_load_sample.sql.
    # \copy with explicit column lists + HEADER true → first row (which is
    # BOM + header in our TO-BE CSVs) is skipped wholesale. After loads,
    # reset IDENTITY sequences so further INSERTs don't collide with loaded
    # PK values.
    load_sql = tobe_dir / "load.sql"
    with open(load_sql, "w", encoding="utf-8", newline="\n") as f:
        f.write("-- Auto-generated by scripts/gen_sample_data.py.\n")
        f.write("\\set ON_ERROR_STOP on\n")
        f.write("SET search_path TO securities;\n\n")

        copy_order = [
            ("code_dictionary", ["domain", "source_code", "target_code",
                                 "label_ja", "label_en", "sort_order",
                                 "active", "created_at", "updated_at"]),
            ("currency", ["currency_code", "name_ja", "name_en",
                          "decimal_digits", "symbol"]),
            ("branch", ["branch_id", "branch_code", "branch_kind",
                        "parent_branch_id", "name_kanji", "name_kana",
                        "phone", "fax", "email", "zip", "address_line",
                        "opening_hours", "opened_at", "closed_at",
                        "created_at", "updated_at"]),
            ("customer", ["customer_id", "customer_code", "gender",
                          "birth_date", "email", "phone",
                          "created_at", "updated_at"]),
            ("customer_name", ["customer_id", "family_kanji", "given_kanji",
                               "family_kana", "given_kana", "romaji"]),
            ("customer_address", ["customer_id", "zip", "prefecture",
                                  "city", "street_line1", "street_line2"]),
            ("customer_account_type", ["customer_id", "account_type",
                                       "member_tier", "permission_flag"]),
            ("product", ["product_id", "product_code", "name_kanji",
                         "name_kana", "product_kind", "currency_code",
                         "listing_date", "delisting_date",
                         "created_at", "updated_at"]),
            ("product_history", ["history_id", "product_id", "change_date",
                                 "change_type", "old_snapshot",
                                 "new_snapshot", "changed_by"]),
            ("employee", ["employee_id", "employee_code", "branch_id",
                          "manager_id", "department_code", "position_code",
                          "permission_flag", "family_kanji", "given_kanji",
                          "family_kana", "given_kana", "role_code",
                          "joined_at", "left_at",
                          "created_at", "updated_at"]),
            ("account", ["account_id", "account_number", "customer_id",
                         "branch_id", "account_type", "member_tier",
                         "permission_flag", "currency_code", "status",
                         "opened_at", "closed_at",
                         "created_at", "updated_at"]),
            ("account_product", ["account_id", "product_id", "start_date",
                                 "end_date", "quantity", "average_cost",
                                 "created_at", "updated_at"]),
            ("trade", ["trade_id", "trade_number", "trade_date",
                       "account_id", "product_id", "trade_type",
                       "quantity", "unit_price", "gross_amount",
                       "net_amount", "memo",
                       "created_at", "updated_at"]),
            ("trade_fee", ["fee_id", "trade_id", "fee_kind", "amount",
                           "currency_code", "description", "created_at"]),
            ("trade_settlement_link", ["trade_id", "settlement_id",
                                       "settled_amount", "settled_at",
                                       "status"]),
            ("trade_audit", ["audit_id", "trade_id", "event_type",
                             "event_at", "actor_code", "payload"]),
            ("market_quote", ["quote_date", "product_id", "open_price",
                              "high_price", "low_price", "close_price",
                              "volume", "vwap", "source", "created_at"]),
            ("settlement", ["settlement_id", "settlement_date",
                            "account_id", "gross_amount", "fee_amount",
                            "tax_amount", "net_amount", "currency_code",
                            "status", "confirmed_at",
                            "created_at", "updated_at"]),
        ]
        for tbl, cols in copy_order:
            col_list = ", ".join(cols)
            f.write(f"\\copy securities.{tbl} ({col_list}) "
                    f"FROM '/sample/{tbl}.csv' "
                    f"WITH (FORMAT csv, HEADER true);\n")

        f.write("""
-- Reset IDENTITY sequences to MAX(id)+1 so further inserts don't collide.
DO $$
DECLARE
    r RECORD;
    max_id BIGINT;
    seq_name TEXT;
BEGIN
    FOR r IN
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        WHERE c.table_schema = 'securities'
          AND c.is_identity = 'YES'
    LOOP
        seq_name := pg_get_serial_sequence('securities.' || r.table_name, r.column_name);
        IF seq_name IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM securities.%I',
                       r.column_name, r.table_name) INTO max_id;
        IF max_id > 0 THEN
            EXECUTE format('SELECT setval(%L, %s)', seq_name, max_id);
        END IF;
    END LOOP;
END $$;
""")
    return counts


def main():
    stages = sys.argv[1:] if len(sys.argv) > 1 else list(ALL_STAGES)
    for st in stages:
        if st not in ALL_STAGES:
            print(f"unknown stage: {st}; expected one of {ALL_STAGES}", file=sys.stderr)
            sys.exit(2)
    for st in stages:
        print(f"=== stage: {st} ===", flush=True)
        t0 = datetime.now()
        counts = generate_stage(st)
        elapsed = (datetime.now() - t0).total_seconds()
        for t, n in counts.items():
            print(f"  {t:<24s} {n:>10,d}")
        print(f"  total elapsed {elapsed:.1f}s")


if __name__ == "__main__":
    main()
