import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';
import {
  humanizeQuarantineDetail,
  quarantineRowAsIs,
  quarantineRowToBe,
  quarantineRowPk,
  quarantinePkColumnName,
  quarantineViolatedColumnName,
  type SiteQuarantineGroup,
  type QuarantineSeverity,
} from './quarantineMock';
import { quarantineApi } from '../api/quarantine';

/**
 * Site Quarantine — site 전체의 모든 프로젝트에서 모인 quarantine group 을 한 화면에 표시.
 *
 *  - 카드 한 장 = (project × validation rule group). project 컬럼 추가가 LogViewer 의 카드와의 유일한 차이.
 *  - severity 탭 (All / Errors / Warnings) + project 필터 + group dropdown 으로 검색 좁히기.
 *  - 카드 클릭하면 sample 표 + 액션바 펼침. 액션은 LogViewer 와 동일 동작 (Open mapping 만 navigate).
 *  - BE 가 들어오면 buildSiteQuarantineGroups 자리에 `/api/v1/sites/{siteId}/quarantine` fetch 로 swap.
 */
export function SiteQuarantinePage() {
  const t = useT();
  const navigate = useNavigate();
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const allProjects = useWorkspaceStore((s) => s.projects);

  const siteProjects = useMemo(
    () => allProjects.filter((p) => p.siteId === activeSiteId),
    [allProjects, activeSiteId],
  );
  /** activeSiteId 의 site 전체 quarantine. quarantineApi.bySite 로 fetch. */
  const [allGroups, setAllGroups] = useState<SiteQuarantineGroup[]>([]);
  useEffect(() => {
    if (!activeSiteId) { setAllGroups([]); return; }
    quarantineApi.bySite(activeSiteId)
      .then(setAllGroups)
      .catch((e) => { console.error('site quarantine fetch failed', e); setAllGroups([]); });
  }, [activeSiteId]);

  const [severityFilter, setSeverityFilter] = useState<'all' | QuarantineSeverity>('all');
  const [projectFilter,  setProjectFilter]  = useState<string | null>(null);   // null = 모든 프로젝트
  const [pickedGroupId,  setPickedGroupId]  = useState<string | null>(null);
  const [openGroupId,    setOpenGroupId]    = useState<string | null>(null);

  /* ── 통계 ───────────────────────────────────────── */
  const groupStats = useMemo(() => {
    let errRows = 0, warnRows = 0;
    for (const g of allGroups) {
      if (g.severity === 'error') errRows += g.rowCount; else warnRows += g.rowCount;
    }
    return {
      total: allGroups.length,
      errGroups:  allGroups.filter((g) => g.severity === 'error').length,
      warnGroups: allGroups.filter((g) => g.severity === 'warning').length,
      errRows, warnRows,
      totalRows: errRows + warnRows,
    };
  }, [allGroups]);

  /* ── 필터링 ─────────────────────────────────────── */
  const afterSeverity = useMemo(() => (
    severityFilter === 'all'
      ? allGroups
      : allGroups.filter((g) => g.severity === severityFilter)
  ), [allGroups, severityFilter]);

  const afterProject = useMemo(() => (
    projectFilter ? afterSeverity.filter((g) => g.projectId === projectFilter) : afterSeverity
  ), [afterSeverity, projectFilter]);

  /* All 이 기본이므로 dropdown 미선택 시 (severity + project 만 적용된) 모든 카드 표시.
     dropdown 으로 group 하나 고르면 그 카드만 보이고 나머지는 hide. */
  const filteredGroups = useMemo(() => (
    pickedGroupId ? afterProject.filter((g) => g.id === pickedGroupId) : afterProject
  ), [afterProject, pickedGroupId]);

  /* severity / project 가 좁아져서 picked 가 사라지면 picked 초기화. */
  useEffect(() => {
    if (pickedGroupId && !afterProject.some((g) => g.id === pickedGroupId)) {
      setPickedGroupId(null);
    }
  }, [afterProject, pickedGroupId]);

  /* dropdown 으로 group 선택 시 자동 펼침. */
  useEffect(() => {
    if (pickedGroupId) setOpenGroupId(pickedGroupId);
  }, [pickedGroupId]);

  /* ── render ─────────────────────────────────────── */
  if (!activeSiteId) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>{t('siteQuarantine.empty.noSite')}</div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <style>{QUAR_CARD_CSS}</style>

      <div style={styles.header}>
        {/* 위 줄 — stats */}
        <div style={styles.stats}>
          <div style={styles.statsEyebrow}>
            {t('siteQuarantine.eyebrow')}
            {projectFilter && (
              <span style={styles.statsProjectChip}>
                {siteProjects.find((p) => p.id === projectFilter)?.name}
              </span>
            )}
          </div>
          <div style={styles.statsLine}>
            {t('logs.quarantine.statsGroups', { n: String(groupStats.total) })}
            <span style={styles.statsSep}>·</span>
            {t('logs.quarantine.statsRows', {
              n: String(groupStats.totalRows),
              err: String(groupStats.errRows),
              warn: String(groupStats.warnRows),
            })}
          </div>
        </div>

        {/* 아래 줄 — 모든 필터 (좌: sev tab + project, 우: group select) */}
        <div style={styles.filterRow}>
          <div style={styles.sevToggle} role="tablist">
            <SevTab label={t('logs.quarantine.filter.all')}      count={groupStats.total}
              active={severityFilter === 'all'}     onClick={() => setSeverityFilter('all')} />
            <SevTab label={t('logs.quarantine.filter.errors')}   count={groupStats.errGroups}
              active={severityFilter === 'error'}   onClick={() => setSeverityFilter('error')}   tone="error" />
            <SevTab label={t('logs.quarantine.filter.warnings')} count={groupStats.warnGroups}
              active={severityFilter === 'warning'} onClick={() => setSeverityFilter('warning')} tone="warning" />
          </div>
          <select
            style={styles.projectSelect}
            value={projectFilter ?? ''}
            onChange={(e) => setProjectFilter(e.target.value || null)}
            disabled={siteProjects.length === 0}
          >
            <option value="">{t('siteQuarantine.pickProject.all')}</option>
            {siteProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select
            style={styles.groupSelect}
            value={pickedGroupId ?? ''}
            onChange={(e) => setPickedGroupId(e.target.value || null)}
            disabled={afterProject.length === 0}
          >
            <option value="">{t('logs.quarantine.pick.all')}</option>
            {afterProject.map((g) => (
              <option key={g.id} value={g.id}>{g.projectName} · {g.reason} ({g.rowCount})</option>
            ))}
          </select>

          <div style={{ flex: 1 }} />
        </div>
      </div>

      <div style={styles.scroll}>
        {filteredGroups.length === 0 ? (
          <div style={styles.empty}>{t('logs.quarantine.empty')}</div>
        ) : (
          filteredGroups.map((g) => (
            <SiteQuarantineCard
              key={g.id}
              g={g}
              t={t}
              open={openGroupId === g.id}
              onToggle={() => setOpenGroupId((cur) => (cur === g.id ? null : g.id))}
              onOpenMapping={() => navigate('/mapping')}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────── components ───────── */

function SevTab({ label, count, active, onClick, tone }: {
  label: string; count: number; active: boolean; onClick: () => void;
  tone?: 'error' | 'warning';
}) {
  const activeStyle = !active ? {}
    : tone === 'error'   ? styles.sevTabBtnActiveErr
    : tone === 'warning' ? styles.sevTabBtnActiveWarn
                         : styles.sevTabBtnActive;
  return (
    <button
      type="button" role="tab" aria-selected={active} onClick={onClick}
      style={{ ...styles.sevTabBtn, ...activeStyle }}
    >
      <span>{label}</span>
      <span style={styles.sevTabCount}>{count}</span>
    </button>
  );
}

function SiteQuarantineCard({ g, t, open, onToggle, onOpenMapping }: {
  g: SiteQuarantineGroup;
  t: (k: string, v?: Record<string, string>) => string;
  open: boolean;
  onToggle: () => void;
  onOpenMapping: () => void;
}) {
  const isErr = g.severity === 'error';
  const sevColor  = isErr ? '#c92a3f' : '#a86b00';
  const sevBg     = isErr ? 'rgba(232,93,117,0.08)' : 'rgba(232,181,99,0.10)';
  const sevBorder = isErr ? '#e85d75' : '#e8b563';
  const tt = t as unknown as (k: string, v?: Record<string, string>) => string;
  const human = humanizeQuarantineDetail(g, tt);
  const handleToggle = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onToggle();
  };
  const onChevronKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(e); }
  };
  return (
    <div
      aria-expanded={open}
      className="site-quar-card"
      style={{ ...styles.cardRoot, ...(open ? styles.cardRootOpen : {}) }}
    >
      <div style={{ ...styles.cardLeftBar, background: sevBorder }} />
      <div style={styles.cardBody}>
        <div style={styles.cardTopRow}>
          <button
            type="button"
            onClick={handleToggle}
            onKeyDown={onChevronKey}
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            style={styles.cardChevron}
          >
            {open ? '▾' : '▸'}
          </button>
          <div style={styles.cardTitles}>
            <div style={{ ...styles.cardReason, color: sevColor }}>{g.reason}</div>
            {human && <div style={styles.cardHumanDetail}>{human}</div>}
          </div>
          <div style={styles.cardMetaRight}>
            <span style={styles.cardProjectName}>{g.projectName}</span>
            <span style={{ ...styles.rowsBadge, color: sevColor, borderColor: sevBorder, background: sevBg }}>
              {t('logs.quarantine.rowsBadge', { n: String(g.rowCount) })}
            </span>
            <span style={styles.cardStage}>{g.stage}</span>
          </div>
        </div>

        {open && (
          <div style={styles.cardExpand}>
            <div style={styles.cardTableWrap}>
              <table style={styles.cardTable}>
                <thead>
                  {/* PROJECT 컬럼은 cross-project 뷰의 식별 도움 (card 헤더와 중복이지만 긴 스크롤 시 유용).
                      TABLE 컬럼은 PK 로 교체 — 같은 group 안에서 row 식별. */}
                  <tr>
                    <th style={{ ...styles.cardTh, ...styles.cardThTable }}>{t('logs.quarantine.colProject')}</th>
                    <th style={{ ...styles.cardTh, ...styles.cardThTable }}>
                      {quarantinePkColumnName(g) ?? t('logs.quarantine.colTable')}
                    </th>
                    <th style={{ ...styles.cardTh, color: sevColor }}>
                      {t('logs.quarantine.colAsIs')}
                      {quarantineViolatedColumnName(g) && (
                        <span style={{ fontWeight: 400, opacity: 0.75 }}> · {quarantineViolatedColumnName(g)}</span>
                      )}
                    </th>
                    <th style={styles.cardTh}>{t('logs.quarantine.colToBe')}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.sampleRows.map((_, ri) => {
                    const pk = quarantineRowPk(g, ri);
                    const asIs = quarantineRowAsIs(g, ri);
                    const toBe = quarantineRowToBe(g, ri);
                    const asIsNullStyle = { ...styles.nullCell, color: sevColor, background: 'transparent', border: `1px solid ${sevBorder}` };
                    return (
                      <tr key={ri}>
                        <td style={{ ...styles.cardTd, ...styles.cardTdTable }}>{g.projectName}</td>
                        <td style={{ ...styles.cardTd, ...styles.cardTdTable }}>
                          {pk === null ? <span style={styles.nullCell}>—</span> : String(pk)}
                        </td>
                        <td style={{ ...styles.cardTd, color: sevColor, fontWeight: 700, background: sevBg }}>
                          {asIs === null ? <span style={asIsNullStyle}>NULL</span> : String(asIs)}
                        </td>
                        <td style={{ ...styles.cardTd, ...styles.cardTdToBe }}>
                          {toBe === null ? <span style={styles.nullCell}>NULL</span> : String(toBe)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={styles.cardActions} onClick={(e) => e.stopPropagation()}>
              <button type="button" style={styles.actPrimary} onClick={onOpenMapping}>
                {t('logs.quarantine.act.openMapping')}
              </button>
              <div style={{ flex: 1 }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────── styles ───────────── */

const QUAR_CARD_CSS = `
.site-quar-card,
.site-quar-card:focus,
.site-quar-card:focus-visible,
.site-quar-card:focus-within { outline: none !important; }
`;

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)', minHeight: 540 },

  header: {
    /* 2 줄 stack — 위: stats, 아래: 필터 한 줄. */
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '10px 14px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    flexWrap: 'nowrap',
  },
  stats: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  statsEyebrow: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 10, fontWeight: 800, color: 'var(--text-3)',
    fontFamily: 'var(--mono)', letterSpacing: 1.4, textTransform: 'uppercase',
  },
  /* SITE QUARANTINE 옆 — 선택된 project 이름 chip */
  statsProjectChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 8px', borderRadius: 999,
    background: 'var(--panel-2)', border: '1px solid var(--border)',
    color: 'var(--text)',
    /* eyebrow 가 mono+uppercase 인데 chip 은 normal text 가 자연스럽다. */
    fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
    letterSpacing: 0, textTransform: 'none',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  statsLine: {
    fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--mono)',
    display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
  },
  statsSep: { color: 'var(--text-4)' },

  sevToggle: {
    display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 5,
    overflow: 'hidden', background: 'var(--panel-2)',
  },
  sevTabBtn: {
    /* chip width 고정 — 활성 background 색이 바뀌어도 width 변동 X → layout shift 없음. */
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    minWidth: 92,
    padding: '5px 12px', border: 'none', background: 'transparent',
    color: 'var(--text-3)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    borderRight: '1px solid var(--border)',
  },
  sevTabBtnActive:     { background: 'var(--panel)',          color: 'var(--text)' },
  sevTabBtnActiveErr:  { background: 'rgba(232,93,117,0.12)', color: '#c92a3f' },
  sevTabBtnActiveWarn: { background: 'rgba(232,181,99,0.18)', color: '#a86b00' },
  sevTabCount: {
    display: 'inline-block', minWidth: 14, padding: '0 5px',
    background: 'rgba(0,0,0,0.06)', fontSize: 10, fontWeight: 700,
    fontFamily: 'var(--mono)', borderRadius: 999, textAlign: 'center',
    color: 'inherit',
  },

  /* 사이드바 "프로젝트 검색" input 과 동일 폰트 (default sans, 11.5). */
  projectSelect: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, cursor: 'pointer',
    minWidth: 140, maxWidth: 200,
  },
  /* 우측 group select — 작게 ('항목 선택' 의도) */
  groupSelect: {
    padding: '5px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, cursor: 'pointer',
    width: 220, maxWidth: 260,
    textOverflow: 'ellipsis',
  },

  scroll: {
    flex: 1, overflow: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 12,
    background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  empty: {
    padding: '60px 20px', textAlign: 'center',
    color: 'var(--text-4)', fontSize: 12, fontFamily: 'var(--mono)',
  },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  /* card — LogViewerPage 의 quarantine card 와 같은 디자인 + project name 추가 */
  cardRoot: {
    display: 'flex', flexShrink: 0,
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    overflow: 'hidden',
    outline: 'none',
    transition: 'box-shadow 120ms ease',
  },
  cardRootOpen: { boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 8px 24px -12px rgba(0,0,0,0.18)' },
  cardLeftBar:  { width: 4, flexShrink: 0 },
  cardBody:     { flex: 1, minWidth: 0, padding: '10px 16px' },

  cardTopRow:  { display: 'flex', alignItems: 'center', gap: 12 },
  /* chevron 만 클릭 가능 — 카드 전체 클릭으로 펴졌다 접혔다 하지 않도록. */
  cardChevron: {
    flexShrink: 0, width: 22, height: 22, padding: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid transparent', borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-4)', fontSize: 11, lineHeight: 1, userSelect: 'none',
    cursor: 'pointer',
  },
  cardTitles:   { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  cardReason:   { fontSize: 14, fontWeight: 700, lineHeight: 1.3 },
  cardDetail:   { fontSize: 11.5, color: 'var(--text-4)', fontFamily: 'var(--mono)', wordBreak: 'break-word' },
  /* DB 표기를 사람말로 풀이한 한 줄 — mono 가 아닌 본문 폰트, 본문 톤. */
  cardHumanDetail: {
    fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.45,
    marginTop: 4, wordBreak: 'keep-all',
  },
  /* humanDetail — DB 표기를 사람말로 풀이. mono 가 아닌 본문 폰트로 별도 줄. */
  cardHumanDetail: {
    fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.45,
    marginTop: 4, wordBreak: 'keep-all',
  },
  cardMetaRight: {
    display: 'grid',
    gridTemplateColumns: '160px 72px 132px',
    alignItems: 'center', gap: 10, flexShrink: 0,
    fontFamily: 'var(--mono)',
  },
  cardProjectName: {
    fontSize: 11, color: 'var(--text-2)', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  rowsBadge: {
    display: 'inline-flex', alignItems: 'center',
    padding: '3px 10px', border: '1px solid', borderRadius: 999,
    fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6,
  },
  cardStage: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },

  cardExpand: { marginTop: 12 },
  cardTableWrap: {
    border: '1px solid var(--border)', borderRadius: 4,
    maxHeight: 280, overflow: 'auto',
  },
  cardTable: {
    width: '100%', borderCollapse: 'collapse',
    fontFamily: 'var(--mono)', fontSize: 11.5,
  },
  /* 모든 컬럼 헤더는 PROJECT_NAME 기준으로 배경/색을 통일 (panel + text-2). */
  cardTh: {
    textAlign: 'left', padding: '6px 12px',
    background: 'var(--panel)', color: 'var(--text-2)',
    fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  /* 위반 컬럼은 severity color 로 강조 — 운영자가 한눈에 원인 파악. */
  cardThViolated: { fontWeight: 800 },
  cardThPk:       {},
  /* PROJECT_NAME 컬럼 — 시각 통일성을 위해 default cardTh 그대로 사용. */
  cardThTable:    {},
  /* 컬럼 헤더 옆 role 라벨 — 컬럼 이름의 색을 그대로 상속해서 가독성 확보. */
  cardThRole: {
    color: 'inherit', fontWeight: 500,
    fontSize: 10, letterSpacing: 0, textTransform: 'none',
    marginLeft: 2,
  },
  cardTd: {
    padding: '6px 12px', borderBottom: '1px solid var(--border)',
    color: 'var(--text-2)', whiteSpace: 'nowrap',
  },
  /* PROJECT_NAME / TABLE_NAME 컬럼 셀 — default cardTd 와 동일 톤, 굵기만 약간 강조. */
  cardTdTable: { fontWeight: 600 },
  /* TO-BE 컬럼 셀 — 룰 엔진 transform 결과 값. AS-IS 보다 한 톤 약하게. */
  cardTdToBe: { color: 'var(--text-3)' },
  nullCell: {
    display: 'inline-block', padding: '0 6px',
    background: 'rgba(160,168,180,0.18)', color: 'var(--text-4)',
    fontSize: 10, fontWeight: 700, borderRadius: 3, letterSpacing: 0.4,
  },

  cardActions: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)',
  },
  actPrimary: {
    padding: '6px 14px', border: '1px solid #1f8a5c', borderRadius: 4,
    background: '#21946a', color: '#fff',
    fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
  },
  actSecondary: {
    padding: '6px 14px', border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
};
