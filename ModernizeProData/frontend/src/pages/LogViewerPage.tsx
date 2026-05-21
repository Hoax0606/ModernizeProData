import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';

/**
 * Log viewer — 프로젝트 실행 로그 조회.
 *  - 좌측: 로그 라인 (time / level / stage / message)
 *  - 우측: 선택된 라인의 상세 + suggested action + context
 *  - 툴바: search · level filter · follow tail · wrap · export
 *
 * 백엔드 로그 수집 파이프라인이 들어오기 전까지는 합성 로그를 사용한다.
 * 실로그가 들어오면 useLogs() 자리만 교체하면 된다.
 */

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

interface LogLine {
  id: string;
  time: string;            // HH:mm:ss
  ms: string;              // .mmm
  level: LogLevel;
  stage: string;
  message: string;
  runId: string;
  date: string;            // yyyy-MM-dd
  suggestion?: string;     // ERROR 라인에만 채워짐
  actions?: { label: string; primary?: boolean }[];
}

/* 합성 로그 — 화면 디자인 검증용. 실제 데이터로 교체될 자리. */
function buildSyntheticLogs(projectId: string): LogLine[] {
  if (!projectId) return [];
  const seed = projectId.charCodeAt(0) % 7;
  const lines: Array<Omit<LogLine, 'id' | 'time' | 'ms' | 'runId' | 'date'>> = [
    { level: 'INFO',  stage: 'verify',       message: 'CHECKSUM ok CUST_CONTACT sha256=4a73…2bd6 rows=68215' },
    { level: 'WARN',  stage: 'transform',    message: 'to_date(yyyymmdd) coerced 4 NULL rows from CUST_CONTACT.BIRTH_DT' },
    { level: 'INFO',  stage: 'loader.stage', message: 'rule.apply to ext.cd=BNK_AMT_TYPE coverage=99.92%' },
    { level: 'ERROR', stage: 'validate.fk',
      message: 'FK violation GL_ENTRY.acct_no → ACCT_MASTER.no missing 12 rows · first=AC308051BX',
      suggestion: 'Parent record not yet loaded. Either wait for ACCT_MASTER to complete, or quarantine and continue.',
      actions: [ { label: 'Quarantine & continue', primary: true }, { label: 'Jump to row' } ] },
    { level: 'INFO',  stage: 'encode',       message: 'invalid EBCDIC byte 0x9F at offset 04200318 → replaced (U+FFFD)' },
    { level: 'WARN',  stage: 'loader.stage', message: 'long INSERT plan: cost=80009, threshold=50000 fallback to COPY' },
    { level: 'INFO',  stage: 'scheduler',    message: 'worker pool: 12 active · 4 queued · queue depth=7' },
    { level: 'INFO',  stage: 'extract',      message: 'LOAN_JOURNAL_2023 chunk 19 / 64 → 16.8 MB · 218041 rows' },
    { level: 'WARN',  stage: 'transform',    message: 'rule.apply to LOAN_REPAYMENT pending 18 committed=2218332' },
    { level: 'ERROR', stage: 'extract',
      message: 'mount /mnt/ext/dataset-0823 i/o error · errno=5 retries=3 (final)',
      suggestion: 'Worker can no longer see the dataset mount. Check the field operator that the USB volume is still attached.',
      actions: [ { label: 'Retry mount', primary: true }, { label: 'Skip dataset' } ] },
    { level: 'INFO',  stage: 'loader.stage', message: 'COPY public.cust_contact 68215 rows · 6.34s · throughput 10.7 K/s' },
    { level: 'INFO',  stage: 'encode',       message: 'sha256(LOAN_JOURNAL.txt) = 5808dde0…d4daf30' },
    { level: 'INFO',  stage: 'verify',       message: 'CHECKSUM ok BNK_AMT_TYPE sha256=8e8b…0f3a rows=4 (lookup)' },
    { level: 'WARN',  stage: 'scheduler',    message: 'icmsv ddolds move +3 task delayed > 120s (threshold 90s)' },
    { level: 'INFO',  stage: 'loader.stage', message: 'COPY public.gl_entry 218041 rows · 26.4s · throughput 8.2 K/s' },
    { level: 'WARN',  stage: 'transform',    message: 'duplicate key tcommit.id=AC308051BX skipped (already migrated)' },
    { level: 'INFO',  stage: 'extract',      message: 'JOURNAL_DAILY rotate: 4 files closed · 1 file appended' },
    { level: 'ERROR', stage: 'validate.uq',
      message: 'PK duplicate CUST_CONTACT row=BNK01CUC_5500 already present in ACCT_MASTER',
      suggestion: 'Two upstream tables emit overlapping primary keys. Choose the authoritative source.',
      actions: [ { label: 'Prefer ACCT_MASTER', primary: true }, { label: 'Quarantine row' } ] },
    { level: 'INFO',  stage: 'verify',       message: 'CHECKSUM ok GL_ENTRY sha256=27e1…f6f4 rows=218041' },
    { level: 'WARN',  stage: 'transform',    message: 'FK_RATE_DAILY direction lowered 0.75 → 0.65 (confidence)' },
    { level: 'INFO',  stage: 'scheduler',    message: 'worker pool: 14 active · 1 queued · queue depth=2' },
  ];

  // 시작 시각 09:42:01.150 부터 60ms 간격으로 깔아준다
  const baseSeconds = 9 * 3600 + 42 * 60 + 1;
  return lines.map((l, i) => {
    const tSec = baseSeconds + Math.floor((i * 600 + seed * 50) / 1000);
    const hh = Math.floor(tSec / 3600);
    const mm = Math.floor((tSec % 3600) / 60);
    const ss = tSec % 60;
    const ms = String(((i * 137 + seed * 31) % 1000)).padStart(3, '0');
    return {
      ...l,
      id: `log-${projectId}-${i}`,
      time: `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`,
      ms: `.${ms}`,
      runId: `r-20260521-${pad2(seed + 1)}`,
      date: '2026-05-21',
    };
  });
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function LogViewerPage() {
  const t = useT();
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const allLogs = useMemo(
    () => buildSyntheticLogs(activeProjectId ?? ''),
    [activeProjectId],
  );

  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<Record<LogLevel, boolean>>({
    INFO: true, WARN: true, ERROR: true,
  });
  const [followTail, setFollowTail] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  // 카운트는 필터 무관하게 전체 기준으로 표시
  const counts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 };
    for (const l of allLogs) c[l.level]++;
    return c;
  }, [allLogs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allLogs.filter((l) => {
      if (!levelFilter[l.level]) return false;
      if (!q) return true;
      return (
        l.message.toLowerCase().includes(q) ||
        l.stage.toLowerCase().includes(q) ||
        l.level.toLowerCase().includes(q)
      );
    });
  }, [allLogs, search, levelFilter]);

  // 첫 ERROR 라인을 기본 선택
  useEffect(() => {
    if (selectedId && filtered.some((l) => l.id === selectedId)) return;
    const firstErr = filtered.find((l) => l.level === 'ERROR');
    setSelectedId((firstErr ?? filtered[0])?.id ?? null);
  }, [filtered, selectedId]);

  // Follow tail — filtered 변할 때 + 마운트 시 맨 아래로
  useEffect(() => {
    if (!followTail) return;
    const el = tableScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [followTail, filtered]);

  const selected = useMemo(
    () => filtered.find((l) => l.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  // context — 선택된 라인 주변 ±3
  const context = useMemo(() => {
    if (!selected) return [];
    const idx = filtered.findIndex((l) => l.id === selected.id);
    if (idx < 0) return [];
    const start = Math.max(0, idx - 3);
    const end = Math.min(filtered.length, idx + 4);
    return filtered.slice(start, end);
  }, [filtered, selected]);

  const exportCsv = () => {
    const rows = [
      ['time', 'level', 'stage', 'message'].join(','),
      ...filtered.map((l) => [
        `${l.date} ${l.time}${l.ms}`,
        l.level,
        l.stage,
        // CSV escape
        '"' + l.message.replace(/"/g, '""') + '"',
      ].join(',')),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project?.name ?? 'logs'}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!project) {
    return (
      <div>
        <div style={styles.header}>
          <h1 style={styles.h1}>{t('logs.title')}</h1>
          <p style={styles.subtitle}>{t('logs.subtitle')}</p>
        </div>
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>{t('logs.empty.noProject')}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h1 style={styles.h1}>{t('logs.title')}</h1>
        <p style={styles.subtitle}>{project.name} · {t('logs.subtitle')}</p>
      </div>

      {/* 툴바: search · level filter · tail · wrap · export */}
      <div style={styles.toolbar}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('logs.search.placeholder')}
          style={styles.search}
        />
        <div style={styles.levelGroup}>
          <LevelChip
            label="INFO"
            active={levelFilter.INFO}
            count={counts.INFO}
            tone={styles.levelInfo}
            onClick={() => setLevelFilter((f) => ({ ...f, INFO: !f.INFO }))}
          />
          <LevelChip
            label="WARN"
            active={levelFilter.WARN}
            count={counts.WARN}
            tone={styles.levelWarn}
            onClick={() => setLevelFilter((f) => ({ ...f, WARN: !f.WARN }))}
          />
          <LevelChip
            label="ERROR"
            active={levelFilter.ERROR}
            count={counts.ERROR}
            tone={styles.levelError}
            onClick={() => setLevelFilter((f) => ({ ...f, ERROR: !f.ERROR }))}
          />
        </div>
        <div style={{ flex: 1 }} />
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={followTail}
            onChange={(e) => setFollowTail(e.target.checked)}
            style={styles.toggleInput}
          />
          <span>{t('logs.toggle.followTail')}</span>
        </label>
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
            style={styles.toggleInput}
          />
          <span>{t('logs.toggle.wrap')}</span>
        </label>
        <button onClick={exportCsv} style={styles.btnExport}>↥ {t('logs.export')}</button>
      </div>

      <div style={styles.main}>
        {/* 좌측 — 로그 테이블 */}
        <div style={styles.tablePanel}>
          <div ref={tableScrollRef} style={styles.tableScroll}>
            <table style={styles.table}>
              <colgroup>
                <col style={{ width: 108 }} />
                <col style={{ width: 70 }} />
                <col style={{ width: 130 }} />
                <col />
              </colgroup>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={styles.emptyRow}>
                      {t('logs.empty.noResult')}
                    </td>
                  </tr>
                ) : filtered.map((l) => {
                  const isSelected = l.id === selectedId;
                  const rowTone = l.level === 'ERROR' ? styles.rowError
                    : l.level === 'WARN' ? styles.rowWarn
                    : undefined;
                  return (
                    <tr
                      key={l.id}
                      onClick={() => setSelectedId(l.id)}
                      style={{
                        ...styles.tr,
                        ...rowTone,
                        ...(isSelected ? styles.trSelected : {}),
                      }}
                    >
                      <td style={styles.tdTime}>
                        <span>{l.time}</span>
                        <span style={styles.tdMs}>{l.ms}</span>
                      </td>
                      <td style={styles.tdLevel}>
                        <span style={{
                          ...styles.levelBadge,
                          ...(l.level === 'ERROR' ? styles.levelError
                            : l.level === 'WARN' ? styles.levelWarn
                            : styles.levelInfo),
                        }}>{l.level}</span>
                      </td>
                      <td style={styles.tdStage}>{l.stage}</td>
                      <td style={{
                        ...styles.tdMsg,
                        ...(wrap ? styles.tdMsgWrap : {}),
                      }}>{l.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={styles.tableFooter}>
            <span>{t('logs.footer.shown', { shown: String(filtered.length), total: String(allLogs.length) })}</span>
          </div>
        </div>

        {/* 우측 — 상세 패널 */}
        <aside style={styles.detail}>
          {selected ? (
            <>
              <div style={styles.detailHeader}>
                <div style={styles.detailEyebrow}>{t('logs.detail.title')}</div>
                <span style={{
                  ...styles.levelBadge,
                  ...(selected.level === 'ERROR' ? styles.levelError
                    : selected.level === 'WARN' ? styles.levelWarn
                    : styles.levelInfo),
                }}>{selected.level}</span>
              </div>

              <div style={styles.detailMsg}>{selected.message}</div>

              <div style={styles.detailMeta}>
                <MetaRow label={t('logs.detail.run')}    value={`${selected.runId} · ${selected.date}`} />
                <MetaRow label={t('logs.detail.stage')}  value={selected.stage} />
                <MetaRow label={t('logs.detail.time')}   value={`${selected.time}${selected.ms}`} />
              </div>

              {selected.suggestion && (
                <div style={styles.suggestBox}>
                  <div style={styles.suggestTitle}>{t('logs.detail.suggested')}</div>
                  <div style={styles.suggestBody}>{selected.suggestion}</div>
                  {selected.actions && (
                    <div style={styles.suggestActions}>
                      {selected.actions.map((a) => (
                        <button key={a.label} style={a.primary ? styles.btnPrimary : styles.btnGhost}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div style={styles.contextHeader}>
                <span>{t('logs.detail.context', { n: String(context.length) })}</span>
              </div>
              <div style={styles.contextList}>
                {context.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    style={{
                      ...styles.contextRow,
                      ...(c.id === selected.id ? styles.contextRowActive : {}),
                    }}
                  >
                    <span style={styles.contextTime}>{c.time}</span>
                    <span style={{
                      ...styles.contextLevel,
                      ...(c.level === 'ERROR' ? styles.levelError
                        : c.level === 'WARN' ? styles.levelWarn
                        : styles.levelInfo),
                    }}>{c.level}</span>
                    <span style={styles.contextMsg}>{c.message}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={styles.detailEmpty}>
              <div style={styles.detailEmptyTitle}>{t('logs.detail.emptyTitle')}</div>
              <div style={styles.detailEmptyHint}>{t('logs.detail.emptyHint')}</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function LevelChip({ label, active, count, tone, onClick }: {
  label: string;
  active: boolean;
  count: number;
  tone: React.CSSProperties;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.levelChip,
        ...(active ? { ...tone, opacity: 1 } : { ...styles.levelChipMuted }),
      }}
    >
      <span style={styles.levelChipDot} />
      <span>{label}</span>
      <span style={styles.levelChipCount}>{count}</span>
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metaRow}>
      <span style={styles.metaLabel}>{label}</span>
      <span style={styles.metaValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 120px)',
    minHeight: 540,
  },

  header: { marginBottom: 8 },
  h1: { margin: 0, fontSize: 17, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  subtitle: { margin: '2px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  empty: {
    background: 'var(--panel)',
    border: '1px dashed var(--border-strong)',
    borderRadius: 6,
    padding: '60px 24px',
    textAlign: 'center',
  },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  search: {
    flex: '1 1 220px',
    minWidth: 220,
    padding: '4px 9px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 11.5,
    fontFamily: 'var(--mono)',
    outline: 'none',
  },
  levelGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  levelChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 8px',
    border: '1px solid',
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.4,
    cursor: 'pointer',
    background: 'var(--panel)',
  },
  levelChipMuted: {
    background: 'var(--panel)',
    color: 'var(--text-4)',
    borderColor: 'var(--border-strong)',
    opacity: 0.55,
  },
  levelChipDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
    background: 'currentColor',
    display: 'inline-block',
  },
  levelChipCount: {
    background: 'rgba(0,0,0,0.06)',
    padding: '0 5px',
    borderRadius: 999,
    fontSize: 9.5,
    fontWeight: 700,
  },

  toggleLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10.5,
    color: 'var(--text-2)',
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  },
  toggleInput: { margin: 0, cursor: 'pointer' },

  btnExport: {
    padding: '3px 10px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },

  main: {
    display: 'flex',
    gap: 10,
    flex: 1,
    minHeight: 0,
  },

  /* ── Table side ─────────────────────────────────── */
  tablePanel: {
    flex: 1,
    minWidth: 0,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  tableScroll: {
    flex: 1,
    overflow: 'auto',
    fontFamily: 'var(--mono)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11.5,
  },
  tr: {
    cursor: 'pointer',
    borderBottom: '1px solid var(--border-light)',
  },
  trSelected: {
    background: 'var(--navy-50)',
    outline: '1px solid var(--navy)',
    outlineOffset: -1,
  },
  rowError: { background: 'var(--red-50)' },
  rowWarn:  { background: 'var(--amber-50)' },

  tdTime: {
    padding: '4px 10px',
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  },
  tdMs: { color: 'var(--text-4)' },
  tdLevel: {
    padding: '4px 6px',
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  },
  tdStage: {
    padding: '4px 10px',
    color: 'var(--text-2)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  },
  tdMsg: {
    padding: '4px 12px',
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 0,        // works with table-layout fixed to truncate
  },
  tdMsgWrap: {
    whiteSpace: 'pre-wrap',
    overflow: 'visible',
    textOverflow: 'clip',
    wordBreak: 'break-all',
  },

  levelBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    border: '1px solid',
    borderRadius: 3,
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.5,
    minWidth: 46,
    textAlign: 'center',
  },
  levelInfo:  { color: 'var(--navy)',  borderColor: 'var(--navy)',  background: 'var(--navy-50)' },
  levelWarn:  { color: 'var(--amber)', borderColor: 'var(--amber)', background: 'var(--amber-50)' },
  levelError: { color: 'var(--red)',   borderColor: 'var(--red)',   background: 'var(--red-50)' },

  emptyRow: {
    padding: '40px 16px',
    textAlign: 'center',
    color: 'var(--text-4)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
  },

  tableFooter: {
    padding: '6px 12px',
    borderTop: '1px solid var(--border)',
    background: 'var(--panel-2)',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    color: 'var(--text-4)',
    display: 'flex',
    justifyContent: 'flex-end',
  },

  /* ── Detail side ────────────────────────────────── */
  detail: {
    width: 320,
    flexShrink: 0,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '14px 16px',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  detailHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailEyebrow: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  detailMsg: {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text)',
    background: 'var(--panel-2)',
    padding: '8px 10px',
    borderRadius: 4,
    border: '1px solid var(--border)',
    wordBreak: 'break-all',
  },
  detailMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 2px',
  },
  metaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    fontSize: 11,
  },
  metaLabel: {
    color: 'var(--text-4)',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metaValue: {
    color: 'var(--text-2)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    textAlign: 'right',
    wordBreak: 'break-all',
  },

  suggestBox: {
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    padding: '10px 12px',
  },
  suggestTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--red)',
    fontFamily: 'var(--mono)',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  suggestBody: {
    fontSize: 11,
    color: 'var(--text)',
    lineHeight: 1.45,
    marginBottom: 8,
  },
  suggestActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  btnPrimary: {
    padding: '5px 10px',
    background: 'var(--red)',
    color: '#fff',
    border: '1px solid var(--red)',
    borderRadius: 3,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnGhost: {
    padding: '5px 10px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 3,
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },

  contextHeader: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  contextList: {
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  contextRow: {
    display: 'grid',
    gridTemplateColumns: '64px 56px 1fr',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    color: 'var(--text-2)',
    borderBottom: '1px solid var(--border-light)',
    cursor: 'pointer',
  },
  contextRowActive: {
    background: 'var(--navy-50)',
  },
  contextTime: { color: 'var(--text-4)' },
  contextLevel: {
    padding: '0 5px',
    border: '1px solid',
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 700,
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  contextMsg: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  detailEmpty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 24,
  },
  detailEmptyTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text-3)' },
  detailEmptyHint:  { fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--text-4)', marginTop: 4 },
};
