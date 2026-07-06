#!/usr/bin/env python3
"""
신용카드사 PoC 최종 test fixture 생성기 (2026-06-04).

기존 gen_sample_data.py(securities)와 별개 — 카드 도메인 전용. 인프라(환경별 tier
행수, 결정적 seed, AS-IS CSV writer) 패턴은 동일. AS-IS 전체를 Shift-JIS(cp932)로
통일 — 사이트 asisEncoding 이 단일값이라.

도구 ingest: AS-IS Oracle DDL + AS-IS CSV(Shift-JIS) + column/code mapping.
TO-BE 데이터는 도구가 migration 으로 생성하므로 미생성. TO-BE PG DDL 은 schema 분리.

매핑 케이스: 1:N expand(customer_contact), N:N(card_benefit), N:1 merge(kana→name,
auth+detail→transaction), 복합코드 분해(KAIIN_KBN), code맵(CASE), CHAR8→DATE,
NUMBER→numeric, CLOB→JSONB, 마스킹(카드번호), NULL→default, Shift-JIS, 대용량(prod 4천만).

산출:
  db/asis_card/card_asis_oracle.sql
  db/tobe_card/card_tobe_pg.sql
  db/sample_data/asis_card/{stage}/*.csv   (Shift-JIS, CRLF, UPPER 헤더)
  db/mapping_card/column_mapping.csv, code_mapping.csv

실행: python scripts/gen_card_fixture.py [dev test staging prod]
"""
from __future__ import annotations
import csv, random, sys
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_ASIS_DDL = REPO / "db" / "asis_card"
OUT_TOBE_DDL = REPO / "db" / "tobe_card"
OUT_CSV = REPO / "db" / "sample_data" / "asis_card"
OUT_MAP = REPO / "db" / "mapping_card"

ALL_STAGES = ("dev", "test", "staging", "prod")
STAGE_SEEDS = {"dev": 2001, "test": 2002, "staging": 2003, "prod": 2004}

# 거래계(auth) 기준. dev 1만 ~ prod 4천만. 나머지 비례.
TIER = {
    "dev":     {"auth": 10_000,     "customer": 1_000,     "card": 1_500,     "merchant": 200},
    "test":    {"auth": 1_000_000,  "customer": 100_000,   "card": 150_000,   "merchant": 2_000},
    "staging": {"auth": 10_000_000, "customer": 1_000_000, "card": 1_500_000, "merchant": 10_000},
    "prod":    {"auth": 40_000_000, "customer": 4_000_000, "card": 6_000_000, "merchant": 40_000},
}

# Shift-JIS(cp932) 안전 일본어 fixtures.
FAMILY = [("佐藤","サトウ"),("鈴木","スズキ"),("高橋","タカハシ"),("田中","タナカ"),
          ("渡辺","ワタナベ"),("伊藤","イトウ"),("山本","ヤマモト"),("中村","ナカムラ"),
          ("小林","コバヤシ"),("加藤","カトウ"),("吉田","ヨシダ"),("山田","ヤマダ")]
GIVEN_M = [("太郎","タロウ"),("一郎","イチロウ"),("健","ケン"),("大輔","ダイスケ"),("翔","ショウ")]
GIVEN_F = [("花子","ハナコ"),("美咲","ミサキ"),("陽子","ヨウコ"),("愛","アイ"),("結衣","ユイ")]
PREF = [("東京都","千代田区"),("大阪府","北区"),("愛知県","名古屋市"),
        ("北海道","札幌市"),("福岡県","博多区"),("神奈川県","横浜市")]
MERCH_NM = ["イオン","セブンイレブン","ファミリーマート","ヨドバシカメラ","ビックカメラ",
            "ユニクロ","スターバックス","マクドナルド","JR東日本","ENEOS"]
BRANDS = ["VISA","MASTER","JCB","AMEX"]
KAIIN_KBN = ["1A01","2B02","3C03","1B10","2A20","3A99"]   # tier1+type1+flag2 (복합코드)
BENEFITS = ["ポイント還元","空港ラウンジ","海外旅行保険","ショッピング保険","マイル積算","優待割引"]


class AsIs:
    """Oracle 추출 스타일: Shift-JIS(cp932), CRLF, UPPER 헤더, NULL=빈문자열."""
    def __init__(self, stage, table, headers):
        p = OUT_CSV / stage / f"{table}.csv"
        p.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(p, "w", encoding="cp932", newline="", errors="strict")
        self.w = csv.writer(self.f, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
        self.w.writerow([h.upper() for h in headers])
    def write(self, row):
        self.w.writerow(["" if v is None else v for v in row])
    def close(self):
        self.f.close()


def ymd(d): return d.strftime("%Y%m%d")
def oradate(d): return d.strftime("%Y-%m-%d %H:%M:%S")


def emit_asis_ddl():
    OUT_ASIS_DDL.mkdir(parents=True, exist_ok=True)
    sql = """-- AS-IS Oracle DDL — 신용카드사 PoC fixture. side=asis 로 import.

CREATE TABLE M_CUSTOMER (
  CUST_ID       NUMBER(12)   NOT NULL,
  KAIIN_KBN     CHAR(4),
  CUST_NM_KANJI VARCHAR2(80),
  CUST_NM_KANA  VARCHAR2(80),
  GENDER_CD     CHAR(1),
  BIRTH_YMD     CHAR(8),
  ZIP           CHAR(7),
  PREF          VARCHAR2(20),
  CITY          VARCHAR2(40),
  ADDR_LINE     VARCHAR2(120),
  REG_DATE      DATE,
  STATUS_CD     CHAR(1),
  PRIMARY KEY (CUST_ID)
);
COMMENT ON TABLE M_CUSTOMER IS '회원 마스터';

CREATE TABLE M_CUST_KANA (
  CUST_ID     NUMBER(12) NOT NULL,
  NM_KANA_SEI VARCHAR2(40),
  NM_KANA_MEI VARCHAR2(40),
  PRIMARY KEY (CUST_ID)
);

CREATE TABLE M_CUST_CONTACT (
  CUST_ID NUMBER(12) NOT NULL,
  EMAIL   VARCHAR2(120),
  TEL     VARCHAR2(20),
  MOBILE  VARCHAR2(20),
  PRIMARY KEY (CUST_ID)
);

CREATE TABLE M_CARD_PRODUCT (
  PRODUCT_ID NUMBER(8) NOT NULL,
  PRODUCT_NM VARCHAR2(60),
  BRAND_CD   VARCHAR2(10),
  ANNUAL_FEE NUMBER(8),
  PRIMARY KEY (PRODUCT_ID)
);

CREATE TABLE M_CARD (
  CARD_ID    NUMBER(14) NOT NULL,
  CUST_ID    NUMBER(12) NOT NULL,
  PRODUCT_ID NUMBER(8),
  CARD_NO    CHAR(16),
  ISSUE_YMD  CHAR(8),
  EXPIRE_YM  CHAR(6),
  STATUS_CD  CHAR(1),
  LIMIT_AMT  NUMBER(12),
  PRIMARY KEY (CARD_ID)
);

CREATE TABLE M_BENEFIT (
  BENEFIT_ID  NUMBER(8) NOT NULL,
  BENEFIT_NM  VARCHAR2(60),
  CATEGORY_CD VARCHAR2(10),
  PRIMARY KEY (BENEFIT_ID)
);

CREATE TABLE R_CARD_BENEFIT (
  CARD_ID    NUMBER(14) NOT NULL,
  BENEFIT_ID NUMBER(8)  NOT NULL,
  PRIMARY KEY (CARD_ID, BENEFIT_ID)
);

CREATE TABLE M_CARD_LIMIT (
  CARD_ID    NUMBER(14)   NOT NULL,
  LIMIT_TYPE VARCHAR2(10) NOT NULL,
  LIMIT_AMT  NUMBER(14,2),
  PRIMARY KEY (CARD_ID, LIMIT_TYPE)
);

CREATE TABLE M_MERCHANT (
  MERCHANT_ID NUMBER(10) NOT NULL,
  MERCHANT_NM VARCHAR2(60),
  MCC_CD      CHAR(4),
  ADDR        VARCHAR2(120),
  PRIMARY KEY (MERCHANT_ID)
);

CREATE TABLE T_AUTH (
  AUTH_ID     NUMBER(18) NOT NULL,
  CARD_ID     NUMBER(14) NOT NULL,
  MERCHANT_ID NUMBER(10),
  AUTH_YMD    CHAR(8),
  AUTH_TIME   CHAR(6),
  AMOUNT      NUMBER(12),
  CURRENCY_CD CHAR(3),
  APPROVAL_CD CHAR(6),
  STATUS_CD   CHAR(1),
  PRIMARY KEY (AUTH_ID)
);
COMMENT ON TABLE T_AUTH IS '승인 원장 (대용량)';

CREATE TABLE T_AUTH_DETAIL (
  AUTH_ID  NUMBER(18) NOT NULL,
  SEQ      NUMBER(4)  NOT NULL,
  ITEM_AMT NUMBER(12),
  FEE_AMT  NUMBER(10),
  PRIMARY KEY (AUTH_ID, SEQ)
);

CREATE TABLE T_TXN_LOG (
  LOG_ID   NUMBER(18) NOT NULL,
  AUTH_ID  NUMBER(18),
  CARD_NO  CHAR(16),
  RAW_JSON CLOB,
  PRIMARY KEY (LOG_ID)
);

CREATE TABLE T_INSTALLMENT (
  AUTH_ID     NUMBER(18) NOT NULL,
  MONTHS      NUMBER(3),
  MONTHLY_AMT NUMBER(12),
  PRIMARY KEY (AUTH_ID)
);

CREATE TABLE T_SETTLEMENT (
  SETTLE_ID   NUMBER(16) NOT NULL,
  MERCHANT_ID NUMBER(10),
  SETTLE_YMD  CHAR(8),
  GROSS_AMT   NUMBER(16,2),
  FEE_AMT     NUMBER(14,2),
  NET_AMT     NUMBER(16,2),
  PRIMARY KEY (SETTLE_ID)
);

CREATE TABLE T_SETTLE_DETAIL (
  SETTLE_ID NUMBER(16) NOT NULL,
  SEQ       NUMBER(6)  NOT NULL,
  AUTH_ID   NUMBER(18),
  AMT       NUMBER(12,2),
  PRIMARY KEY (SETTLE_ID, SEQ)
);

CREATE TABLE M_CODE_MASTER (
  DOMAIN  VARCHAR2(30) NOT NULL,
  SRC_VAL VARCHAR2(20) NOT NULL,
  TGT_VAL VARCHAR2(40),
  DESCR   VARCHAR2(80),
  PRIMARY KEY (DOMAIN, SRC_VAL)
);

CREATE TABLE M_CURRENCY (
  CCY_CD   CHAR(3) NOT NULL,
  CCY_NM   VARCHAR2(30),
  DECIMALS NUMBER(1),
  PRIMARY KEY (CCY_CD)
);

-- ── 패딩 테이블 (25-30 목표 + UNION 케이스) ──
CREATE TABLE M_CUST_CONSENT (
  CUST_ID    NUMBER(12) NOT NULL,
  MKT_AGREE  CHAR(1),
  MAIL_AGREE CHAR(1),
  AGREE_YMD  CHAR(8),
  PRIMARY KEY (CUST_ID)
);

CREATE TABLE M_MEMBER_TIER_HIST (
  CUST_ID NUMBER(12) NOT NULL,
  SEQ     NUMBER(4)  NOT NULL,
  TIER_CD CHAR(1),
  CHG_YMD CHAR(8),
  PRIMARY KEY (CUST_ID, SEQ)
);

CREATE TABLE M_CARD_HOLDER (
  CARD_ID     NUMBER(14) NOT NULL,
  HOLDER_SEQ  NUMBER(2)  NOT NULL,
  HOLDER_NM   VARCHAR2(60),
  RELATION_CD CHAR(2),
  PRIMARY KEY (CARD_ID, HOLDER_SEQ)
);

CREATE TABLE M_CARD_STATUS_HIST (
  CARD_ID   NUMBER(14) NOT NULL,
  SEQ       NUMBER(4)  NOT NULL,
  STATUS_CD CHAR(1),
  CHG_YMD   CHAR(8),
  PRIMARY KEY (CARD_ID, SEQ)
);

CREATE TABLE T_DECLINE_LOG (
  DECLINE_ID  NUMBER(18) NOT NULL,
  AUTH_ID     NUMBER(18),
  REASON_CD   VARCHAR2(10),
  DECLINE_YMD CHAR(8),
  PRIMARY KEY (DECLINE_ID)
);

CREATE TABLE T_AUTH_2024 (
  AUTH_ID  NUMBER(18) NOT NULL,
  CARD_ID  NUMBER(14),
  AUTH_YMD CHAR(8),
  AMOUNT   NUMBER(12),
  PRIMARY KEY (AUTH_ID)
);

CREATE TABLE T_AUTH_2025 (
  AUTH_ID  NUMBER(18) NOT NULL,
  CARD_ID  NUMBER(14),
  AUTH_YMD CHAR(8),
  AMOUNT   NUMBER(12),
  PRIMARY KEY (AUTH_ID)
);

CREATE TABLE M_MCC (
  MCC_CD CHAR(4)     NOT NULL,
  MCC_NM VARCHAR2(60),
  PRIMARY KEY (MCC_CD)
);

CREATE TABLE T_FEE_SCHEDULE (
  PRODUCT_ID NUMBER(8)    NOT NULL,
  FEE_TYPE   VARCHAR2(10) NOT NULL,
  RATE       NUMBER(5,4),
  PRIMARY KEY (PRODUCT_ID, FEE_TYPE)
);

CREATE TABLE M_BRANCH (
  BRANCH_CD CHAR(4) NOT NULL,
  BRANCH_NM VARCHAR2(60),
  PREF      VARCHAR2(20),
  PRIMARY KEY (BRANCH_CD)
);
"""
    (OUT_ASIS_DDL / "card_asis_oracle.sql").write_text(sql, encoding="utf-8")
    print(f"  AS-IS DDL -> {OUT_ASIS_DDL/'card_asis_oracle.sql'}")


def emit_tobe_ddl():
    OUT_TOBE_DDL.mkdir(parents=True, exist_ok=True)
    sql = """-- TO-BE PostgreSQL DDL — 신용카드사 PoC fixture. side=tobe 로 import.
-- 업무 도메인 schema 분리. binding 의 tobe_schema 가 라우팅.

CREATE SCHEMA IF NOT EXISTS member;
CREATE SCHEMA IF NOT EXISTS card;
CREATE SCHEMA IF NOT EXISTS txn;
CREATE SCHEMA IF NOT EXISTS settle;
CREATE SCHEMA IF NOT EXISTS code;

CREATE TABLE member.customer (
  customer_id     BIGINT PRIMARY KEY,
  member_tier     VARCHAR(4),
  member_type     VARCHAR(4),
  permission_flag VARCHAR(4),
  gender          VARCHAR(6),
  birth_date      DATE,
  registered_at   DATE,
  status          VARCHAR(10)
);
CREATE TABLE member.customer_name (
  customer_id  BIGINT PRIMARY KEY,
  family_kanji VARCHAR(40),
  given_kanji  VARCHAR(40),
  family_kana  VARCHAR(40),
  given_kana   VARCHAR(40)
);
CREATE TABLE member.customer_address (
  customer_id BIGINT PRIMARY KEY,
  zip         VARCHAR(8),
  prefecture  VARCHAR(20),
  city        VARCHAR(40),
  street      VARCHAR(120)
);
CREATE TABLE member.customer_contact (
  customer_id   BIGINT NOT NULL,
  channel       VARCHAR(10) NOT NULL,
  contact_value VARCHAR(120),
  PRIMARY KEY (customer_id, channel)
);

CREATE TABLE card.card_product (
  product_id   INTEGER PRIMARY KEY,
  product_name VARCHAR(60),
  brand        VARCHAR(10),
  annual_fee   NUMERIC(10,0)
);
CREATE TABLE card.card_account (
  card_id        BIGINT PRIMARY KEY,
  customer_id    BIGINT NOT NULL,
  product_id     INTEGER,
  card_no_masked VARCHAR(19),
  issued_date    DATE,
  expire_ym      VARCHAR(6),
  status         VARCHAR(10),
  credit_limit   NUMERIC(14,0)
);
CREATE TABLE card.benefit (
  benefit_id   INTEGER PRIMARY KEY,
  benefit_name VARCHAR(60),
  category     VARCHAR(10)
);
CREATE TABLE card.card_benefit (
  card_id    BIGINT NOT NULL,
  benefit_id INTEGER NOT NULL,
  PRIMARY KEY (card_id, benefit_id)
);
CREATE TABLE card.card_limit (
  card_id      BIGINT NOT NULL,
  limit_type   VARCHAR(10) NOT NULL,
  limit_amount NUMERIC(16,2),
  PRIMARY KEY (card_id, limit_type)
);

CREATE TABLE txn.authorization (
  auth_id       BIGINT PRIMARY KEY,
  card_id       BIGINT NOT NULL,
  merchant_id   BIGINT,
  authorized_at TIMESTAMP,
  amount        NUMERIC(14,0),
  currency      VARCHAR(3),
  approval_code VARCHAR(6),
  status        VARCHAR(10)
);
CREATE TABLE txn.transaction (
  auth_id      BIGINT PRIMARY KEY,
  card_id      BIGINT,
  gross_amount NUMERIC(16,2),
  fee_amount   NUMERIC(14,2),
  net_amount   NUMERIC(16,2)
);
CREATE TABLE txn.transaction_audit (
  log_id         BIGINT PRIMARY KEY,
  auth_id        BIGINT,
  card_no_masked VARCHAR(19),
  payload        JSONB
);
CREATE TABLE txn.installment (
  auth_id        BIGINT PRIMARY KEY,
  months         INTEGER,
  monthly_amount NUMERIC(14,0)
);

CREATE TABLE settle.merchant (
  merchant_id   BIGINT PRIMARY KEY,
  merchant_name VARCHAR(60),
  mcc           VARCHAR(4),
  address       VARCHAR(120)
);
CREATE TABLE settle.settlement (
  settle_id    BIGINT PRIMARY KEY,
  merchant_id  BIGINT,
  settled_date DATE,
  gross_amount NUMERIC(18,2),
  fee_amount   NUMERIC(16,2),
  net_amount   NUMERIC(18,2)
);
CREATE TABLE settle.settlement_fee (
  settle_id BIGINT NOT NULL,
  seq       INTEGER NOT NULL,
  auth_id   BIGINT,
  amount    NUMERIC(14,2),
  PRIMARY KEY (settle_id, seq)
);

CREATE TABLE code.code_dictionary (
  domain       VARCHAR(30) NOT NULL,
  source_value VARCHAR(20) NOT NULL,
  target_value VARCHAR(40),
  description  VARCHAR(80),
  PRIMARY KEY (domain, source_value)
);
CREATE TABLE code.currency (
  currency_code VARCHAR(3) PRIMARY KEY,
  currency_name VARCHAR(30),
  decimals      INTEGER
);

-- ── 패딩 테이블 ──
CREATE TABLE member.customer_consent (
  customer_id      BIGINT PRIMARY KEY,
  marketing_agreed BOOLEAN,
  mail_agreed      BOOLEAN,
  agreed_date      DATE
);
CREATE TABLE member.member_tier_hist (
  customer_id  BIGINT NOT NULL,
  seq          INTEGER NOT NULL,
  tier         VARCHAR(4),
  changed_date DATE,
  PRIMARY KEY (customer_id, seq)
);
CREATE TABLE card.card_holder (
  card_id     BIGINT NOT NULL,
  holder_seq  INTEGER NOT NULL,
  holder_name VARCHAR(60),
  relation    VARCHAR(4),
  PRIMARY KEY (card_id, holder_seq)
);
CREATE TABLE card.card_status_hist (
  card_id      BIGINT NOT NULL,
  seq          INTEGER NOT NULL,
  status       VARCHAR(10),
  changed_date DATE,
  PRIMARY KEY (card_id, seq)
);
CREATE TABLE txn.decline_log (
  decline_id    BIGINT PRIMARY KEY,
  auth_id       BIGINT,
  reason        VARCHAR(20),
  declined_date DATE
);
CREATE TABLE txn.auth_archive (   -- UNION: T_AUTH_2024 ∪ T_AUTH_2025
  auth_id         BIGINT PRIMARY KEY,
  card_id         BIGINT,
  authorized_date DATE,
  amount          NUMERIC(14,0)
);
CREATE TABLE settle.mcc_master (
  mcc      VARCHAR(4) PRIMARY KEY,
  mcc_name VARCHAR(60)
);
CREATE TABLE settle.fee_schedule (
  product_id INTEGER NOT NULL,
  fee_type   VARCHAR(10) NOT NULL,
  rate       NUMERIC(6,4),
  PRIMARY KEY (product_id, fee_type)
);
CREATE TABLE code.branch (
  branch_code VARCHAR(4) PRIMARY KEY,
  branch_name VARCHAR(60),
  prefecture  VARCHAR(20)
);
"""
    (OUT_TOBE_DDL / "card_tobe_pg.sql").write_text(sql, encoding="utf-8")
    print(f"  TO-BE DDL -> {OUT_TOBE_DDL/'card_tobe_pg.sql'}")


def gen_stage(stage):
    rng = random.Random(STAGE_SEEDS[stage])
    t = TIER[stage]
    n_cust, n_card, n_auth, n_merch = t["customer"], t["card"], t["auth"], t["merchant"]
    base = date(2018, 1, 1)

    w = AsIs(stage, "M_CODE_MASTER", ["DOMAIN","SRC_VAL","TGT_VAL","DESCR"])
    for r in [("GENDER","1","MALE","男性"),("GENDER","2","FEMALE","女性"),
              ("CARD_STATUS","A","ACTIVE","有効"),("CARD_STATUS","C","CLOSED","解約"),
              ("CARD_STATUS","F","FROZEN","停止"),("CARD_STATUS","S","SUSPENDED","一時停止"),
              ("AUTH_STATUS","0","APPROVED","承認"),("AUTH_STATUS","1","DECLINED","拒否"),
              ("AUTH_STATUS","2","CANCELLED","取消"),
              ("CUST_STATUS","A","ACTIVE","正常"),("CUST_STATUS","C","CLOSED","退会"),
              ("CUST_STATUS","F","FROZEN","凍結")]:
        w.write(list(r))
    w.close()

    w = AsIs(stage, "M_CURRENCY", ["CCY_CD","CCY_NM","DECIMALS"])
    for r in [("JPY","日本円",0),("USD","米ドル",2),("EUR","ユーロ",2),("KRW","韓国ウォン",0)]:
        w.write(list(r))
    w.close()

    n_prod = 20
    w = AsIs(stage, "M_CARD_PRODUCT", ["PRODUCT_ID","PRODUCT_NM","BRAND_CD","ANNUAL_FEE"])
    for i in range(1, n_prod+1):
        b = rng.choice(BRANDS)
        w.write([i, f"{b}カード{i:02d}", b, rng.choice([0,1100,5500,11000,33000])])
    w.close()

    n_benefit = len(BENEFITS)
    w = AsIs(stage, "M_BENEFIT", ["BENEFIT_ID","BENEFIT_NM","CATEGORY_CD"])
    for i, bn in enumerate(BENEFITS, 1):
        w.write([i, bn, rng.choice(["TRAVEL","POINT","INSURE","DISCOUNT"])])
    w.close()

    w = AsIs(stage, "M_MERCHANT", ["MERCHANT_ID","MERCHANT_NM","MCC_CD","ADDR"])
    for i in range(1, n_merch+1):
        pr = rng.choice(PREF)
        w.write([i, rng.choice(MERCH_NM)+f"{i%999:03d}店", f"{rng.randint(5000,5999)}",
                 f"{pr[0]}{pr[1]}{rng.randint(1,9)}-{rng.randint(1,30)}"])
    w.close()

    wc = AsIs(stage, "M_CUSTOMER", ["CUST_ID","KAIIN_KBN","CUST_NM_KANJI","CUST_NM_KANA",
              "GENDER_CD","BIRTH_YMD","ZIP","PREF","CITY","ADDR_LINE","REG_DATE","STATUS_CD"])
    wk = AsIs(stage, "M_CUST_KANA", ["CUST_ID","NM_KANA_SEI","NM_KANA_MEI"])
    wt = AsIs(stage, "M_CUST_CONTACT", ["CUST_ID","EMAIL","TEL","MOBILE"])
    for cid in range(1, n_cust+1):
        fam = rng.choice(FAMILY); male = rng.random() < 0.5
        giv = rng.choice(GIVEN_M if male else GIVEN_F); pr = rng.choice(PREF)
        birth = date(rng.randint(1955,2003), rng.randint(1,12), rng.randint(1,28))
        reg = base + timedelta(days=rng.randint(0,2500))
        wc.write([cid, rng.choice(KAIIN_KBN), f"{fam[0]} {giv[0]}", f"{fam[1]} {giv[1]}",
                  "1" if male else "2", ymd(birth),
                  f"{rng.randint(100,998):03d}{rng.randint(1000,9998):04d}", pr[0], pr[1],
                  f"{rng.randint(1,9)}-{rng.randint(1,30)}-{rng.randint(1,20)}",
                  oradate(reg), rng.choice(["A","A","A","C","F"])])
        wk.write([cid, fam[1], giv[1]])
        email = f"user{cid}@example.jp" if rng.random() < 0.9 else None
        tel = f"0{rng.randint(3,9)}{rng.randint(1000,9999)}{rng.randint(1000,9999)}" if rng.random() < 0.7 else None
        mob = f"090{rng.randint(1000,9999)}{rng.randint(1000,9999)}" if rng.random() < 0.85 else None
        wt.write([cid, email, tel, mob])
    wc.close(); wk.close(); wt.close()

    wcd = AsIs(stage, "M_CARD", ["CARD_ID","CUST_ID","PRODUCT_ID","CARD_NO","ISSUE_YMD","EXPIRE_YM","STATUS_CD","LIMIT_AMT"])
    wcb = AsIs(stage, "R_CARD_BENEFIT", ["CARD_ID","BENEFIT_ID"])
    wcl = AsIs(stage, "M_CARD_LIMIT", ["CARD_ID","LIMIT_TYPE","LIMIT_AMT"])
    for card_id in range(1, n_card+1):
        iss = base + timedelta(days=rng.randint(0,2500))
        cardno = "".join(str(rng.randint(0,9)) for _ in range(16))
        wcd.write([card_id, rng.randint(1,n_cust), rng.randint(1,n_prod), cardno, ymd(iss),
                   f"{rng.randint(2026,2031)}{rng.randint(1,12):02d}",
                   rng.choice(["A","A","A","C","F","S"]), rng.choice([100,300,500,1000])*10000])
        for bid in rng.sample(range(1,n_benefit+1), rng.randint(1,3)):
            wcb.write([card_id, bid])
        for lt in ["MONTHLY","CASH","INSTALL"]:
            wcl.write([card_id, lt, f"{rng.choice([50,100,300])*10000}.00"])
    wcd.close(); wcb.close(); wcl.close()

    wa = AsIs(stage, "T_AUTH", ["AUTH_ID","CARD_ID","MERCHANT_ID","AUTH_YMD","AUTH_TIME","AMOUNT","CURRENCY_CD","APPROVAL_CD","STATUS_CD"])
    wd = AsIs(stage, "T_AUTH_DETAIL", ["AUTH_ID","SEQ","ITEM_AMT","FEE_AMT"])
    wl = AsIs(stage, "T_TXN_LOG", ["LOG_ID","AUTH_ID","CARD_NO","RAW_JSON"])
    wi = AsIs(stage, "T_INSTALLMENT", ["AUTH_ID","MONTHS","MONTHLY_AMT"])
    log_id = 0
    big = stage in ("staging","prod")
    for aid in range(1, n_auth+1):
        d = base + timedelta(days=rng.randint(0,2900))
        amt = rng.randint(1,2000)*100
        status = rng.choice(["0","0","0","0","1","2"])
        wa.write([aid, rng.randint(1,n_card), rng.randint(1,n_merch), ymd(d),
                  f"{rng.randint(0,23):02d}{rng.randint(0,59):02d}{rng.randint(0,59):02d}",
                  amt, rng.choice(["JPY","JPY","JPY","USD"]), f"{rng.randint(0,999999):06d}", status])
        ndet = 1 if big else rng.randint(1,3)
        for seq in range(1, ndet+1):
            wd.write([aid, seq, amt//ndet, (amt//ndet)//100])
        if not big or rng.random() < 0.1:
            log_id += 1
            cardno = "".join(str(rng.randint(0,9)) for _ in range(16))
            wl.write([log_id, aid, cardno, '{"mid":%d,"amt":%d,"st":"%s"}' % (rng.randint(1,n_merch), amt, status)])
        if rng.random() < 0.2:
            months = rng.choice([3,6,12,24])
            wi.write([aid, months, amt//months if rng.random() < 0.8 else None])
    wa.close(); wd.close(); wl.close(); wi.close()

    ws = AsIs(stage, "T_SETTLEMENT", ["SETTLE_ID","MERCHANT_ID","SETTLE_YMD","GROSS_AMT","FEE_AMT","NET_AMT"])
    wsd = AsIs(stage, "T_SETTLE_DETAIL", ["SETTLE_ID","SEQ","AUTH_ID","AMT"])
    n_settle = max(1, n_merch*3)
    for sid in range(1, n_settle+1):
        d = base + timedelta(days=rng.randint(0,2900))
        gross = rng.randint(10000,9000000); fee = int(gross*0.03)
        ws.write([sid, rng.randint(1,n_merch), ymd(d), f"{gross}.00", f"{fee}.00", f"{gross-fee}.00"])
        for seq in range(1, rng.randint(1,4)):
            wsd.write([sid, seq, rng.randint(1,n_auth), f"{rng.randint(100,90000)}.00"])
    ws.close(); wsd.close()

    # ── 패딩 테이블 데이터 ──
    w = AsIs(stage, "M_CUST_CONSENT", ["CUST_ID","MKT_AGREE","MAIL_AGREE","AGREE_YMD"])
    for cid in range(1, n_cust+1):
        d = base + timedelta(days=rng.randint(0,2500))
        w.write([cid, rng.choice(["1","0"]), rng.choice(["1","0"]), ymd(d)])
    w.close()

    w = AsIs(stage, "M_MEMBER_TIER_HIST", ["CUST_ID","SEQ","TIER_CD","CHG_YMD"])
    for cid in range(1, n_cust+1):
        for seq in range(1, rng.randint(1,3)+1):
            d = base + timedelta(days=rng.randint(0,2900))
            w.write([cid, seq, rng.choice(["1","2","3"]), ymd(d)])
    w.close()

    w = AsIs(stage, "M_CARD_HOLDER", ["CARD_ID","HOLDER_SEQ","HOLDER_NM","RELATION_CD"])
    for card_id in range(1, n_card+1):
        for hs in range(1, rng.randint(1,2)+1):
            fam = rng.choice(FAMILY); giv = rng.choice(GIVEN_M+GIVEN_F)
            w.write([card_id, hs, f"{fam[0]} {giv[0]}", "01" if hs==1 else rng.choice(["02","03"])])
    w.close()

    w = AsIs(stage, "M_CARD_STATUS_HIST", ["CARD_ID","SEQ","STATUS_CD","CHG_YMD"])
    for card_id in range(1, n_card+1):
        for seq in range(1, rng.randint(1,3)+1):
            d = base + timedelta(days=rng.randint(0,2900))
            w.write([card_id, seq, rng.choice(["A","C","F","S"]), ymd(d)])
    w.close()

    # decline_log — 거절(status=1) auth 비율만큼 (auth 의 ~15%)
    w = AsIs(stage, "T_DECLINE_LOG", ["DECLINE_ID","AUTH_ID","REASON_CD","DECLINE_YMD"])
    did = 0
    for aid in range(1, n_auth+1):
        if rng.random() < 0.15:
            did += 1
            d = base + timedelta(days=rng.randint(0,2900))
            w.write([did, aid, rng.choice(["LIMIT","FRAUD","EXPIRE","SYS"]), ymd(d)])
    w.close()

    # auth_archive 의 source 2종 (UNION 케이스) — auth 를 연도로 분할
    w24 = AsIs(stage, "T_AUTH_2024", ["AUTH_ID","CARD_ID","AUTH_YMD","AMOUNT"])
    w25 = AsIs(stage, "T_AUTH_2025", ["AUTH_ID","CARD_ID","AUTH_YMD","AMOUNT"])
    n_arch = min(n_auth, 200_000 if stage in ("staging","prod") else n_auth)
    for aid in range(1, n_arch+1):
        amt = rng.randint(1,2000)*100
        if aid % 2 == 0:
            w24.write([aid, rng.randint(1,n_card), f"2024{rng.randint(1,12):02d}{rng.randint(1,28):02d}", amt])
        else:
            w25.write([aid, rng.randint(1,n_card), f"2025{rng.randint(1,12):02d}{rng.randint(1,28):02d}", amt])
    w24.close(); w25.close()

    w = AsIs(stage, "M_MCC", ["MCC_CD","MCC_NM"])
    for cd, nm in [("5411","スーパー"),("5541","ガソリン"),("5812","飲食"),("5912","ドラッグ"),
                   ("4111","交通"),("5311","百貨店"),("5999","その他小売"),("7011","ホテル")]:
        w.write([cd, nm])
    w.close()

    w = AsIs(stage, "T_FEE_SCHEDULE", ["PRODUCT_ID","FEE_TYPE","RATE"])
    for pid in range(1, n_prod+1):
        for ft in ["DOMESTIC","OVERSEA","CASH"]:
            w.write([pid, ft, f"0.{rng.randint(100,350):04d}"])
    w.close()

    w = AsIs(stage, "M_BRANCH", ["BRANCH_CD","BRANCH_NM","PREF"])
    for i in range(1, 21):
        pr = rng.choice(PREF)
        w.write([f"{i:04d}", f"{pr[1]}支店", pr[0]])
    w.close()

    print(f"  [{stage}] auth={n_auth:,} customer={n_cust:,} card={n_card:,} merchant={n_merch:,} (+padding)")


def emit_mappings():
    OUT_MAP.mkdir(parents=True, exist_ok=True)
    cols = ["tobe_table","tobe_column","asis_table","asis_column","asis_type",
            "tobe_type","strategy","code_domain","default_value","notes"]
    def r(tt,tc,at="",ac="",aty="",tty="",st="expression",cd="",dv="",nt=""):
        return {"tobe_table":tt,"tobe_column":tc,"asis_table":at,"asis_column":ac,"asis_type":aty,
                "tobe_type":tty,"strategy":st,"code_domain":cd,"default_value":dv,"notes":nt}
    m = [
        r("member.customer","customer_id","M_CUSTOMER","CUST_ID","NUMBER","BIGINT"),
        r("member.customer","member_tier","M_CUSTOMER","KAIIN_KBN","CHAR(4)","VARCHAR",nt="복합코드 SUBSTR 1"),
        r("member.customer","member_type","M_CUSTOMER","KAIIN_KBN","CHAR(4)","VARCHAR",nt="복합코드 SUBSTR 2"),
        r("member.customer","permission_flag","M_CUSTOMER","KAIIN_KBN","CHAR(4)","VARCHAR",nt="복합코드 SUBSTR 3-4"),
        r("member.customer","gender","M_CUSTOMER","GENDER_CD","CHAR(1)","VARCHAR",cd="GENDER"),
        r("member.customer","birth_date","M_CUSTOMER","BIRTH_YMD","CHAR(8)","DATE",nt="YYYYMMDD→DATE"),
        r("member.customer","registered_at","M_CUSTOMER","REG_DATE","DATE","DATE"),
        r("member.customer","status","M_CUSTOMER","STATUS_CD","CHAR(1)","VARCHAR",cd="CUST_STATUS"),
        r("member.customer_name","customer_id","M_CUSTOMER","CUST_ID","NUMBER","BIGINT"),
        r("member.customer_name","family_kanji","M_CUSTOMER","CUST_NM_KANJI","VARCHAR2","VARCHAR",nt="공백 앞"),
        r("member.customer_name","given_kanji","M_CUSTOMER","CUST_NM_KANJI","VARCHAR2","VARCHAR",nt="공백 뒤"),
        r("member.customer_name","family_kana","M_CUST_KANA","NM_KANA_SEI","VARCHAR2","VARCHAR",nt="N:1 merge JOIN CUST_ID"),
        r("member.customer_name","given_kana","M_CUST_KANA","NM_KANA_MEI","VARCHAR2","VARCHAR",nt="N:1 merge"),
        r("member.customer_address","customer_id","M_CUSTOMER","CUST_ID","NUMBER","BIGINT"),
        r("member.customer_address","zip","M_CUSTOMER","ZIP","CHAR(7)","VARCHAR"),
        r("member.customer_address","prefecture","M_CUSTOMER","PREF","VARCHAR2","VARCHAR"),
        r("member.customer_address","city","M_CUSTOMER","CITY","VARCHAR2","VARCHAR"),
        r("member.customer_address","street","M_CUSTOMER","ADDR_LINE","VARCHAR2","VARCHAR"),
        r("member.customer_contact","customer_id","M_CUST_CONTACT","CUST_ID","NUMBER","BIGINT",nt="1:N expand 기준"),
        r("member.customer_contact","channel","M_CUST_CONTACT","","","VARCHAR",nt="1:N expand EMAIL/TEL/MOBILE"),
        r("member.customer_contact","contact_value","M_CUST_CONTACT","","","VARCHAR",nt="expand 값"),
        r("card.card_product","product_id","M_CARD_PRODUCT","PRODUCT_ID","NUMBER","INTEGER"),
        r("card.card_product","product_name","M_CARD_PRODUCT","PRODUCT_NM","VARCHAR2","VARCHAR"),
        r("card.card_product","brand","M_CARD_PRODUCT","BRAND_CD","VARCHAR2","VARCHAR"),
        r("card.card_product","annual_fee","M_CARD_PRODUCT","ANNUAL_FEE","NUMBER","NUMERIC"),
        r("card.card_account","card_id","M_CARD","CARD_ID","NUMBER","BIGINT"),
        r("card.card_account","customer_id","M_CARD","CUST_ID","NUMBER","BIGINT"),
        r("card.card_account","product_id","M_CARD","PRODUCT_ID","NUMBER","INTEGER"),
        r("card.card_account","card_no_masked","M_CARD","CARD_NO","CHAR(16)","VARCHAR",nt="마스킹 앞4+****+뒤4"),
        r("card.card_account","issued_date","M_CARD","ISSUE_YMD","CHAR(8)","DATE",nt="YYYYMMDD→DATE"),
        r("card.card_account","expire_ym","M_CARD","EXPIRE_YM","CHAR(6)","VARCHAR"),
        r("card.card_account","status","M_CARD","STATUS_CD","CHAR(1)","VARCHAR",cd="CARD_STATUS"),
        r("card.card_account","credit_limit","M_CARD","LIMIT_AMT","NUMBER","NUMERIC"),
        r("card.benefit","benefit_id","M_BENEFIT","BENEFIT_ID","NUMBER","INTEGER"),
        r("card.benefit","benefit_name","M_BENEFIT","BENEFIT_NM","VARCHAR2","VARCHAR"),
        r("card.benefit","category","M_BENEFIT","CATEGORY_CD","VARCHAR2","VARCHAR"),
        r("card.card_benefit","card_id","R_CARD_BENEFIT","CARD_ID","NUMBER","BIGINT",nt="N:N junction"),
        r("card.card_benefit","benefit_id","R_CARD_BENEFIT","BENEFIT_ID","NUMBER","INTEGER",nt="N:N junction"),
        r("card.card_limit","card_id","M_CARD_LIMIT","CARD_ID","NUMBER","BIGINT"),
        r("card.card_limit","limit_type","M_CARD_LIMIT","LIMIT_TYPE","VARCHAR2","VARCHAR"),
        r("card.card_limit","limit_amount","M_CARD_LIMIT","LIMIT_AMT","NUMBER(14,2)","NUMERIC"),
        r("txn.authorization","auth_id","T_AUTH","AUTH_ID","NUMBER","BIGINT"),
        r("txn.authorization","card_id","T_AUTH","CARD_ID","NUMBER","BIGINT"),
        r("txn.authorization","merchant_id","T_AUTH","MERCHANT_ID","NUMBER","BIGINT"),
        r("txn.authorization","authorized_at","T_AUTH","AUTH_YMD;AUTH_TIME","CHAR(8);CHAR(6)","TIMESTAMP",nt="YMD+TIME 합성 STRPTIME"),
        r("txn.authorization","amount","T_AUTH","AMOUNT","NUMBER","NUMERIC"),
        r("txn.authorization","currency","T_AUTH","CURRENCY_CD","CHAR(3)","VARCHAR"),
        r("txn.authorization","approval_code","T_AUTH","APPROVAL_CD","CHAR(6)","VARCHAR"),
        r("txn.authorization","status","T_AUTH","STATUS_CD","CHAR(1)","VARCHAR",cd="AUTH_STATUS"),
        r("txn.transaction","auth_id","T_AUTH","AUTH_ID","NUMBER","BIGINT",nt="N:1 merge T_AUTH+T_AUTH_DETAIL"),
        r("txn.transaction","card_id","T_AUTH","CARD_ID","NUMBER","BIGINT"),
        r("txn.transaction","gross_amount","T_AUTH","AMOUNT","NUMBER","NUMERIC"),
        r("txn.transaction","fee_amount","T_AUTH_DETAIL","FEE_AMT","NUMBER","NUMERIC",nt="JOIN AUTH_ID SUM"),
        r("txn.transaction","net_amount","T_AUTH","AMOUNT","NUMBER","NUMERIC",nt="amount-fee 식"),
        r("txn.transaction_audit","log_id","T_TXN_LOG","LOG_ID","NUMBER","BIGINT"),
        r("txn.transaction_audit","auth_id","T_TXN_LOG","AUTH_ID","NUMBER","BIGINT"),
        r("txn.transaction_audit","card_no_masked","T_TXN_LOG","CARD_NO","CHAR(16)","VARCHAR",nt="마스킹"),
        r("txn.transaction_audit","payload","T_TXN_LOG","RAW_JSON","CLOB","JSONB",nt="CLOB→JSONB"),
        r("txn.installment","auth_id","T_INSTALLMENT","AUTH_ID","NUMBER","BIGINT"),
        r("txn.installment","months","T_INSTALLMENT","MONTHS","NUMBER","INTEGER"),
        r("txn.installment","monthly_amount","T_INSTALLMENT","MONTHLY_AMT","NUMBER","NUMERIC",st="default",dv="0",nt="NULL→default 0"),
        r("settle.merchant","merchant_id","M_MERCHANT","MERCHANT_ID","NUMBER","BIGINT"),
        r("settle.merchant","merchant_name","M_MERCHANT","MERCHANT_NM","VARCHAR2","VARCHAR"),
        r("settle.merchant","mcc","M_MERCHANT","MCC_CD","CHAR(4)","VARCHAR"),
        r("settle.merchant","address","M_MERCHANT","ADDR","VARCHAR2","VARCHAR"),
        r("settle.settlement","settle_id","T_SETTLEMENT","SETTLE_ID","NUMBER","BIGINT"),
        r("settle.settlement","merchant_id","T_SETTLEMENT","MERCHANT_ID","NUMBER","BIGINT"),
        r("settle.settlement","settled_date","T_SETTLEMENT","SETTLE_YMD","CHAR(8)","DATE"),
        r("settle.settlement","gross_amount","T_SETTLEMENT","GROSS_AMT","NUMBER(16,2)","NUMERIC"),
        r("settle.settlement","fee_amount","T_SETTLEMENT","FEE_AMT","NUMBER(14,2)","NUMERIC"),
        r("settle.settlement","net_amount","T_SETTLEMENT","NET_AMT","NUMBER(16,2)","NUMERIC"),
        r("settle.settlement_fee","settle_id","T_SETTLE_DETAIL","SETTLE_ID","NUMBER","BIGINT"),
        r("settle.settlement_fee","seq","T_SETTLE_DETAIL","SEQ","NUMBER","INTEGER"),
        r("settle.settlement_fee","auth_id","T_SETTLE_DETAIL","AUTH_ID","NUMBER","BIGINT"),
        r("settle.settlement_fee","amount","T_SETTLE_DETAIL","AMT","NUMBER(12,2)","NUMERIC"),
        r("code.code_dictionary","domain","M_CODE_MASTER","DOMAIN","VARCHAR2","VARCHAR"),
        r("code.code_dictionary","source_value","M_CODE_MASTER","SRC_VAL","VARCHAR2","VARCHAR"),
        r("code.code_dictionary","target_value","M_CODE_MASTER","TGT_VAL","VARCHAR2","VARCHAR"),
        r("code.code_dictionary","description","M_CODE_MASTER","DESCR","VARCHAR2","VARCHAR"),
        r("code.currency","currency_code","M_CURRENCY","CCY_CD","CHAR(3)","VARCHAR"),
        r("code.currency","currency_name","M_CURRENCY","CCY_NM","VARCHAR2","VARCHAR"),
        r("code.currency","decimals","M_CURRENCY","DECIMALS","NUMBER","INTEGER"),
        # ── 패딩 테이블 매핑 ──
        r("member.customer_consent","customer_id","M_CUST_CONSENT","CUST_ID","NUMBER","BIGINT"),
        r("member.customer_consent","marketing_agreed","M_CUST_CONSENT","MKT_AGREE","CHAR(1)","BOOLEAN",nt="1/0→bool"),
        r("member.customer_consent","mail_agreed","M_CUST_CONSENT","MAIL_AGREE","CHAR(1)","BOOLEAN",nt="1/0→bool"),
        r("member.customer_consent","agreed_date","M_CUST_CONSENT","AGREE_YMD","CHAR(8)","DATE"),
        r("member.member_tier_hist","customer_id","M_MEMBER_TIER_HIST","CUST_ID","NUMBER","BIGINT"),
        r("member.member_tier_hist","seq","M_MEMBER_TIER_HIST","SEQ","NUMBER","INTEGER"),
        r("member.member_tier_hist","tier","M_MEMBER_TIER_HIST","TIER_CD","CHAR(1)","VARCHAR"),
        r("member.member_tier_hist","changed_date","M_MEMBER_TIER_HIST","CHG_YMD","CHAR(8)","DATE"),
        r("card.card_holder","card_id","M_CARD_HOLDER","CARD_ID","NUMBER","BIGINT"),
        r("card.card_holder","holder_seq","M_CARD_HOLDER","HOLDER_SEQ","NUMBER","INTEGER"),
        r("card.card_holder","holder_name","M_CARD_HOLDER","HOLDER_NM","VARCHAR2","VARCHAR"),
        r("card.card_holder","relation","M_CARD_HOLDER","RELATION_CD","CHAR(2)","VARCHAR"),
        r("card.card_status_hist","card_id","M_CARD_STATUS_HIST","CARD_ID","NUMBER","BIGINT"),
        r("card.card_status_hist","seq","M_CARD_STATUS_HIST","SEQ","NUMBER","INTEGER"),
        r("card.card_status_hist","status","M_CARD_STATUS_HIST","STATUS_CD","CHAR(1)","VARCHAR",cd="CARD_STATUS"),
        r("card.card_status_hist","changed_date","M_CARD_STATUS_HIST","CHG_YMD","CHAR(8)","DATE"),
        r("txn.decline_log","decline_id","T_DECLINE_LOG","DECLINE_ID","NUMBER","BIGINT"),
        r("txn.decline_log","auth_id","T_DECLINE_LOG","AUTH_ID","NUMBER","BIGINT"),
        r("txn.decline_log","reason","T_DECLINE_LOG","REASON_CD","VARCHAR2","VARCHAR"),
        r("txn.decline_log","declined_date","T_DECLINE_LOG","DECLINE_YMD","CHAR(8)","DATE"),
        # auth_archive = UNION (T_AUTH_2024 ∪ T_AUTH_2025) — import 후 UI 에서 composition 을 union 으로 전환
        r("txn.auth_archive","auth_id","T_AUTH_2024","AUTH_ID","NUMBER","BIGINT",nt="UNION 2024∪2025 (UI 전환)"),
        r("txn.auth_archive","card_id","T_AUTH_2024","CARD_ID","NUMBER","BIGINT"),
        r("txn.auth_archive","authorized_date","T_AUTH_2024","AUTH_YMD","CHAR(8)","DATE"),
        r("txn.auth_archive","amount","T_AUTH_2024","AMOUNT","NUMBER","NUMERIC"),
        r("settle.mcc_master","mcc","M_MCC","MCC_CD","CHAR(4)","VARCHAR"),
        r("settle.mcc_master","mcc_name","M_MCC","MCC_NM","VARCHAR2","VARCHAR"),
        r("settle.fee_schedule","product_id","T_FEE_SCHEDULE","PRODUCT_ID","NUMBER","INTEGER"),
        r("settle.fee_schedule","fee_type","T_FEE_SCHEDULE","FEE_TYPE","VARCHAR2","VARCHAR"),
        r("settle.fee_schedule","rate","T_FEE_SCHEDULE","RATE","NUMBER(5,4)","NUMERIC"),
        r("code.branch","branch_code","M_BRANCH","BRANCH_CD","CHAR(4)","VARCHAR"),
        r("code.branch","branch_name","M_BRANCH","BRANCH_NM","VARCHAR2","VARCHAR"),
        r("code.branch","prefecture","M_BRANCH","PREF","VARCHAR2","VARCHAR"),
    ]
    p = OUT_MAP / "column_mapping.csv"
    with open(p, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f); wr.writerow(cols)
        for x in m: wr.writerow([x[c] for c in cols])
    print(f"  mapping -> {p} ({len(m)} rows)")

    p = OUT_MAP / "code_mapping.csv"
    with open(p, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f); wr.writerow(["domain","source_value","target_value","description"])
        for row in [("GENDER","1","'MALE'","男性"),("GENDER","2","'FEMALE'","女性"),
                    ("CARD_STATUS","A","'ACTIVE'",""),("CARD_STATUS","C","'CLOSED'",""),
                    ("CARD_STATUS","F","'FROZEN'",""),("CARD_STATUS","S","'SUSPENDED'",""),
                    ("AUTH_STATUS","0","'APPROVED'",""),("AUTH_STATUS","1","'DECLINED'",""),
                    ("AUTH_STATUS","2","'CANCELLED'",""),
                    ("CUST_STATUS","A","'ACTIVE'",""),("CUST_STATUS","C","'CLOSED'",""),
                    ("CUST_STATUS","F","'FROZEN'","")]:
            wr.writerow(row)
    print(f"  mapping -> {p}")


def main():
    stages = [s for s in sys.argv[1:] if s in ALL_STAGES] or list(ALL_STAGES)
    print("DDL ...")
    emit_asis_ddl(); emit_tobe_ddl()
    print("Mappings ...")
    emit_mappings()
    print(f"Data (Shift-JIS) stages={stages}")
    for s in stages:
        gen_stage(s)
    print("done.")


if __name__ == "__main__":
    main()
