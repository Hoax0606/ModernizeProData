-- ==========================================================================
--  Project: master (顧客・商品マスタ)
--  AS-IS Oracle. 他モジュール (organization / account / trade / market /
--  settlement) はこのモジュールの M_CUSTOMER / M_PRODUCT を参照する。
--  Project単位として最初に取り込む。
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
