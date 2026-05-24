-- ==========================================================================
--  Project: market (気配値スナップショット)
--  AS-IS Oracle. 依存: 01_master (M_PRODUCT)
-- ==========================================================================

CREATE SEQUENCE SEQ_T_MARKET_QUOTE START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE T_MARKET_QUOTE (
    QUOTE_ID           NUMBER(14)     NOT NULL,
    PRODUCT_ID         NUMBER(8)      NOT NULL,
    QUOTE_TS           TIMESTAMP      NOT NULL,
    BID_PRICE          NUMBER(15,4),
    ASK_PRICE          NUMBER(15,4),
    VOLUME             NUMBER(18),
    SOURCE_CD          VARCHAR2(20)   DEFAULT 'EXCHANGE' NOT NULL,
    PAYLOAD_JSON       CLOB,
    CONSTRAINT PK_T_MARKET_QUOTE   PRIMARY KEY (QUOTE_ID),
    CONSTRAINT FK_T_MQ_PRODUCT     FOREIGN KEY (PRODUCT_ID) REFERENCES M_PRODUCT (PRODUCT_ID)
);

CREATE INDEX IX_T_MQ_PRODUCT_TS ON T_MARKET_QUOTE (PRODUCT_ID, QUOTE_TS DESC);

COMMENT ON TABLE  T_MARKET_QUOTE              IS '気配値スナップショット';
COMMENT ON COLUMN T_MARKET_QUOTE.PAYLOAD_JSON IS 'bid/ask/volume 等の可変フィールド (JSON 文字列)';
