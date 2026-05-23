"""
ModernizeProData — Mapping Definition 템플릿 생성기 (CSV + YAML).

출력 위치:
  - ModernizeProData/frontend/public/templates/mapping_definition_template.csv
  - ModernizeProData/frontend/public/templates/mapping_definition_template.yaml
  - <USER_SAMPLES>/mapping_definition_sample.csv
  - <USER_SAMPLES>/mapping_definition_sample.yaml
  (USER_SAMPLES = C:/Users/KS情報システム株式会社/Desktop/JIN/ModernizeProData/samples)

CSV / YAML 모두 같은 행 집합. AS-IS Oracle → TO-BE PostgreSQL 시나리오와
samples/ddl/ 더미 DDL 에 대응.
"""
import csv
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(
    HERE, "..",
    "ModernizeProData", "frontend", "public", "templates",
)
USER_SAMPLES_DIR = r"C:/Users/KS情報システム株式会社/Desktop/JIN/ModernizeProData/samples"

os.makedirs(PUBLIC_DIR, exist_ok=True)
os.makedirs(USER_SAMPLES_DIR, exist_ok=True)

# ── 컬럼 정의 ──────────────────────────────────────────────
HEADERS = [
    "asis_table",
    "asis_column",
    "asis_type",
    "tobe_table",
    "tobe_column",
    "tobe_type",
    "strategy",      # expression / null / default / skip
    "rule_sql",
    "default_value",
    "notes",
]

# ── 샘플 행 (samples/ddl/asis_oracle.sql ↔ tobe_postgres.sql 매핑) ─────
ROWS = [
    # M_EMPLOYEE → employees
    ["HR.M_EMPLOYEE", "EMP_ID",       "CHAR(8)",        "public.employees", "employee_id",   "UUID",          "expression",
        "uuid_generate_v5('hr-emp'::uuid, em.EMP_ID)", "", "CHAR(8) → UUID v5 채번."],
    ["HR.M_EMPLOYEE", "EMP_ID",       "CHAR(8)",        "public.employees", "emp_no",        "CHAR(8)",       "expression",
        "em.EMP_ID", "", "원본 사번 보존 (UNIQUE)."],
    ["HR.M_EMPLOYEE", "EMP_NM",       "VARCHAR2(60)",   "public.employees", "full_name",     "VARCHAR(120)",  "expression",
        "TRIM(em.EMP_NM)", "", "길이 확장 + TRIM."],
    ["HR.M_EMPLOYEE", "EMP_NM_KANA",  "VARCHAR2(120)",  "public.employees", "full_name_kana","VARCHAR(120)",  "expression",
        "em.EMP_NM_KANA", "", "passthrough."],
    ["HR.M_EMPLOYEE", "HIRE_YMD",     "CHAR(8)",        "public.employees", "hire_date",     "DATE",          "expression",
        "TO_DATE(em.HIRE_YMD, 'YYYYMMDD')", "", "YYYYMMDD → DATE."],
    ["HR.M_EMPLOYEE", "BIRTH_YMD",    "CHAR(8)",        "public.employees", "birth_date",    "DATE",          "expression",
        "TO_DATE(em.BIRTH_YMD, 'YYYYMMDD')", "", "nullable YYYYMMDD → DATE."],
    ["HR.M_EMPLOYEE", "DEPT_CD",      "CHAR(4)",        "public.employees", "department_id", "INTEGER",       "expression",
        "(SELECT d.department_id FROM public.departments d WHERE d.department_code = em.DEPT_CD)", "",
        "LOOKUP: DEPT_CD → department_id."],
    ["HR.M_EMPLOYEE", "POSITION_CD",  "CHAR(3)",        "public.employees", "position_code", "CHAR(3)",       "expression",
        "em.POSITION_CD", "", "passthrough."],
    ["HR.M_EMPLOYEE", "GENDER_CD",    "CHAR(1)",        "public.employees", "gender",        "CHAR(1)",       "expression",
        "em.GENDER_CD", "", "passthrough."],
    ["HR.M_EMPLOYEE", "EMAIL",        "VARCHAR2(64)",   "public.employees", "email",         "VARCHAR(255)",  "expression",
        "em.EMAIL", "", "길이 확장만."],
    ["HR.M_EMPLOYEE", "SALARY",       "NUMBER(11,2)",   "public.employees", "salary",        "NUMERIC(11,2)", "expression",
        "em.SALARY", "", "NUMBER → NUMERIC."],
    ["HR.M_EMPLOYEE", "ENTRY_TS",     "CHAR(14)",       "public.employees", "created_at",    "TIMESTAMP",     "expression",
        "TO_TIMESTAMP(em.ENTRY_TS, 'YYYYMMDDHH24MISS')", "", "CHAR(14) → TIMESTAMP."],
    ["HR.M_EMPLOYEE", "STATUS_CD",    "CHAR(1)",        "public.employees", "status",        "VARCHAR(16)",   "expression",
        "CASE em.STATUS_CD WHEN 'A' THEN 'active' WHEN 'R' THEN 'retired' WHEN 'L' THEN 'leave' END",
        "", "값 매핑 (A→active, R→retired, L→leave)."],
    ["HR.M_EMPLOYEE", "PHONE",        "VARCHAR2(20)",   "public.employees", "phone",         "VARCHAR(32)",   "expression",
        "em.PHONE", "", "길이 확장."],
    ["HR.M_EMPLOYEE", "UPDATE_TS",    "CHAR(14)",       "public.employees", "updated_at",    "TIMESTAMP",     "expression",
        "TO_TIMESTAMP(em.UPDATE_TS, 'YYYYMMDDHH24MISS')", "", ""],
    ["HR.M_EMPLOYEE", "OBSOLETE_FLAG","CHAR(1)",        "",                  "",              "",              "skip",
        "", "", "TO-BE 에서 폐기. status='retired' 로 충분."],
    ["",              "",             "",               "public.employees", "tenant_id",     "INTEGER",       "default",
        "", "1", "신규: 멀티 테넌트 시드값."],
    ["",              "",             "",               "public.employees", "mfa_enabled",   "BOOLEAN",       "default",
        "", "false", "신규: MFA 기본 비활성."],
    ["",              "",             "",               "public.employees", "is_deleted",    "BOOLEAN",       "default",
        "", "false", "신규: 논리 삭제 플래그."],
    ["",              "",             "",               "public.employees", "version",       "INTEGER",       "default",
        "", "1", "신규: 낙관적 락 초기값."],

    # M_DEPARTMENT → departments
    ["HR.M_DEPARTMENT", "DEPT_CD",   "CHAR(4)",       "public.departments", "department_code","CHAR(4)",     "expression",
        "de.DEPT_CD", "", "원본 코드 보존 (UNIQUE)."],
    ["HR.M_DEPARTMENT", "DEPT_NM",   "VARCHAR2(80)",  "public.departments", "department_name","VARCHAR(120)","expression",
        "TRIM(de.DEPT_NM)", "", "길이 확장 + TRIM."],
    ["HR.M_DEPARTMENT", "PARENT_CD", "CHAR(4)",       "public.departments", "parent_id",      "INTEGER",     "expression",
        "(SELECT d2.department_id FROM public.departments d2 WHERE d2.department_code = de.PARENT_CD)",
        "", "LOOKUP self-reference."],
    ["HR.M_DEPARTMENT", "LEVEL_NO",  "NUMBER(2)",     "public.departments", "level_no",       "SMALLINT",    "expression",
        "de.LEVEL_NO", "", "NUMBER(2) → SMALLINT."],
    ["HR.M_DEPARTMENT", "ENTRY_TS",  "CHAR(14)",      "public.departments", "created_at",     "TIMESTAMP",   "expression",
        "TO_TIMESTAMP(de.ENTRY_TS, 'YYYYMMDDHH24MISS')", "", ""],
    ["HR.M_DEPARTMENT", "UPDATE_TS", "CHAR(14)",      "public.departments", "updated_at",     "TIMESTAMP",   "expression",
        "TO_TIMESTAMP(de.UPDATE_TS, 'YYYYMMDDHH24MISS')", "", ""],
    ["",                "",          "",              "public.departments", "department_id",  "INTEGER",     "expression",
        "NEXTVAL('departments_seq')", "", "BIGSERIAL 채번 (실 운영은 BIGSERIAL identity)."],
    ["",                "",          "",              "public.departments", "is_deleted",     "BOOLEAN",     "default",
        "", "false", "신규: 논리 삭제."],

    # T_CONTACT_LOG → contact_log + contact_attachment (1→2 분할)
    ["CRM.T_CONTACT_LOG", "CONTACT_ID",   "NUMBER(12)",   "public.contact_log", "contact_id",   "BIGINT",      "expression",
        "cl.CONTACT_ID", "", "NUMBER(12) → BIGINT."],
    ["CRM.T_CONTACT_LOG", "EMP_ID",       "CHAR(8)",      "public.contact_log", "employee_id",  "UUID",        "expression",
        "(SELECT e.employee_id FROM public.employees e WHERE e.emp_no = cl.EMP_ID)",
        "", "LOOKUP: EMP_ID → employees.employee_id."],
    ["CRM.T_CONTACT_LOG", "CONTACT_DT",   "CHAR(14)",     "public.contact_log", "contact_at",   "TIMESTAMP",   "expression",
        "TO_TIMESTAMP(cl.CONTACT_DT, 'YYYYMMDDHH24MISS')", "", ""],
    ["CRM.T_CONTACT_LOG", "KIND_CD",      "CHAR(2)",      "public.contact_log", "kind",         "VARCHAR(16)", "expression",
        "CASE cl.KIND_CD WHEN 'CL' THEN 'CALL' WHEN 'EM' THEN 'EMAIL' WHEN 'VS' THEN 'VISIT' END",
        "", "코드 → 풀네임 매핑."],
    ["CRM.T_CONTACT_LOG", "MEMO",         "CLOB",         "public.contact_log", "memo",         "TEXT",        "expression",
        "cl.MEMO", "", "CLOB → TEXT."],
    ["CRM.T_CONTACT_LOG", "ATTACHMENT_NM","VARCHAR2(200)","public.contact_log", "has_attachment","BOOLEAN",    "expression",
        "(cl.ATTACHMENT_NM IS NOT NULL)", "", "boolean derive."],
    ["CRM.T_CONTACT_LOG", "ENTRY_TS",     "CHAR(14)",     "public.contact_log", "created_at",   "TIMESTAMP",   "expression",
        "TO_TIMESTAMP(cl.ENTRY_TS, 'YYYYMMDDHH24MISS')", "", ""],

    # split target 2: contact_attachment
    ["CRM.T_CONTACT_LOG", "CONTACT_ID",    "NUMBER(12)",    "public.contact_attachment", "contact_id",  "BIGINT",      "expression",
        "cl.CONTACT_ID", "", "분할 FK (ATTACHMENT_NM IS NOT NULL 행만)."],
    ["CRM.T_CONTACT_LOG", "ATTACHMENT_NM", "VARCHAR2(200)", "public.contact_attachment", "filename",    "VARCHAR(200)","expression",
        "cl.ATTACHMENT_NM", "", "분할 대상."],
    ["CRM.T_CONTACT_LOG", "ATTACHMENT_BYTES","BLOB",        "public.contact_attachment", "content",     "BYTEA",       "expression",
        "cl.ATTACHMENT_BYTES", "", "BLOB → BYTEA."],
    ["CRM.T_CONTACT_LOG", "ENTRY_TS",      "CHAR(14)",      "public.contact_attachment", "created_at",  "TIMESTAMP",   "expression",
        "TO_TIMESTAMP(cl.ENTRY_TS, 'YYYYMMDDHH24MISS')", "", ""],
    ["",                  "",              "",              "public.contact_attachment", "attachment_id","BIGSERIAL",  "expression",
        "NEXTVAL('contact_attachment_seq')", "", "BIGSERIAL 채번."],
]


# ── CSV writer ───────────────────────────────────────────────
def write_csv(path: str):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(HEADERS)
    for r in ROWS:
        w.writerow(r)
    # utf-8-sig: Excel 에서 한글이 깨지지 않도록 BOM 포함.
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(buf.getvalue())


# ── YAML writer (간단한 사람-친화적 포맷; PyYAML 없이 직접) ──────────────
def yaml_escape(v: str) -> str:
    if v is None:
        return '""'
    s = str(v)
    if s == '':
        return '""'
    # double-quote 안에 들어가도 안전하게: " 와 \ 만 escape.
    needs_quote = any(c in s for c in [':', '#', "'", '"', '\n', '{', '}', '[', ']', ',', '&', '*', '!', '|', '>', '%', '@', '`'])
    needs_quote = needs_quote or s != s.strip()
    if not needs_quote:
        return s
    escaped = s.replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'


def write_yaml(path: str):
    lines = []
    lines.append("# ModernizeProData — Mapping Definition (YAML)")
    lines.append("# CSV 와 동일한 데이터. unmapped 행만 자동 채워지고 이미 매핑된 행은 덮어쓰지 않음.")
    lines.append("")
    lines.append("version: 1")
    lines.append("mappings:")
    for r in ROWS:
        rec = dict(zip(HEADERS, r))
        lines.append("  - asis_table:    " + yaml_escape(rec['asis_table']))
        lines.append("    asis_column:   " + yaml_escape(rec['asis_column']))
        lines.append("    asis_type:     " + yaml_escape(rec['asis_type']))
        lines.append("    tobe_table:    " + yaml_escape(rec['tobe_table']))
        lines.append("    tobe_column:   " + yaml_escape(rec['tobe_column']))
        lines.append("    tobe_type:     " + yaml_escape(rec['tobe_type']))
        lines.append("    strategy:      " + yaml_escape(rec['strategy']))
        lines.append("    rule_sql:      " + yaml_escape(rec['rule_sql']))
        lines.append("    default_value: " + yaml_escape(rec['default_value']))
        lines.append("    notes:         " + yaml_escape(rec['notes']))
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


# ── 4 곳에 출력 ─────────────────────────────────────────────
outs = [
    (os.path.join(PUBLIC_DIR, "mapping_definition_template.csv"),  'csv'),
    (os.path.join(PUBLIC_DIR, "mapping_definition_template.yaml"), 'yaml'),
    (os.path.join(USER_SAMPLES_DIR, "mapping_definition_sample.csv"),  'csv'),
    (os.path.join(USER_SAMPLES_DIR, "mapping_definition_sample.yaml"), 'yaml'),
]
for path, fmt in outs:
    if fmt == 'csv':
        write_csv(path)
    else:
        write_yaml(path)
    print(f"Generated: {path}  ({os.path.getsize(path):,} bytes)")

# 기존 xlsx 템플릿은 더 이상 쓰지 않으므로 정리 (있으면 삭제).
old_xlsx = os.path.join(PUBLIC_DIR, "mapping_definition_template.xlsx")
if os.path.exists(old_xlsx):
    os.remove(old_xlsx)
    print(f"Removed obsolete: {old_xlsx}")
