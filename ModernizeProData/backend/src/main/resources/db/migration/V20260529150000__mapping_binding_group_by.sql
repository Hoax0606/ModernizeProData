-- mapping_table_bindings.group_by_expr
--
-- Row N:1 집계 변환용 GROUP BY 절. NULL / 빈 값 = GROUP BY 없음 (기존 1:1 변환).
-- 값 있음 = buildSql 가 WHERE 뒤 LIMIT 앞에 "GROUP BY <expr>" 끼워넣음.
-- 예: "EXTRACT(MONTH FROM t.txn_date), t.account" — 일계 → 월계 집계.

ALTER TABLE mapping_table_bindings
    ADD COLUMN group_by_expr TEXT;
