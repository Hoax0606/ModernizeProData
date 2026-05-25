-- Load TO-BE sample data into the schema created by 01_schema.sql.
-- Mounted at /docker-entrypoint-initdb.d/02_load_sample.sql; runs after the
-- DDL on first container init.
--
-- CSVs are mounted at /sample/ (per stage, via docker compose bind).
-- UTF-8 with BOM — explicit column lists discard the BOM-on-header
-- cleanly. Same content across all four stages; only the mounted
-- /sample/ directory differs.

\set ON_ERROR_STOP true

SET search_path = securities, public;

\copy securities.customer (customer_id, customer_code, customer_name, customer_name_kana, birth_date, gender, email, phone, created_at, updated_at) FROM '/sample/customer.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.product (product_id, product_code, product_name, product_kind, unit_price, currency_code, created_at) FROM '/sample/product.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.branch (branch_id, branch_code, branch_name, parent_branch_id, address, opened_date, is_active, created_at) FROM '/sample/branch.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.employee (employee_id, employee_code, employee_name, branch_id, manager_id, role, email, hired_date, is_active, created_at) FROM '/sample/employee.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.account (account_id, customer_id, branch_id, account_no, account_kind, balance, opened_date, status, created_at, updated_at) FROM '/sample/account.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.account_product (account_id, product_id, holding_qty, start_date, end_date, created_at) FROM '/sample/account_product.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.trade (trade_id, account_id, product_id, trade_type, trade_qty, trade_price, trade_date, created_at) FROM '/sample/trade.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.market_quote (quote_id, product_id, quote_ts, source, payload) FROM '/sample/market_quote.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy securities.settlement (trade_id, settlement_date, account_id, settlement_amount, fee, status, settled_at, created_at) FROM '/sample/settlement.csv' WITH (FORMAT csv, HEADER true, NULL '');

-- ---------------------------------------------------------------------------
-- Auto sequence reset — advance every IDENTITY sequence past the seeded
-- rows so subsequent INSERTs don't collide. Self-maintaining as columns
-- get added (no hand-edited setval list to drift).
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'securities'
      AND a.attidentity IN ('a','d')
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%L, %L), COALESCE((SELECT MAX(%I) FROM %I.%I), 1))',
      r.schema_name || '.' || r.table_name,
      r.column_name,
      r.column_name,
      r.schema_name,
      r.table_name
    );
  END LOOP;
END $$;
