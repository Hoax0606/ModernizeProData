import React, { useEffect, useState } from 'react';
import { validationApi, type ValidationDiffSampleDto } from '../api/validation';

/**
 * Validation drill-down 모달 — Data Integrity Check (SHA-256) FAIL 시 어느 row 가 다른지
 * row-by-row 표시. ArtifactsPage 의 Validation 카테고리에서 trigger.
 *
 * BE: GET /api/v1/runs/{runId}/validation/{bindingId}/diff-sample
 * 한 요청당 최대 200 row (BE 부담 제한). 페이지네이션은 후속 라운드.
 */
interface Props {
  open: boolean;
  runId: string | null;
  bindingId: string | null;
  tobeTable: string;
  onClose: () => void;
}

export function ValidationDiffModal({ open, runId, bindingId, tobeTable, onClose }: Props) {
  const [data, setData] = useState<ValidationDiffSampleDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !runId || !bindingId) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    validationApi.getDiffSample(runId, bindingId, 50)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, runId, bindingId]);

  if (!open) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Row Diff — {tobeTable}</div>
            <div style={styles.subtitle}>
              {loading
                ? 'Loading row diff…'
                : data
                  ? `${data.totalDiff} diff row${data.totalDiff === 1 ? '' : 's'} found`
                    + (data.pkColumns.length > 0 ? ` · PK: ${data.pkColumns.join(', ')}` : '')
                    + (data.rows.length < data.totalDiff
                       ? ` · showing first ${data.rows.length}`
                       : '')
                  : ''}
            </div>
          </div>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">×</button>
        </div>

        {data?.note && <div style={styles.note}>{data.note}</div>}
        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.body}>
          {loading && <div style={styles.empty}>Loading…</div>}
          {!loading && data && data.rows.length === 0 && !error && (
            <div style={styles.empty}>
              {data.note ? '—' : 'No diff rows found.'}
            </div>
          )}
          {!loading && data && data.rows.length > 0 && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>PK</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Column</th>
                  <th style={styles.th}>ASIS Value (DuckDB)</th>
                  <th style={styles.th}>TOBE Value (PG)</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.flatMap((row, ri) => {
                  const pkStr = row.pk.map((p) => String(p ?? '')).join(' / ');
                  const statusLabel =
                      row.status === 'asis-only' ? 'ASIS only (missing in TOBE)'
                    : row.status === 'tobe-only' ? 'TOBE only (unexpected in TOBE)'
                    : 'Value differs';
                  const statusColor =
                      row.status === 'asis-only' ? 'var(--red)'
                    : row.status === 'tobe-only' ? 'var(--amber)'
                    : 'var(--red)';

                  if (row.diffs.length === 0) {
                    return [
                      <tr key={`r-${ri}`} style={styles.row}>
                        <td style={styles.td}>{pkStr}</td>
                        <td style={{ ...styles.td, color: statusColor }}>{statusLabel}</td>
                        <td style={styles.td} colSpan={3}>—</td>
                      </tr>,
                    ];
                  }
                  return row.diffs.map((d, di) => (
                    <tr key={`r-${ri}-${di}`} style={styles.row}>
                      {di === 0 && <td style={styles.td} rowSpan={row.diffs.length}>{pkStr}</td>}
                      {di === 0 && (
                        <td style={{ ...styles.td, color: statusColor }} rowSpan={row.diffs.length}>
                          {statusLabel}
                        </td>
                      )}
                      <td style={styles.td}>{d.column}</td>
                      <td style={styles.tdMono}>{fmt(d.asisValue)}</td>
                      <td style={styles.tdMono}>{fmt(d.tobeValue)}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '(null)';
  return String(v);
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--panel)',
    borderRadius: 8,
    width: '85vw',
    maxWidth: 1200,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
    border: '1px solid var(--border)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '16px 20px',
    borderBottom: '1px solid var(--border)',
  },
  title: { fontSize: 16, fontWeight: 600, color: 'var(--text)' },
  subtitle: {
    fontSize: 11,
    color: 'var(--text-3)',
    marginTop: 4,
    fontFamily: 'var(--mono)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 24,
    cursor: 'pointer',
    color: 'var(--text-2)',
    lineHeight: 1,
    padding: '0 4px',
  },
  body: { flex: 1, overflow: 'auto', padding: '12px 20px' },
  empty: { padding: 40, textAlign: 'center', color: 'var(--text-3)' },
  error: {
    padding: '8px 16px',
    color: 'var(--red)',
    background: 'var(--red-50)',
    margin: '8px 20px',
    borderRadius: 4,
    fontSize: 12,
  },
  note: {
    padding: '8px 16px',
    color: 'var(--amber)',
    background: 'var(--amber-50)',
    margin: '8px 20px',
    borderRadius: 4,
    fontSize: 12,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
  },
  row: { borderBottom: '1px solid var(--border)' },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    background: 'var(--panel-2, #f6f5f3)',
    borderBottom: '1px solid var(--border-strong)',
    fontWeight: 600,
    color: 'var(--text-2)',
    position: 'sticky',
    top: 0,
  },
  td: { padding: '6px 12px', verticalAlign: 'top', color: 'var(--text)' },
  tdMono: {
    padding: '6px 12px',
    verticalAlign: 'top',
    fontFamily: 'var(--mono)',
    color: 'var(--text)',
    wordBreak: 'break-all',
  },
};
