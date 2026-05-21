import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';
import {
  levelName,
  type RunLogLevel,
  type RunLogLine,
} from '../api/runLogs';
import { buildMockLines, stageColor } from './logViewerMock';
import { useQuarantineStore } from '../store/quarantine';

/**
 * Log viewer — 프로젝트 실행 로그 조회.
 *
 *  데모 모드: USE_MOCK=true 면 결정적 합성 로그 240줄을 화면에 채운다.
 *  BE ingest 가 실데이터로 들어오면 useLogsHistory / useLogsStream 으로 swap.
 *  (swap 포인트: 아래 allLines 계산부)
 */

const USE_MOCK = true;
const MOCK_COUNT = 240;
const ROW_ESTIMATE = 22;

export function LogViewerPage() {
  const t = useT();
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const runId = activeProjectId ?? 'demo';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<Record<RunLogLevel, boolean>>({
    INFO: true, WARN: true, ERROR: true,
  });
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  /** STEP(=stage) 필터. null = 전체, 문자열 = 그 stage 만. */
  const [stepFilter, setStepFilter] = useState<string | null>(null);

  /** quarantine 큐는 Execution 페이지와 공유. row 의 [Q] 회색 마커용 read 만. */
  const quarantinedSeqs = useQuarantineStore((s) => s.seqs);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 200);
    return () => window.clearTimeout(id);
  }, [search]);

  /* ── 데이터 ─────────────────────────────────────── */
  const allLines = useMemo<RunLogLine[]>(
    () => (USE_MOCK ? buildMockLines(runId, MOCK_COUNT) : []),
    [runId],
  );

  const lines = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return allLines.filter((l) => {
      const name: RunLogLevel = l.level === 2 ? 'ERROR' : l.level === 1 ? 'WARN' : 'INFO';
      if (!levelFilter[name]) return false;
      if (stepFilter && l.stage !== stepFilter) return false;
      if (!q) return true;
      return l.message.toLowerCase().includes(q) || l.stage.toLowerCase().includes(q);
    });
  }, [allLines, debouncedSearch, levelFilter, stepFilter]);

  /** STEP 필터 리스트용 — 모든 unique stage + 발생 횟수, 알파벳순. */
  const stages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of allLines) counts.set(l.stage, (counts.get(l.stage) ?? 0) + 1);
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [allLines]);

  const totalCounts = useMemo(() => {
    let info = 0, warn = 0, err = 0;
    for (const l of allLines) {
      if (l.level === 2) err++;
      else if (l.level === 1) warn++;
      else info++;
    }
    return { info, warn, error: err, total: allLines.length };
  }, [allLines]);

  const selected: RunLogLine | null = useMemo(
    () => lines.find((l) => l.seq === selectedSeq) ?? null,
    [lines, selectedSeq],
  );

  /** 현재 필터링된 lines 안에서 선택된 라인의 0-based 위치. 선택 없음/필터됨 → -1 */
  const selectedIndex = useMemo(
    () => (selectedSeq == null ? -1 : lines.findIndex((l) => l.seq === selectedSeq)),
    [lines, selectedSeq],
  );

  /* 첫 ERROR 자동 선택 (필터 변경 시 사라지면 재선택) */
  useEffect(() => {
    if (selectedSeq != null && lines.some((l) => l.seq === selectedSeq)) return;
    const firstErr = lines.find((l) => l.level === 2);
    setSelectedSeq((firstErr ?? lines[0])?.seq ?? null);
  }, [lines, selectedSeq]);

  /* Step 필터 변경 시 — 그 step 범위의 첫 ERROR 로 강제 재선택.
     ALL ↔ specific 전환 시 이전 INFO 선택이 그대로 남아 Suggested action 이
     안 보이던 문제를 잡는다. */
  const prevStepFilter = useRef(stepFilter);
  useEffect(() => {
    if (prevStepFilter.current === stepFilter) return;
    prevStepFilter.current = stepFilter;
    const firstErr = lines.find((l) => l.level === 2);
    setSelectedSeq((firstErr ?? lines[0])?.seq ?? null);
  }, [stepFilter, lines]);

  /* ── virtualizer ─────────────────────────────────── */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 24,
  });

  /**
   * 방향키로 행을 한 칸씩 이동. 검색창 / 텍스트 입력 중에는 가로채지 않는다
   * (input 안의 텍스트 커서 동작을 깨면 안 됨).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (lines.length === 0) return;
      e.preventDefault();
      const cur = selectedSeq == null ? -1 : lines.findIndex((l) => l.seq === selectedSeq);
      const nextIdx = e.key === 'ArrowDown'
        ? (cur < 0 ? 0 : Math.min(lines.length - 1, cur + 1))
        : (cur <= 0 ? 0 : cur - 1);
      const next = lines[nextIdx];
      if (!next) return;
      setSelectedSeq(next.seq);
      virtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines, selectedSeq, virtualizer]);

  /* ── render ──────────────────────────────────────── */

  if (!project) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('logs.empty.noProject')}</div>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div style={styles.root}>
      <style>{LOG_SCROLL_CSS}</style>

      <div style={styles.toolbar}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('logs.search.placeholder')}
          style={styles.search}
        />

        <div style={styles.levelGroup}>
          <LevelChip label="INFO"  active={levelFilter.INFO}  count={totalCounts.info}
            color="#a0a8b4" onClick={() => setLevelFilter((f) => ({ ...f, INFO: !f.INFO }))} />
          <LevelChip label="WARN"  active={levelFilter.WARN}  count={totalCounts.warn}
            color="#e8b563" onClick={() => setLevelFilter((f) => ({ ...f, WARN: !f.WARN }))} />
          <LevelChip label="ERROR" active={levelFilter.ERROR} count={totalCounts.error}
            color="#e85d75" onClick={() => setLevelFilter((f) => ({ ...f, ERROR: !f.ERROR }))} />
        </div>

        <label style={styles.stepInline}>
          <span style={styles.stepInlineLabel}>Step</span>
          <select
            value={stepFilter ?? ''}
            onChange={(e) => setStepFilter(e.target.value || null)}
            style={styles.stepSelectInline}
          >
            <option value="">All ({allLines.length})</option>
            {stages.map(([s, n]) => (
              <option key={s} value={s}>{s} ({n})</option>
            ))}
          </select>
        </label>

        <div style={{ flex: 1 }} />

      </div>

      <div style={styles.main}>
        {/* 좌측 — 다크 터미널 로그 테이블 */}
        <div style={styles.tablePanel}>
          <div ref={scrollRef} className="log-scroll" style={styles.tableScroll}>
            {lines.length === 0 ? (
              <div style={styles.emptyRow}>{t('logs.empty.noResult')}</div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%', minWidth: 1196 }}>
                {virtualItems.map((vi) => {
                  const l = lines[vi.index];
                  if (!l) return null;
                  const isSelected = l.seq === selectedSeq;
                  const isQuarantined = quarantinedSeqs.includes(l.seq);
                  const tone = l.level === 2 ? styles.rowError
                    : l.level === 1 ? styles.rowWarn : undefined;
                  const msgColor = isQuarantined ? '#6e7686'
                    : l.level === 2 ? '#ff8194'
                    : l.level === 1 ? '#f5d76e' : '#a0a8b4';
                  return (
                    <div
                      key={`${l.runId}-${l.seq}`}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      onClick={() => setSelectedSeq(l.seq)}
                      style={{
                        position: 'absolute', top: 0, left: 0, right: 0,
                        transform: `translateY(${vi.start}px)`,
                        ...styles.row, ...tone,
                        ...(isSelected ? styles.rowSelected : {}),
                        ...(isQuarantined ? styles.rowQuarantined : {}),
                      }}
                    >
                      <span style={styles.cellTime}>
                        {formatTime(l.ts)}<span style={styles.cellMs}>{formatMs(l.ts)}</span>
                      </span>
                      <span style={styles.cellLevel}>
                        <span style={{
                          ...styles.lvBadge,
                          ...(l.level === 2 ? styles.lvError
                            : l.level === 1 ? styles.lvWarn : styles.lvInfo),
                        }}>{levelName(l.level)}</span>
                      </span>
                      <span style={{ ...styles.cellStage, color: isQuarantined ? '#6e7686' : stageColor(l.stage) }}>
                        <Hl text={l.stage} q={debouncedSearch} />
                      </span>
                      <span style={{ ...styles.cellMsg, color: msgColor }}>
                        {isQuarantined && <span style={styles.quarantineTag}>[Q]</span>}
                        <Hl text={l.message} q={debouncedSearch} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div style={styles.tableFooter}>
            <span>
              {selectedIndex >= 0
                ? t('logs.footer.shown', { shown: String(selectedIndex + 1), total: String(lines.length) })
                : t('logs.footer.shown', { shown: String(lines.length), total: String(totalCounts.total) })}
            </span>
          </div>
        </div>

        {/* 우측 — 상세 패널: Log entry → Filter by step → Suggested action 순서 */}
        <aside style={styles.detail}>
          {selected ? (
            <>
              <div style={styles.detailHeader}>
                <div style={styles.detailEyebrow}>{t('logs.detail.title')} #{selected.seq}</div>
                <span style={{
                  ...styles.levelBadge,
                  ...(selected.level === 2 ? styles.levelError
                    : selected.level === 1 ? styles.levelWarn : styles.levelInfo),
                }}>{levelName(selected.level)}</span>
              </div>

              <div style={styles.detailMsg}>{selected.message}</div>

              <div style={styles.detailMeta}>
                <MetaRow label={t('logs.detail.time')}  value={formatTime(selected.ts) + formatMs(selected.ts)} />
                <MetaRow label={t('logs.detail.stage')} value={selected.stage} />
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

/* ─────────────────── small components ──────────────── */

function LevelChip({ label, active, count, color, onClick }: {
  label: RunLogLevel; active: boolean; count: number; color: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.levelChip,
        color: active ? color : 'var(--text-4)',
        borderColor: active ? color : 'var(--border-strong)',
        opacity: active ? 1 : 0.55,
      }}
    >
      <span style={{ ...styles.levelChipDot, background: 'currentColor' }} />
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

/** 검색어 노란 highlight */
function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lc = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const found = lc.indexOf(needle, i);
    if (found < 0) { out.push(<span key={k++}>{text.slice(i)}</span>); break; }
    if (found > i) out.push(<span key={k++}>{text.slice(i, found)}</span>);
    out.push(<mark key={k++} style={styles.mark}>{text.slice(found, found + needle.length)}</mark>);
    i = found + needle.length;
  }
  return <>{out}</>;
}

/* ─────────────────── helpers ────────────────────────── */
function formatTime(iso: string): string {
  try { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
  catch { return ''; }
}
function formatMs(iso: string): string {
  try { const d = new Date(iso); return `.${String(d.getMilliseconds()).padStart(3, '0')}`; }
  catch { return ''; }
}
function pad2(n: number) { return String(n).padStart(2, '0'); }

/* ─────────────────── styles ──────────────────────────
 *  로그 테이블 row 영역만 다크 (검정), 나머지(툴바·검색·상세·context·footer)는 라이트.
 *  라이트 톤은 사이트 공통 CSS 변수 (--panel / --border / --text-* 등) 를 그대로 사용.
 */

// 로그 row 영역 전용 — 다크 네이비. 검정에 푸른 끼만 살짝, 채도는 낮춰 눈 피로 방지.
const LOG_BG       = '#161c2c';
const LOG_BORDER   = '#262d40';

/**
 * 로그 테이블 스크롤바 — 다크 배경 위에서 도드라지지 않도록 같은 톤으로.
 * inline style 로는 ::-webkit-scrollbar pseudo 를 못 줘서 <style> 태그로 주입.
 * Firefox 는 inline `scrollbarColor` / `scrollbarWidth` 로 처리.
 */
const LOG_SCROLL_CSS = `
.log-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.log-scroll::-webkit-scrollbar-track { background: transparent; }
.log-scroll::-webkit-scrollbar-thumb { background: #2a3550; border-radius: 4px; }
.log-scroll::-webkit-scrollbar-thumb:hover { background: #3a4566; }
.log-scroll::-webkit-scrollbar-corner { background: transparent; }
`;

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)', minHeight: 540 },

  empty: { background: 'var(--panel)', border: '1px dashed var(--border-strong)', borderRadius: 6, padding: '60px 24px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 8px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 5, marginBottom: 6, flexWrap: 'wrap',
  },
  search: {
    flex: '0 0 220px', width: 220, minWidth: 140,
    padding: '4px 9px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)', fontSize: 11.5,
    outline: 'none',
  },
  levelGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  levelChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '2px 8px', border: '1px solid', borderRadius: 999,
    fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: 0.4,
    cursor: 'pointer', background: 'var(--panel)',
  },
  levelChipDot: { width: 5, height: 5, borderRadius: 999, display: 'inline-block' },
  levelChipCount: { background: 'rgba(0,0,0,0.06)', padding: '0 5px', borderRadius: 999, fontSize: 9.5, fontWeight: 700 },

  main: { display: 'flex', gap: 10, flex: 1, minHeight: 0 },

  /* ── 로그 테이블 (다크) ── */
  tablePanel: {
    flex: 1, minWidth: 0, background: LOG_BG,
    border: `1px solid ${LOG_BORDER}`, borderRadius: 6,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  tableScroll: {
    flex: 1, overflow: 'auto', fontFamily: 'var(--mono)', background: LOG_BG,
    scrollbarColor: '#2a3550 transparent',
    scrollbarWidth: 'thin',
  },

  row: {
    display: 'grid',
    /* 메시지 col 최소 900px 보장 — 가시 폭이 좁으면 부모 (가상화 컨테이너) minWidth
       에 의해 row 가 가시폭 초과 → tableScroll 가로 스크롤 활성화. */
    gridTemplateColumns: '108px 56px 132px minmax(900px, 1fr)',
    alignItems: 'center',
    gap: 0,
    minHeight: ROW_ESTIMATE,
    borderBottom: `1px solid ${LOG_BORDER}`,
    cursor: 'pointer',
    fontSize: 11.5,
    fontFamily: 'var(--mono)',
  },
  rowSelected: { background: 'rgba(95,163,232,0.18)', outline: '1px solid #5fa3e8', outlineOffset: -1 },
  rowError: { background: 'rgba(232,93,117,0.12)' },
  rowWarn:  { background: 'rgba(232,181,99,0.08)' },
  rowQuarantined: { opacity: 0.45 },

  cellTime:  { padding: '3px 10px', color: '#7a8398', whiteSpace: 'nowrap' },
  cellMs:    { color: '#5a6280' },
  cellLevel: { padding: '3px 4px', whiteSpace: 'nowrap', textAlign: 'center' },
  cellStage: { padding: '3px 10px', whiteSpace: 'nowrap', fontWeight: 600 },

  /* row 안의 level 배지 — 다크 배경 위에서 잘 보이는 톤 */
  lvBadge: {
    display: 'inline-block', padding: '1px 6px', border: '1px solid', borderRadius: 3,
    fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: 0.5,
    minWidth: 44, textAlign: 'center',
  },
  lvInfo:  { color: '#a0a8b4', borderColor: '#3a4150', background: 'rgba(160,168,180,0.10)' },
  lvWarn:  { color: '#f5d76e', borderColor: '#7a6627', background: 'rgba(245,215,110,0.14)' },
  lvError: { color: '#ff8194', borderColor: '#7a2734', background: 'rgba(255,107,129,0.18)' },
  cellMsg: {
    padding: '3px 12px',
    whiteSpace: 'nowrap',
  },
  mark: { background: '#4a3f00', color: '#f5d76e', padding: '0 1px', borderRadius: 1 },
  quarantineTag: {
    display: 'inline-block', marginRight: 6,
    padding: '0 4px', borderRadius: 2,
    background: 'rgba(160,168,180,0.18)', color: '#a8b0c0',
    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
  },

  emptyRow: {
    padding: '40px 16px', textAlign: 'center',
    color: '#4a5060', fontFamily: 'var(--mono)', fontSize: 11, background: LOG_BG,
  },

  /* ── footer (라이트) ── */
  tableFooter: {
    padding: '5px 12px', borderTop: '1px solid var(--border)', background: 'var(--panel-2)',
    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)',
    display: 'flex', justifyContent: 'flex-end',
  },

  /* ── 우측 상세 (라이트) — 콘텐츠 크기로만 차지, 메인은 옆으로 확장 ── */
  detail: {
    width: 240, flexShrink: 0,
    alignSelf: 'flex-start',
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '10px 12px', overflow: 'auto',
    display: 'flex', flexDirection: 'column', gap: 8,
    color: 'var(--text)',
  },
  detailHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  detailEyebrow: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  detailMsg: {
    fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text)',
    background: 'var(--panel-2)', padding: '8px 10px',
    borderRadius: 4, border: '1px solid var(--border)', wordBreak: 'break-all',
  },
  detailMeta: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 2px' },
  metaRow: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 },
  metaLabel: {
    color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 10,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  metaValue: { color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right', wordBreak: 'break-all' },

  /* level badge — 흰 배경에 잘 보이도록 라이트 톤 */
  levelBadge: {
    display: 'inline-block', padding: '1px 7px', border: '1px solid', borderRadius: 3,
    fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: 0.5,
    minWidth: 46, textAlign: 'center',
  },
  levelInfo:  { color: '#5a6172', borderColor: '#c8ccd3', background: 'rgba(120,128,140,0.08)' },
  levelWarn:  { color: '#a86b00', borderColor: '#e8b563', background: 'rgba(232,181,99,0.15)' },
  levelError: { color: '#c92a3f', borderColor: '#e85d75', background: 'rgba(232,93,117,0.12)' },


  /* STEP 필터 — 툴바 안 inline (INFO/WARN/ERROR chip 오른쪽) */
  stepInline: { display: 'inline-flex', alignItems: 'center', gap: 5 },
  stepInlineLabel: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  stepSelectInline: {
    padding: '3px 8px',
    border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
    maxWidth: 180,
  },

  detailEmpty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24,
  },
  detailEmptyTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text-3)' },
  detailEmptyHint:  { fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--text-4)', marginTop: 4 },
};
