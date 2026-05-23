-- Load stage-keyed sample data into the schema created by 01_schema.sql.
-- Mounted at /docker-entrypoint-initdb.d/02_load_sample.sql, runs after the
-- DDL on first container init.
--
-- CSVs are mounted at /sample/. UTF-8 with BOM (Excel-friendly) — we use
-- explicit column lists so the BOM on the first line is ignored as part
-- of the discarded header row, instead of contaminating the first column
-- name. Works on PG 14+.
--
-- Same content across all four stages — only the mounted /sample/
-- directory differs.

\set ON_ERROR_STOP true

\copy customer (customer_id, customer_code, customer_name, customer_name_kana, birth_date, gender, email, phone, created_at, updated_at) FROM '/sample/customer.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy product (product_id, product_code, product_name, product_kind, unit_price, currency_code, created_at) FROM '/sample/product.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy account (account_id, customer_id, account_no, account_kind, balance, opened_date, status, created_at, updated_at) FROM '/sample/account.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy account_product (account_id, product_id, holding_qty, start_date, end_date, created_at) FROM '/sample/account_product.csv' WITH (FORMAT csv, HEADER true, NULL '');
\copy trade (trade_id, account_id, product_id, trade_type, trade_qty, trade_price, trade_date, created_at) FROM '/sample/trade.csv' WITH (FORMAT csv, HEADER true, NULL '');

-- Advance IDENTITY sequences past the seeded rows so future INSERTs
-- (e.g. integration tests) don't collide with seeded primary keys.
SELECT setval(pg_get_serial_sequence('customer', 'customer_id'), COALESCE((SELECT MAX(customer_id) FROM customer), 1));
SELECT setval(pg_get_serial_sequence('product',  'product_id'),  COALESCE((SELECT MAX(product_id)  FROM product),  1));
SELECT setval(pg_get_serial_sequence('account',  'account_id'),  COALESCE((SELECT MAX(account_id)  FROM account),  1));
SELECT setval(pg_get_serial_sequence('trade',    'trade_id'),    COALESCE((SELECT MAX(trade_id)    FROM trade),    1));
