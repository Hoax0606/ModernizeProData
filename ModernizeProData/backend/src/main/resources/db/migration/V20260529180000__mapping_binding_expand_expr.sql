-- mapping_table_bindings.expand_expr
--
-- Row 1:N 펼침 변환용 free SQL fragment. NULL / blank 이면 펼침 없음 (1:1 변환).
-- 값 있음 = buildSql 가 sources/JOIN 뒤, WHERE 앞에 그대로 인젝션.
-- 예: "CROSS JOIN LATERAL (VALUES ('phone', t.PHONE), ('email', t.EMAIL)) AS u(channel, value)"
-- 한 source row 가 여러 target row 로 분해됨.

ALTER TABLE mapping_table_bindings
    ADD COLUMN expand_expr TEXT;
