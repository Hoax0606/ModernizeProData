-- ==========================================================================
--  AS-IS schema (reference) — 日本の証券会社の口座/取引系
--  Oracle 11g+ syntax. PostgreSQL 移行先のマッピング先は db/tobe/{stage}/init.sql.
--
--  Relationships covered (per migration tool requirements):
--    1:N  M_CUSTOMER       -> M_ACCOUNT          (1 customer has many accounts)
--    N:1  T_TRADE          -> M_ACCOUNT          (many trades for one account)
--    N:N  M_ACCOUNT  <-->  M_PRODUCT  via R_ACCOUNT_PRODUCT
--
--  This file is reference only — there is no Oracle container in this
--  repo. The PoC tool reads operations team's nightly CSV extracts, not
--  a live Oracle.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  顧客マスタ (Customer master)
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_M_CUSTOMER START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE M_CUSTOMER (
    CUSTOMER_ID        NUMBER(10)     NOT NULL,
    CUSTOMER_CD        VARCHAR2(20)   NOT NULL,
    CUSTOMER_NM        VARCHAR2(100)  NOT NULL,
    CUSTOMER_NM_KANA   VARCHAR2(200),
    BIRTH_DT           DATE,
    GENDER_CD          CHAR(1),
    EMAIL              VARCHAR2(128),
    PHONE              VARCHAR2(20),
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    UPDATE_TS          DATE,
    CONSTRAINT PK_M_CUSTOMER       PRIMARY KEY (CUSTOMER_ID),
    CONSTRAINT UK_M_CUSTOMER_CD    UNIQUE (CUSTOMER_CD),
    CONSTRAINT CK_M_CUSTOMER_GEN   CHECK (GENDER_CD IN ('M', 'F'))
);

COMMENT ON TABLE  M_CUSTOMER                  IS '顧客マスタ';
COMMENT ON COLUMN M_CUSTOMER.CUSTOMER_ID      IS '顧客ID (PK)';
COMMENT ON COLUMN M_CUSTOMER.CUSTOMER_CD      IS '顧客コード';
COMMENT ON COLUMN M_CUSTOMER.CUSTOMER_NM      IS '顧客名';
COMMENT ON COLUMN M_CUSTOMER.CUSTOMER_NM_KANA IS '顧客名カナ';
COMMENT ON COLUMN M_CUSTOMER.GENDER_CD        IS '性別区分 M=男 / F=女';

-- --------------------------------------------------------------------------
--  商品マスタ (Product master)
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_M_PRODUCT START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE M_PRODUCT (
    PRODUCT_ID         NUMBER(8)      NOT NULL,
    PRODUCT_CD         VARCHAR2(20)   NOT NULL,
    PRODUCT_NM         VARCHAR2(100)  NOT NULL,
    PRODUCT_KIND_CD    CHAR(2)        NOT NULL,
    UNIT_PRICE         NUMBER(15,4),
    CURRENCY_CD        CHAR(3)        DEFAULT 'JPY' NOT NULL,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT PK_M_PRODUCT        PRIMARY KEY (PRODUCT_ID),
    CONSTRAINT UK_M_PRODUCT_CD     UNIQUE (PRODUCT_CD),
    CONSTRAINT CK_M_PRODUCT_KIND   CHECK (PRODUCT_KIND_CD IN ('10', '20', '30'))
);

COMMENT ON TABLE  M_PRODUCT                  IS '商品マスタ';
COMMENT ON COLUMN M_PRODUCT.PRODUCT_KIND_CD  IS '商品種別 10=株式 / 20=債券 / 30=投資信託';
COMMENT ON COLUMN M_PRODUCT.UNIT_PRICE       IS '単価';
COMMENT ON COLUMN M_PRODUCT.CURRENCY_CD      IS '通貨コード ISO 4217';

-- --------------------------------------------------------------------------
--  口座マスタ (Account master) — 顧客 1:N 口座
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_M_ACCOUNT START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE M_ACCOUNT (
    ACCOUNT_ID         NUMBER(12)     NOT NULL,
    CUSTOMER_ID        NUMBER(10)     NOT NULL,
    ACCOUNT_NO         VARCHAR2(20)   NOT NULL,
    ACCOUNT_KIND_CD    CHAR(2)        NOT NULL,
    BALANCE            NUMBER(15,2)   DEFAULT 0 NOT NULL,
    OPENED_DT          DATE           NOT NULL,
    STATUS_CD          CHAR(1)        NOT NULL,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    UPDATE_TS          DATE,
    CONSTRAINT PK_M_ACCOUNT        PRIMARY KEY (ACCOUNT_ID),
    CONSTRAINT UK_M_ACCOUNT_NO     UNIQUE (ACCOUNT_NO),
    CONSTRAINT CK_M_ACCOUNT_KIND   CHECK (ACCOUNT_KIND_CD IN ('01', '02')),
    CONSTRAINT CK_M_ACCOUNT_STATUS CHECK (STATUS_CD       IN ('A', 'C', 'F')),
    CONSTRAINT FK_M_ACCOUNT_CUST   FOREIGN KEY (CUSTOMER_ID) REFERENCES M_CUSTOMER (CUSTOMER_ID)
);

COMMENT ON TABLE  M_ACCOUNT                  IS '口座マスタ';
COMMENT ON COLUMN M_ACCOUNT.ACCOUNT_KIND_CD  IS '口座種別 01=普通 / 02=特定';
COMMENT ON COLUMN M_ACCOUNT.STATUS_CD        IS '状態 A=有効 / C=停止 / F=閉鎖';
COMMENT ON COLUMN M_ACCOUNT.BALANCE          IS '残高';

-- --------------------------------------------------------------------------
--  口座-商品 保有関係 (Account ↔ Product, N:N) — 複合 PK
-- --------------------------------------------------------------------------
CREATE TABLE R_ACCOUNT_PRODUCT (
    ACCOUNT_ID         NUMBER(12)     NOT NULL,
    PRODUCT_ID         NUMBER(8)      NOT NULL,
    HOLDING_QTY        NUMBER(15,4)   DEFAULT 0 NOT NULL,
    START_DT           DATE           NOT NULL,
    END_DT             DATE,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT PK_R_ACCOUNT_PRODUCT PRIMARY KEY (ACCOUNT_ID, PRODUCT_ID),
    CONSTRAINT FK_R_AP_ACCOUNT      FOREIGN KEY (ACCOUNT_ID) REFERENCES M_ACCOUNT (ACCOUNT_ID),
    CONSTRAINT FK_R_AP_PRODUCT      FOREIGN KEY (PRODUCT_ID) REFERENCES M_PRODUCT (PRODUCT_ID)
);

COMMENT ON TABLE  R_ACCOUNT_PRODUCT             IS '口座-商品 保有関係 (N:N)';
COMMENT ON COLUMN R_ACCOUNT_PRODUCT.HOLDING_QTY IS '保有数量';

-- --------------------------------------------------------------------------
--  取引明細 (Trade detail) — N:1 → M_ACCOUNT, N:1 → M_PRODUCT
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_T_TRADE START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE T_TRADE (
    TRADE_ID           NUMBER(14)     NOT NULL,
    ACCOUNT_ID         NUMBER(12)     NOT NULL,
    PRODUCT_ID         NUMBER(8)      NOT NULL,
    TRADE_TYPE_CD      CHAR(1)        NOT NULL,
    TRADE_QTY          NUMBER(12)     NOT NULL,
    TRADE_PRICE        NUMBER(15,4)   NOT NULL,
    TRADE_DT           DATE           NOT NULL,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT PK_T_TRADE          PRIMARY KEY (TRADE_ID),
    CONSTRAINT CK_T_TRADE_TYPE     CHECK (TRADE_TYPE_CD IN ('B', 'S')),
    CONSTRAINT FK_T_TRADE_ACCOUNT  FOREIGN KEY (ACCOUNT_ID) REFERENCES M_ACCOUNT (ACCOUNT_ID),
    CONSTRAINT FK_T_TRADE_PRODUCT  FOREIGN KEY (PRODUCT_ID) REFERENCES M_PRODUCT (PRODUCT_ID)
);

CREATE INDEX IX_T_TRADE_ACCOUNT_DT ON T_TRADE (ACCOUNT_ID, TRADE_DT);

COMMENT ON TABLE  T_TRADE                IS '取引明細';
COMMENT ON COLUMN T_TRADE.TRADE_TYPE_CD  IS '取引種別 B=買付 / S=売却';
COMMENT ON COLUMN T_TRADE.TRADE_QTY      IS '取引数量';
COMMENT ON COLUMN T_TRADE.TRADE_PRICE    IS '約定単価';
