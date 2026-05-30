import { useState } from 'react';
import { useT, type TranslationKey } from '../i18n';
import type { PreflightCheck, CheckStatus } from '../store/executionPreflight';
import { titleKeyForId } from '../lib/preflightValidation';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface Props {
  /** Preflight results. Empty array renders the empty-state placeholder. */
  checks: PreflightCheck[];
  /** Per-table or per-check Fix handler. Project-wide checks receive table=undefined.  */
  onFix?: (check: PreflightCheck, table?: string) => void;
  /** When false, Fix buttons are not shown (read-only review mode). */
  showFix?: boolean;
  /** Placeholder string for the empty / not-yet-run state. */
  emptyText?: string;
}

/**
 * Pre-flight 結果リスト. Execution / Versions 両画面で共有する.
 *
 * - aggregate badge (PASS / FAIL / SKIP / N pass + M fail)
 * - scope === 'per-table' の行は展開可能 (▾ ▸), 展開時に全テーブルの pass/fail 状況
 * - Fix ボタンは failure 行のみ表示. per-table 展開時はテーブル単位でも.
 */
export function PreflightResultPanel({ checks, onFix, showFix = true, emptyText }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (checks.length === 0) {
    return (
      <div style={styles.emptyContainer}>
        <div style={styles.emptyText}>{emptyText ?? t('execution.preflight.empty')}</div>
      </div>
    );
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={styles.container}>
      {checks.map((c, i) => (
        <CheckRow
          key={c.id}
          t={t}
          check={c}
          isLast={i === checks.length - 1}
          expanded={expanded.has(c.id)}
          onToggle={() => toggle(c.id)}
          onFix={onFix}
          showFix={showFix}
        />
      ))}
    </div>
  );
}

function CheckRow({
  t, check, isLast, expanded, onToggle, onFix, showFix,
}: {
  t: T;
  check: PreflightCheck;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  onFix?: (check: PreflightCheck, table?: string) => void;
  showFix: boolean;
}) {
  const isPerTable = check.scope === 'per-table';
  const passCount = check.perTable.filter((r) => r.status === 'pass').length;
  const failCount = check.perTable.filter((r) => r.status === 'fail').length;
  const skipCount = check.perTable.filter((r) => r.status === 'skip').length;
  const total = check.perTable.length;
  const projectDetailRow = !isPerTable ? check.perTable[0] : undefined;
  const projectDetail = projectDetailRow ? t(projectDetailRow.detailKey, projectDetailRow.detailVars) : '';

  const aggregateColor =
    check.aggregate === 'fail' ? 'var(--red)' :
    check.aggregate === 'skip' ? 'var(--text-4)' :
    'var(--green)';

  /* Aggregate badge — per-table → 'N pass / M fail / K skip', project → status word. */
  const aggregateLabel = isPerTable
    ? aggregatePerTableLabel(t, passCount, failCount, skipCount, total)
    : aggregateProjectLabel(t, check.aggregate);

  return (
    <>
      <div
        style={{
          ...styles.row,
          borderBottom: isLast && !expanded ? 'none' : '1px solid var(--border)',
          background: check.aggregate === 'fail' ? 'var(--red-50)' : 'var(--panel)',
          cursor: isPerTable ? 'pointer' : 'default',
        }}
        onClick={isPerTable ? onToggle : undefined}
      >
        {/* 5 列構成 (dot / title / detail / chev / fix) を全行で固定する.
            project 行でも chev セルを空 span として描画しないと、grid が 4 アイテムで
            列が前詰めになり Fix の X 位置が per-table 行とずれる. */}
        <StatusDot status={check.aggregate} />
        {/* cache に固定された check.title ではなく id から t() で都度解決 — i18n 変更が再 run なしに反映. */}
        <span style={styles.title}>{t(titleKeyForId(check.id))}</span>
        <span
          style={{
            ...styles.detailInline,
            ...(isPerTable ? { color: aggregateColor } : {}),
          }}
        >
          {isPerTable ? aggregateLabel : projectDetail}
        </span>
        <span style={styles.chev} aria-hidden={!isPerTable}>
          {isPerTable ? (expanded ? '▾' : '▸') : ''}
        </span>
        {/* aggregate Fix は per-table Fix が表示されない場合のみ出す:
            - project scope: per-table 行が無いので aggregate Fix のみ
            - per-table + fixIsProjectWide=true (csv-arrived): per-table Fix を隠す造りなので aggregate Fix で代替
            - per-table + fixIsProjectWide=false (tobe-bindings/unmapped-cols/asis-unmapped):
              各行に per-table Fix があるため aggregate Fix は冗長 → 非表示 */}
        {check.aggregate === 'fail' && showFix && onFix
          && (check.scope === 'project' || check.fixIsProjectWide) ? (
          <button
            type="button"
            style={styles.fixBtn}
            onClick={(e) => { e.stopPropagation(); onFix(check); }}
            title={t('execution.preflight.fix')}
          >
            {t('execution.preflight.fix')}
          </button>
        ) : (
          <span style={styles.fixBtnPlaceholder} />
        )}
      </div>
      {expanded && isPerTable && (
        <div style={{ ...styles.expandWrap, borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
          {check.perTable.length === 0 ? (
            <div style={styles.expandEmpty}>
              {t('execution.preflight.aggregate.noTables')}
            </div>
          ) : (
            check.perTable.map((row) => (
              <div key={row.table} style={styles.expandRow}>
                <StatusDot status={row.status} small />
                <span style={styles.expandTable}>{row.table}</span>
                <span style={{ ...styles.expandDetail, color: detailColor(row.status) }}>{t(row.detailKey, row.detailVars)}</span>
                {/* fixIsProjectWide なチェック (例: csv-arrived) は per-table Fix を出さない —
                    全 fail 行が同じ project-wide 設定画面に飛ぶので冗長. aggregate Fix だけ残す. */}
                {row.status === 'fail' && showFix && onFix && !check.fixIsProjectWide ? (
                  <button
                    type="button"
                    style={styles.fixBtnSmall}
                    onClick={(e) => { e.stopPropagation(); onFix(check, row.table); }}
                    title={t('execution.preflight.fix')}
                  >
                    {t('execution.preflight.fix')}
                  </button>
                ) : <span style={styles.fixBtnSmallPlaceholder} />}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}

function StatusDot({ status, small }: { status: CheckStatus; small?: boolean }) {
  const color =
    status === 'pass' ? 'var(--green)' :
    status === 'fail' ? 'var(--red)' :
    'var(--text-4)';
  const size = small ? 7 : 9;
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block' }} />
  );
}

function aggregatePerTableLabel(
  t: T, pass: number, fail: number, skip: number, total: number,
): string {
  if (total === 0) return t('execution.preflight.aggregate.notRun');
  if (fail === 0 && skip === 0) return t('execution.preflight.aggregate.allPass', { n: total });
  if (fail === 0 && skip > 0) return t('execution.preflight.aggregate.skipped', { skip, total });
  return t('execution.preflight.aggregate.mixed', { pass, fail, total });
}

function aggregateProjectLabel(t: T, status: CheckStatus): string {
  switch (status) {
    case 'pass': return t('execution.preflight.aggregate.statusPass');
    case 'fail': return t('execution.preflight.aggregate.statusFail');
    case 'skip': return t('execution.preflight.aggregate.statusSkip');
  }
}

function detailColor(s: CheckStatus): string {
  if (s === 'fail') return 'var(--red)';
  if (s === 'skip') return 'var(--text-4)';
  return 'var(--text-2)';
}

const styles: Record<string, React.CSSProperties> = {
  container: { border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel)' },
  emptyContainer: { border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel)' },
  emptyText: { padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-3)' },
  row: {
    display: 'grid',
    gridTemplateColumns: '14px 260px 1fr 24px auto',
    alignItems: 'center', gap: 12,
    padding: '8px 14px',
  },
  title: { fontSize: 12, fontWeight: 500 },
  detailInline: { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' },
  chev: {
    color: 'var(--text-2)', fontSize: 16, fontWeight: 700,
    width: 24, textAlign: 'center', lineHeight: 1,
    userSelect: 'none',
  },
  fixBtn: {
    padding: '3px 8px', border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-2)', borderRadius: 3, fontSize: 11, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  fixBtnPlaceholder: { width: 1, height: 1 },
  expandWrap: { padding: '6px 0 6px 0', background: 'var(--panel-2)' },
  expandRow: {
    display: 'grid',
    gridTemplateColumns: '32px 240px 1fr auto',
    alignItems: 'center', gap: 10,
    padding: '4px 14px',
  },
  expandTable: { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' },
  expandDetail: { fontFamily: 'var(--mono)', fontSize: 11 },
  expandEmpty: { padding: '6px 14px', fontSize: 11, color: 'var(--text-3)' },
  fixBtnSmall: {
    padding: '2px 7px', border: '1px solid var(--border)', background: 'var(--panel)',
    color: 'var(--text-2)', borderRadius: 3, fontSize: 10, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  fixBtnSmallPlaceholder: { width: 1, height: 1 },
};
