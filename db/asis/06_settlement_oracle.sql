-- ==========================================================================
--  Project: settlement (決済明細)
--  AS-IS Oracle. 依存: 03_account (M_ACCOUNT), 04_trade (T_TRADE)
-- ==========================================================================

CREATE TABLE T_SETTLEMENT (
    TRADE_ID           NUMBER(14)     NOT NULL,
    SETTLEMENT_DT      DATE           NOT NULL,
    ACCOUNT_ID         NUMBER(12)     NOT NULL,
    SETTLEMENT_AMOUNT  NUMBER(18,2)   NOT NULL,
    FEE                NUMBER(12,2)   DEFAULT 0 NOT NULL,
    STATUS_CD          CHAR(1)        NOT NULL,
    SETTLED_TS         TIMESTAMP,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT PK_T_SETTLEMENT     PRIMARY KEY (TRADE_ID, SETTLEMENT_DT),
    CONSTRAINT CK_T_SETTLEMENT_ST  CHECK (STATUS_CD IN ('P', 'S', 'F')),
    CONSTRAINT FK_T_SETTLEMENT_TR  FOREIGN KEY (TRADE_ID)   REFERENCES T_TRADE (TRADE_ID),
    CONSTRAINT FK_T_SETTLEMENT_AC  FOREIGN KEY (ACCOUNT_ID) REFERENCES M_ACCOUNT (ACCOUNT_ID)
);

COMMENT ON TABLE  T_SETTLEMENT                   IS '決済明細';
COMMENT ON COLUMN T_SETTLEMENT.STATUS_CD         IS 'P=未決済 / S=決済済 / F=失敗';
COMMENT ON COLUMN T_SETTLEMENT.SETTLED_TS        IS '決済完了タイムスタンプ. NULL は未決済.';
COMMENT ON COLUMN T_SETTLEMENT.SETTLEMENT_AMOUNT IS '決済額';
