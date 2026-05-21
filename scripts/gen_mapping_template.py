"""
ModernizeProData — Mapping Definition 템플릿 xlsx 생성기.

출력: ModernizeProData/frontend/public/templates/mapping_definition_template.xlsx

우리 툴의 데이터 모델(MappingRow / RowEdit)에 맞춰진 시트 구성:
  00_Overview        — 사용법
  01_TableMapping    — 테이블 단위 binding (Inspector 의 Table binding 패널과 대응)
  02_ColumnMapping   — 컬럼 단위 매핑 (메인 시트) — Strategy / Rule SQL
  03_Strategies      — strategy 코드 사전
  04_SkipColumns     — AS-IS 폐기 컬럼 (rule=skip)
  05_AddedColumns    — TO-BE 신규 컬럼 (rule=added, DDL DEFAULT 사용)
"""
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(
    HERE, "..",
    "ModernizeProData", "frontend", "public", "templates",
    "mapping_definition_template.xlsx",
)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# ── 스타일 헬퍼 ─────────────────────────────────────────
TITLE_FONT  = Font(bold=True, size=13, color='1F2937')
HEADER_FONT = Font(bold=True, size=11, color='FFFFFF')
HEADER_FILL = PatternFill('solid', fgColor='01589C')
SECTION_FONT = Font(bold=True, size=11, color='374151')
SECTION_FILL = PatternFill('solid', fgColor='E5E7EB')
SAMPLE_FILL  = PatternFill('solid', fgColor='F0F9FF')
EXAMPLE_FONT = Font(italic=True, color='6B7280', size=10)
BORDER = Border(
    left=Side(style='thin', color='D1D5DB'),
    right=Side(style='thin', color='D1D5DB'),
    top=Side(style='thin', color='D1D5DB'),
    bottom=Side(style='thin', color='D1D5DB'),
)
WRAP = Alignment(wrap_text=True, vertical='top')


def set_widths(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


def write_header(ws, row, headers):
    for j, h in enumerate(headers, 1):
        c = ws.cell(row=row, column=j, value=h)
        c.font = HEADER_FONT
        c.fill = HEADER_FILL
        c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        c.border = BORDER
    ws.row_dimensions[row].height = 32


def write_row(ws, row, values, *, sample=False):
    for j, v in enumerate(values, 1):
        c = ws.cell(row=row, column=j, value=v)
        c.alignment = WRAP
        c.border = BORDER
        if sample:
            c.fill = SAMPLE_FILL
            c.font = EXAMPLE_FONT


wb = Workbook()

# ── 00_Overview ────────────────────────────────────────
ws = wb.active
ws.title = '00_Overview'
ws['A1'] = 'Mapping Definition Template'
ws['A1'].font = Font(bold=True, size=16, color='01589C')
ws.merge_cells('A1:E1')

ws['A3'] = 'ModernizeProData — 매핑 정의서 임포트 템플릿'
ws['A4'] = 'AS-IS → TO-BE 컬럼 매핑을 일괄로 정의하기 위한 양식입니다.'
ws['A5'] = '도구의 Auto-map unmapped → 본 파일을 업로드하면 unmapped 행만 자동 채워집니다.'
for r in (3, 4, 5):
    ws.cell(row=r, column=1).alignment = WRAP

ws['A7'] = '시트 구성'
ws['A7'].font = SECTION_FONT
ws['A7'].fill = SECTION_FILL
ws.merge_cells('A7:C7')

sheet_index = [
    ('01_TableMapping',  '테이블 단위 binding 정의. TO-BE 테이블이 어떤 AS-IS 테이블에서 데이터를 받는지 (단일 / JOIN / UNION).'),
    ('02_ColumnMapping', '컬럼 단위 매핑 (메인 시트). AS-IS 컬럼 → TO-BE 컬럼 + Strategy + Rule SQL.'),
    ('03_Strategies',    'Strategy 코드 사전. expression / null / default / skip.'),
    ('04_SkipColumns',   'AS-IS 에만 존재하고 TO-BE 로 이행하지 않는 컬럼 (폐기 목록).'),
    ('05_AddedColumns',  'TO-BE 에만 존재하는 신규 컬럼 (DDL DEFAULT 사용).'),
]
write_header(ws, 8, ['#', '시트명', '내용'])
for i, (n, desc) in enumerate(sheet_index, 1):
    write_row(ws, 8 + i, [i, n, desc])

ws['A15'] = '필수 vs 선택'
ws['A15'].font = SECTION_FONT
ws['A15'].fill = SECTION_FILL
ws.merge_cells('A15:C15')

write_header(ws, 16, ['항목', '필수 시트', '비고'])
write_row(ws, 17, ['최소 매핑 정의', '02_ColumnMapping', '이 시트만 채워도 동작합니다.'])
write_row(ws, 18, ['Binding 함께 정의', '01_TableMapping + 02_ColumnMapping', 'JOIN/UNION 자동 구성.'])
write_row(ws, 19, ['Skip/Added 포함', '04 / 05 추가', 'AS-IS 폐기 컬럼과 TO-BE 신규 컬럼을 함께.'])

ws['A21'] = '주의'
ws['A21'].font = SECTION_FONT
ws['A21'].fill = SECTION_FILL
ws.merge_cells('A21:C21')

notes = [
    '• 이미 매핑된 (unmapped 아닌) TO-BE 컬럼은 덮어쓰지 않습니다.',
    '• AS-IS 테이블/컬럼 이름은 DDL 임포트된 물리명과 정확히 일치해야 합니다 (대소문자 포함).',
    '• Rule SQL 은 TO-BE DB 의 SQL dialect 에 맞게 작성하세요 (CAST / TO_DATE / COALESCE 등).',
    '• 매핑 정의서를 다른 사람과 공유할 때는 회사명/시스템명을 00_Overview 에 명기하는 것을 권장.',
]
for i, t in enumerate(notes):
    c = ws.cell(row=22 + i, column=1, value=t)
    c.alignment = WRAP
    ws.merge_cells(start_row=22 + i, start_column=1, end_row=22 + i, end_column=5)

set_widths(ws, [16, 32, 60, 12, 12])

# ── 01_TableMapping ───────────────────────────────────
ws = wb.create_sheet('01_TableMapping')
ws['A1'] = '테이블 매핑 (binding)'
ws['A1'].font = TITLE_FONT
ws.merge_cells('A1:I1')

headers = ['#', 'TO-BE Schema', 'TO-BE Table', 'AS-IS Schema', 'AS-IS Table', 'Alias', 'Role', 'Join ON', 'Notes']
write_header(ws, 3, headers)
write_row(ws, 4, [1, 'public', 'employees',    'HR',  'EMPLOYEE_MASTER',    'em', 'primary', '',                                                  '단일 source. role=primary.'], sample=True)
write_row(ws, 5, [2, 'public', 'user_view',    'HR',  'EMPLOYEE_MASTER',    'em', 'primary', '',                                                  'JOIN — primary.'], sample=True)
write_row(ws, 6, [3, 'public', 'user_view',    'CRM', 'CUST_PROFILE_OLD',   'cu', 'join',    'em.user_id = cu.user_id',                          'JOIN — left join 대상.'], sample=True)
write_row(ws, 7, [4, 'public', 'order_history','HR',  'ORDER_2023',         'o1', 'union',   '',                                                  'UNION — 같은 schema 의 분리된 source.'], sample=True)
write_row(ws, 8, [5, 'public', 'order_history','HR',  'ORDER_2024',         'o2', 'union',   '',                                                  'UNION — 두 번째 part.'], sample=True)
set_widths(ws, [5, 14, 22, 14, 22, 8, 11, 32, 36])

# ── 02_ColumnMapping ──────────────────────────────────
ws = wb.create_sheet('02_ColumnMapping')
ws['A1'] = '컬럼 매핑 (메인)'
ws['A1'].font = TITLE_FONT
ws.merge_cells('A1:N1')

# 두 줄 헤더: 1행은 그룹 라벨, 2행은 세부 컬럼.
ws['B3'] = 'AS-IS';  ws.merge_cells('B3:E3')
ws['F3'] = 'TO-BE';  ws.merge_cells('F3:I3')
ws['J3'] = 'MAPPING'; ws.merge_cells('J3:N3')
for cell_ref in ('B3', 'F3', 'J3'):
    c = ws[cell_ref]
    c.font = HEADER_FONT
    c.fill = HEADER_FILL
    c.alignment = Alignment(horizontal='center', vertical='center')
    c.border = BORDER

headers2 = [
    '#',
    'Table',     'Column',     'Type',          'PK/Null',
    'Table',     'Column',     'Type',          'PK/Null',
    'Strategy',  'Source(s)',  'Rule SQL',      'Default',  'Notes',
]
write_header(ws, 4, headers2)
ws.row_dimensions[4].height = 30

# 샘플 데이터
samples = [
    # auto / passthrough (Strategy=expression, Rule SQL=src col 그대로 또는 비워두면 자동)
    [1, 'EMPLOYEE_MASTER', 'POSITION_CD', 'CHAR(3)',         '',         'employees',  'position_code', 'CHAR(3)',         '',          'expression', 'em.POSITION_CD',  'em.POSITION_CD',                                  '', '동일 type → passthrough.'],
    # type cast (Strategy=expression, Rule SQL=CAST)
    [2, 'EMPLOYEE_MASTER', 'EMP_ID',      'CHAR(8)',         'PK,NOT NULL', 'employees', 'employee_id',   'UUID',           'PK,NOT NULL', 'expression', 'em.EMP_ID',       "uuid_generate_v5('hr-emp', em.EMP_ID)",          '', 'CHAR → UUID v5 자동 생성.'],
    # date parse
    [3, 'EMPLOYEE_MASTER', 'HIRE_YMD',    'CHAR(8) YYYYMMDD','NOT NULL', 'employees',  'hire_date',     'DATE',            'NOT NULL',   'expression', 'em.HIRE_YMD',     "TO_DATE(em.HIRE_YMD, 'YYYYMMDD')",                '', '날짜 파싱.'],
    # concat / multi source
    [4, 'EMPLOYEE_MASTER', 'ENTRY_YMD',   'CHAR(8) YYYYMMDD', 'NOT NULL', 'employees', 'created_at',    'TIMESTAMP',       'NOT NULL',   'expression', 'em.ENTRY_YMD + em.ENTRY_HMS', "TO_TIMESTAMP(em.ENTRY_YMD || em.ENTRY_HMS, 'YYYYMMDDHH24MISS')", '', 'CONCAT.'],
    # null strategy
    [5, '',                 '',           '',                 '',         'employees',  'manager_id',    'UUID',            '',           'null',        '',                '',                                                '', 'AS-IS 없음. 항상 NULL.'],
    # default strategy
    [6, '',                 '',           '',                 '',         'employees',  'tenant_id',     'INTEGER',         'NOT NULL',   'default',     '',                '',                                                '1', 'DDL DEFAULT 사용.'],
    # skip - AS-IS 만 있고 TO-BE 없음 → 04_SkipColumns 에서 다루지만 여기서도 row 가능
    [7, 'EMPLOYEE_MASTER', 'OBSOLETE_FLAG','CHAR(1)',         '',         '',           '',              '',                '',           'skip',        '',                '',                                                '', 'TO-BE 로 이행 안 함.'],
]
for i, s in enumerate(samples, 1):
    write_row(ws, 4 + i, s, sample=True)

set_widths(ws, [5, 18, 18, 18, 12, 18, 18, 18, 12, 14, 22, 40, 12, 32])

# ── 03_Strategies ─────────────────────────────────────
ws = wb.create_sheet('03_Strategies')
ws['A1'] = 'Strategy 코드 사전'
ws['A1'].font = TITLE_FONT
ws.merge_cells('A1:C1')

write_header(ws, 3, ['Strategy', '설명', 'Rule SQL 작성법'])
strategies = [
    ('expression', '사용자 정의 SQL expression. AS-IS source 컬럼을 변환해서 TO-BE 컬럼에 채움.',
        "예: TRIM(col) · CAST(col AS UUID) · TO_DATE(col, 'YYYYMMDD') · UDF 호출."),
    ('null',       'AS-IS source 무관. 모든 행에 NULL 채움. (TO-BE 컬럼이 NULL 허용이어야 함.)',
        '비워둠.'),
    ('default',    'AS-IS source 무관. TO-BE 컬럼의 DDL DEFAULT 값 또는 명시한 상수를 채움.',
        '비워두면 DDL DEFAULT 자동 사용. 상수 지정 시 Default 열에 값 입력.'),
    ('skip',       'AS-IS 컬럼을 TO-BE 로 이행하지 않음. 단순 폐기.',
        '비워둠. TO-BE 컬럼 열은 비워둘 것.'),
]
for i, (k, d, e) in enumerate(strategies, 1):
    write_row(ws, 3 + i, [k, d, e])
set_widths(ws, [14, 50, 50])

# ── 04_SkipColumns ────────────────────────────────────
ws = wb.create_sheet('04_SkipColumns')
ws['A1'] = '폐기 컬럼 (AS-IS only)'
ws['A1'].font = TITLE_FONT
ws.merge_cells('A1:E1')

write_header(ws, 3, ['#', 'AS-IS Table', 'AS-IS Column', 'Reason', 'Notes'])
skip_samples = [
    [1, 'EMPLOYEE_MASTER', 'OBSOLETE_FLAG', '사용 안 함', '신 시스템에서는 status_code 로 대체.'],
    [2, 'CRM.CUST_PROFILE_OLD', 'SALES_REP_ID', '외부 시스템 이관',  '영업 시스템 별도 분리.'],
]
for i, s in enumerate(skip_samples, 1):
    write_row(ws, 3 + i, s, sample=True)
set_widths(ws, [5, 24, 22, 28, 40])

# ── 05_AddedColumns ───────────────────────────────────
ws = wb.create_sheet('05_AddedColumns')
ws['A1'] = '신규 컬럼 (TO-BE only)'
ws['A1'].font = TITLE_FONT
ws.merge_cells('A1:F1')

write_header(ws, 3, ['#', 'TO-BE Table', 'TO-BE Column', 'Type', 'Default', 'Notes'])
added_samples = [
    [1, 'employees', 'tenant_id',     'INTEGER',  '1',     'AS-IS 단일 tenant. 신규 컬럼에 기본값 1.'],
    [2, 'employees', 'mfa_enabled',   'BOOLEAN',  'false', 'MFA 기본 비활성.'],
    [3, 'employees', 'is_deleted',    'BOOLEAN',  'false', '논리 삭제 플래그 — 신 시스템에서 시작.'],
]
for i, s in enumerate(added_samples, 1):
    write_row(ws, 3 + i, s, sample=True)
set_widths(ws, [5, 22, 22, 18, 16, 40])

wb.save(OUT)
print(f'Generated: {OUT}')
print(f'Size: {os.path.getsize(OUT):,} bytes')
