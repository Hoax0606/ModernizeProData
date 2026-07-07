#!/usr/bin/env python3
"""ModernizeProDataBridge — Mapping Definition CSV generator.

Emits two files at ModernizeProDataBridge/frontend/public/templates/:

  mapping_definition_template.csv   header row only — for users to download and fill in
  mapping_definition_sample.csv     header + body — populated from db/asis/oracle_ddl.sql
                                    and db/tobe/{stage}/init.sql (securities domain)

Header format follows a project convention: Japanese label + English key
in parentheses, e.g. "ASISテーブル(asis_table)". A future parser extracts
the English key with `header.rsplit('(', 1)[1].rstrip(')')` so the
Japanese visual label can be edited freely without breaking parsing.

UTF-8 with BOM (Excel-friendly).
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = REPO_ROOT / "ModernizeProDataBridge" / "frontend" / "public" / "templates"

# ───────────────────────────────────────────────────────────────────────────
# Header row — Japanese visible label + (english_key) for machine parsing.
# Single attribute per column (no grouping) — easier for filters / pandas
# / future parser. Keep in sync with any future server-side schema.
# ───────────────────────────────────────────────────────────────────────────
HEADERS = [
    "連番(no)",
    "ASISテーブル(asis_table)",
    "ASISカラム論理名(asis_column_logical)",
    "ASISカラム物理名(asis_column_physical)",
    "ASISデータ型(asis_data_type)",
    "長さ(length)",
    "NULL可否(nullable)",
    "PK(pk)",
    "TOBEテーブル(tobe_table)",
    "TOBEカラム論理名(tobe_column_logical)",
    "TOBEカラム物理名(tobe_column_physical)",
    "TOBEデータ型(tobe_data_type)",
    "変換規則(transformation_rule)",
    "マスキング(masking)",
    "備考(notes)",
]


# ───────────────────────────────────────────────────────────────────────────
# Sample rows — securities domain.
#
# Source DDL:  db/asis/oracle_ddl.sql
# Target DDL:  db/tobe/{stage}/init.sql
#
# Each row maps ONE AS-IS column to ONE TO-BE column (or marks a column
# dropped / defaulted). Order: customer → product → account →
# account_product → trade. Matches the FK creation order in load.sql.
# ───────────────────────────────────────────────────────────────────────────

def row(
    no, atbl, alog, aphy, atyp, alen, anull, apk,
    ttbl, tlog, tphy, ttyp, rule, mask, notes,
):
    return [no, atbl, alog, aphy, atyp, alen, anull, apk,
            ttbl, tlog, tphy, ttyp, rule, mask, notes]


ROWS = [
    # ─── 顧客マスタ → customer ────────────────────────────────────────────
    row(1,  "M_CUSTOMER", "顧客ID",        "CUSTOMER_ID",      "NUMBER",   "10",  "N", "Y",
        "customer", "顧客ID",        "customer_id",        "BIGINT",        "passthrough", "", "PK. NUMBER(10) → BIGINT."),
    row(2,  "M_CUSTOMER", "顧客コード",    "CUSTOMER_CD",      "VARCHAR2", "20",  "N", "",
        "customer", "顧客コード",    "customer_code",      "VARCHAR(20)",   "passthrough", "", "UNIQUE 制約維持."),
    row(3,  "M_CUSTOMER", "顧客名",        "CUSTOMER_NM",      "VARCHAR2", "100", "N", "",
        "customer", "顧客名",        "customer_name",      "VARCHAR(100)",  "passthrough",
        "test stage のみ姓のみ残し、名は * でマスク", "個人情報。test stage で部分マスク。"),
    row(4,  "M_CUSTOMER", "顧客名カナ",    "CUSTOMER_NM_KANA", "VARCHAR2", "200", "Y", "",
        "customer", "顧客名カナ",    "customer_name_kana", "VARCHAR(200)",  "passthrough", "", ""),
    row(5,  "M_CUSTOMER", "生年月日",      "BIRTH_DT",         "DATE",     "",    "Y", "",
        "customer", "生年月日",      "birth_date",         "DATE",
        "Oracle DATE → PG DATE (時刻不要)", "", ""),
    row(6,  "M_CUSTOMER", "性別区分",      "GENDER_CD",        "CHAR",     "1",   "Y", "",
        "customer", "性別",          "gender",             "CHAR(1)",       "passthrough", "", "M=男 / F=女"),
    row(7,  "M_CUSTOMER", "メール",        "EMAIL",            "VARCHAR2", "128", "Y", "",
        "customer", "メール",        "email",              "VARCHAR(128)",  "passthrough",
        "test stage で local-part 先頭2字以外を * に置換", "個人情報。"),
    row(8,  "M_CUSTOMER", "電話番号",      "PHONE",            "VARCHAR2", "20",  "Y", "",
        "customer", "電話番号",      "phone",              "VARCHAR(20)",   "passthrough",
        "test stage で中4桁を **** に置換", "個人情報。"),
    row(9,  "M_CUSTOMER", "登録日時",      "ENTRY_TS",         "DATE",     "",    "N", "",
        "customer", "登録日時",      "created_at",         "TIMESTAMP",
        "Oracle DATE (= datetime) → TIMESTAMP", "", ""),
    row(10, "M_CUSTOMER", "更新日時",      "UPDATE_TS",        "DATE",     "",    "Y", "",
        "customer", "更新日時",      "updated_at",         "TIMESTAMP",
        "Oracle DATE → TIMESTAMP", "", ""),

    # ─── 商品マスタ → product ─────────────────────────────────────────────
    row(11, "M_PRODUCT", "商品ID",        "PRODUCT_ID",      "NUMBER",   "8",   "N", "Y",
        "product", "商品ID",        "product_id",      "INTEGER",       "passthrough", "", "PK."),
    row(12, "M_PRODUCT", "商品コード",    "PRODUCT_CD",      "VARCHAR2", "20",  "N", "",
        "product", "商品コード",    "product_code",    "VARCHAR(20)",   "passthrough", "", "UNIQUE."),
    row(13, "M_PRODUCT", "商品名",        "PRODUCT_NM",      "VARCHAR2", "100", "N", "",
        "product", "商品名",        "product_name",    "VARCHAR(100)",  "passthrough", "", ""),
    row(14, "M_PRODUCT", "商品種別",      "PRODUCT_KIND_CD", "CHAR",     "2",   "N", "",
        "product", "商品種別",      "product_kind",    "CHAR(2)",       "passthrough",
        "", "10=株式 / 20=債券 / 30=投資信託"),
    row(15, "M_PRODUCT", "単価",          "UNIT_PRICE",      "NUMBER",   "15,4","Y", "",
        "product", "単価",          "unit_price",      "NUMERIC(15,4)", "passthrough", "", ""),
    row(16, "M_PRODUCT", "通貨コード",    "CURRENCY_CD",     "CHAR",     "3",   "N", "",
        "product", "通貨コード",    "currency_code",   "CHAR(3)",       "passthrough", "", "ISO 4217 既定 JPY"),
    row(17, "M_PRODUCT", "登録日時",      "ENTRY_TS",        "DATE",     "",    "N", "",
        "product", "登録日時",      "created_at",      "TIMESTAMP",
        "Oracle DATE → TIMESTAMP", "", ""),

    # ─── 口座マスタ → account ─────────────────────────────────────────────
    row(18, "M_ACCOUNT", "口座ID",        "ACCOUNT_ID",      "NUMBER",   "12",  "N", "Y",
        "account", "口座ID",        "account_id",      "BIGINT",        "passthrough", "", "PK."),
    row(19, "M_ACCOUNT", "顧客ID",        "CUSTOMER_ID",     "NUMBER",   "10",  "N", "",
        "account", "顧客ID",        "customer_id",     "BIGINT",        "passthrough", "",
        "FK → customer.customer_id. 1:N 関係。"),
    row(20, "M_ACCOUNT", "口座番号",      "ACCOUNT_NO",      "VARCHAR2", "20",  "N", "",
        "account", "口座番号",      "account_no",      "VARCHAR(20)",   "passthrough", "", "UNIQUE."),
    row(21, "M_ACCOUNT", "口座種別",      "ACCOUNT_KIND_CD", "CHAR",     "2",   "N", "",
        "account", "口座種別",      "account_kind",    "CHAR(2)",       "passthrough", "", "01=普通 / 02=特定"),
    row(22, "M_ACCOUNT", "残高",          "BALANCE",         "NUMBER",   "15,2","N", "",
        "account", "残高",          "balance",         "NUMERIC(15,2)", "passthrough", "", ""),
    row(23, "M_ACCOUNT", "開設日",        "OPENED_DT",       "DATE",     "",    "N", "",
        "account", "開設日",        "opened_date",     "DATE",
        "Oracle DATE → PG DATE", "", ""),
    row(24, "M_ACCOUNT", "状態",          "STATUS_CD",       "CHAR",     "1",   "N", "",
        "account", "状態",          "status",          "CHAR(1)",       "passthrough", "",
        "A=有効 / C=停止 / F=閉鎖"),
    row(25, "M_ACCOUNT", "登録日時",      "ENTRY_TS",        "DATE",     "",    "N", "",
        "account", "登録日時",      "created_at",      "TIMESTAMP",
        "Oracle DATE → TIMESTAMP", "", ""),
    row(26, "M_ACCOUNT", "更新日時",      "UPDATE_TS",       "DATE",     "",    "Y", "",
        "account", "更新日時",      "updated_at",      "TIMESTAMP",
        "Oracle DATE → TIMESTAMP", "", ""),

    # ─── 口座-商品 → account_product (N:N) ───────────────────────────────
    row(27, "R_ACCOUNT_PRODUCT", "口座ID",       "ACCOUNT_ID",  "NUMBER",   "12",   "N", "Y",
        "account_product", "口座ID",       "account_id",  "BIGINT",        "passthrough", "",
        "複合 PK. FK → account."),
    row(28, "R_ACCOUNT_PRODUCT", "商品ID",       "PRODUCT_ID",  "NUMBER",   "8",    "N", "Y",
        "account_product", "商品ID",       "product_id",  "INTEGER",       "passthrough", "",
        "複合 PK. FK → product."),
    row(29, "R_ACCOUNT_PRODUCT", "保有数量",     "HOLDING_QTY", "NUMBER",   "15,4", "N", "",
        "account_product", "保有数量",     "holding_qty", "NUMERIC(15,4)", "passthrough", "", ""),
    row(30, "R_ACCOUNT_PRODUCT", "保有開始日",   "START_DT",    "DATE",     "",     "N", "",
        "account_product", "保有開始日",   "start_date",  "DATE",
        "Oracle DATE → PG DATE", "", ""),
    row(31, "R_ACCOUNT_PRODUCT", "保有終了日",   "END_DT",      "DATE",     "",     "Y", "",
        "account_product", "保有終了日",   "end_date",    "DATE",
        "Oracle DATE → PG DATE", "", "NULL = 現在も保有中"),
    row(32, "R_ACCOUNT_PRODUCT", "登録日時",     "ENTRY_TS",    "DATE",     "",     "N", "",
        "account_product", "登録日時",     "created_at",  "TIMESTAMP",
        "Oracle DATE → TIMESTAMP", "", ""),

    # ─── 取引明細 → trade (N:1 account, N:1 product) ─────────────────────
    row(33, "T_TRADE", "取引ID",        "TRADE_ID",      "NUMBER",   "14",   "N", "Y",
        "trade", "取引ID",        "trade_id",      "BIGINT",        "passthrough", "", "PK."),
    row(34, "T_TRADE", "口座ID",        "ACCOUNT_ID",    "NUMBER",   "12",   "N", "",
        "trade", "口座ID",        "account_id",    "BIGINT",        "passthrough", "",
        "FK → account. N:1 関係。"),
    row(35, "T_TRADE", "商品ID",        "PRODUCT_ID",    "NUMBER",   "8",    "N", "",
        "trade", "商品ID",        "product_id",    "INTEGER",       "passthrough", "",
        "FK → product."),
    row(36, "T_TRADE", "取引種別",      "TRADE_TYPE_CD", "CHAR",     "1",    "N", "",
        "trade", "取引種別",      "trade_type",    "CHAR(1)",       "passthrough", "", "B=買付 / S=売却"),
    row(37, "T_TRADE", "取引数量",      "TRADE_QTY",     "NUMBER",   "12",   "N", "",
        "trade", "取引数量",      "trade_qty",     "NUMERIC(12)",   "passthrough", "", ""),
    row(38, "T_TRADE", "約定単価",      "TRADE_PRICE",   "NUMBER",   "15,4", "N", "",
        "trade", "約定単価",      "trade_price",   "NUMERIC(15,4)", "passthrough", "", ""),
    row(39, "T_TRADE", "取引日",        "TRADE_DT",      "DATE",     "",     "N", "",
        "trade", "取引日",        "trade_date",    "DATE",
        "Oracle DATE → PG DATE", "", ""),
    row(40, "T_TRADE", "登録日時",      "ENTRY_TS",      "DATE",     "",     "N", "",
        "trade", "登録日時",      "created_at",    "TIMESTAMP",
        "Oracle DATE → TIMESTAMP", "", ""),
]


def write_csv(path: Path, rows: list[list[str]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(HEADERS)
        for r in rows:
            w.writerow(r)
    return os.path.getsize(path)


def main() -> int:
    template_path = PUBLIC_DIR / "mapping_definition_template.csv"
    sample_path   = PUBLIC_DIR / "mapping_definition_sample.csv"

    tsize = write_csv(template_path, [])     # header only
    ssize = write_csv(sample_path, ROWS)     # header + body

    # Clean up the YAML twin from the previous generation; it's no longer used.
    old_yaml = PUBLIC_DIR / "mapping_definition_template.yaml"
    if old_yaml.exists():
        old_yaml.unlink()
        print(f"removed obsolete: {old_yaml}")

    print(f"wrote {template_path}  ({tsize:,} bytes, header only)")
    print(f"wrote {sample_path}    ({ssize:,} bytes, {len(ROWS)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
