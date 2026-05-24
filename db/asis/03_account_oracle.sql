-- ==========================================================================
--  Project: account (口座・保有関係)
--  AS-IS Oracle. 依存: 01_master (M_CUSTOMER, M_PRODUCT), 02_organization (M_BRANCH)
-- ==========================================================================

-- --------------------------------------------------------------------------
--  口座マスタ (Account master) — 顧客 1:N 口座, 営業店 N:1
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_M_ACCOUNT START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE M_ACCOUNT (
    ACCOUNT_ID         NUMBER(12)     NOT NULL,
    CUSTOMER_ID        NUMBER(10)     NOT NULL,
    BRANCH_ID          NUMBER(8)      NOT NULL,
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
    CONSTRAINT FK_M_ACCOUNT_CUST   FOREIGN KEY (CUSTOMER_ID) REFERENCES M_CUSTOMER (CUSTOMER_ID),
    CONSTRAINT FK_M_ACCOUNT_BRANCH FOREIGN KEY (BRANCH_ID)   REFERENCES M_BRANCH (BRANCH_ID)
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
