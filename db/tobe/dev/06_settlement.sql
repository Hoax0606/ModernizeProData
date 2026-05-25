-- TO-BE schema module: settlement / stage: dev
-- ==========================================================================
--  Project: settlement (決済明細)
--  依存: 03_account (account), 04_trade (trade)
-- ==========================================================================

SET search_path = securities, public;

-- Composite PK + composite FK + TIMESTAMPTZ NULL
CREATE TABLE securities.settlement (
    trade_id             BIGINT        NOT NULL,
    settlement_date      DATE          NOT NULL,
    account_id           BIGINT        NOT NULL,
    settlement_amount    NUMERIC(18,2) NOT NULL,
    fee                  NUMERIC(12,2) NOT NULL DEFAULT 0,
    status               CHAR(1)       NOT NULL CHECK (status IN ('P', 'S', 'F')),
    settled_at           TIMESTAMPTZ,
    created_at           TIMESTAMP     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (trade_id, settlement_date),
    CONSTRAINT fk_settlement_trade
      FOREIGN KEY (trade_id)   REFERENCES securities.trade (trade_id),
    CONSTRAINT fk_settlement_account
      FOREIGN KEY (account_id) REFERENCES securities.account (account_id)
);

COMMENT ON TABLE  securities.settlement                   IS '決済明細';
COMMENT ON COLUMN securities.settlement.status            IS 'P=未決済 / S=決済済 / F=失敗';
COMMENT ON COLUMN securities.settlement.settled_at        IS '決済完了タイムスタンプ. NULL は未決済.';
COMMENT ON COLUMN securities.settlement.settlement_amount IS '決済額';
