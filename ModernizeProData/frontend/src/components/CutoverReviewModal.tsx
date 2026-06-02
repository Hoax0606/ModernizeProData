import { useState } from 'react';
import { Modal } from './Modal';
import { useT } from '../i18n';
import type { QuarantineGroup } from '../pages/quarantineMock';

/**
 * Cutover review modal (정책 4·8 — 2026-06-01).
 *
 * Cutover Start 클릭 직후 표시. rehearsal phase 에서 ack 된 WARN group 목록을
 * 보여주고 운영자가 group 별로 confirm/reject. [Confirm & Start cutover] 클릭 시:
 *   1. FE 가 onConfirm() 호출 (parent 가 startrun + confirmCutoverReview 전송)
 *   2. confirmed group 은 cutover phase 의 ack 로 BE 에 추가 저장
 *   3. rejected group 은 cutover ack 추가 안 됨 → cutover validation 에서 다시
 *      failed_with_pending_warnings 로 멈춤 → LogViewer 에서 운영자가 다시 ack
 *
 * 즉 reject 는 "이 group 은 다시 봐야 함" 표시. 운영자가 한 번 더 confirm 절차.
 */
export interface CutoverReviewItem {
  bindingId: string;
  ruleName: string;
  reason: string;
  tableName: string;
  rowCount: number;
  acknowledgedBy: string;
  acknowledgedAt: string;
}

function itemKey(it: CutoverReviewItem): string {
  return it.bindingId + '|' + it.ruleName + '|' + it.reason;
}

/** QuarantineGroup[] 에서 ack 있는 entry 들을 (binding, rule, reason) 단위로 dedupe. */
export function buildReviewItems(groups: QuarantineGroup[]): CutoverReviewItem[] {
  const seen = new Map<string, CutoverReviewItem>();
  for (const g of groups) {
    if (!g.ack || !g.bindingId) continue;
    const item: CutoverReviewItem = {
      bindingId: g.bindingId,
      ruleName: g.stage,
      reason: g.reason,
      tableName: g.table,
      rowCount: g.rowCount,
      acknowledgedBy: g.ack.acknowledgedBy,
      acknowledgedAt: g.ack.acknowledgedAt,
    };
    seen.set(itemKey(item), item);
  }
  return Array.from(seen.values());
}

interface Props {
  open: boolean;
  items: CutoverReviewItem[];
  /** Confirm & Start — confirmed Set 을 받아 startrun + confirmCutoverReview. */
  onConfirm: (confirmed: Set<string>, note: string | null) => Promise<void>;
  onClose: () => void;
}

export function CutoverReviewModal({ open, items, onConfirm, onClose }: Props) {
  const t = useT();
  /** key = itemKey(it). 기본 = 모두 confirmed. 운영자가 체크 해제 시 reject. */
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set(items.map(itemKey)));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) => {
    setConfirmed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(confirmed, note || null);
    } catch (e: unknown) {
      console.error('cutover review confirm failed', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmedCount = confirmed.size;
  const rejectedCount = items.length - confirmedCount;

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={t('cutoverReview.modal.title')} width={680}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
          {t('cutoverReview.modal.desc')}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 3, maxHeight: 320, overflowY: 'auto', marginBottom: 12 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
                <th style={th}>{t('cutoverReview.modal.col.confirm')}</th>
                <th style={th}>{t('cutoverReview.modal.col.table')}</th>
                <th style={th}>{t('cutoverReview.modal.col.rule')}</th>
                <th style={th}>{t('cutoverReview.modal.col.reason')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{t('cutoverReview.modal.col.rows')}</th>
                <th style={th}>{t('cutoverReview.modal.col.ackBy')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const k = itemKey(it);
                const checked = confirmed.has(k);
                return (
                  <tr key={k} style={{ borderBottom: '1px solid var(--border)', opacity: checked ? 1 : 0.5 }}>
                    <td style={td}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggle(k)}
                      />
                    </td>
                    <td style={td}>{it.tableName}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{it.ruleName}</td>
                    <td style={td}>{it.reason}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{it.rowCount}</td>
                    <td style={{ ...td, color: 'var(--text-3)', fontSize: 11 }}>{it.acknowledgedBy}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, color: 'var(--text-3)', textAlign: 'center', padding: 20 }}>
                  {t('cutoverReview.modal.empty')}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>
          {t('cutoverReview.modal.summary', {
            confirmed: String(confirmedCount),
            rejected: String(rejectedCount),
          })}
        </div>
        <label style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
          {t('cutoverReview.modal.noteLabel')}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('cutoverReview.modal.notePlaceholder')}
          rows={2}
          disabled={busy}
          style={{
            width: '100%', fontFamily: 'inherit', fontSize: 12,
            border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)',
            padding: 8, borderRadius: 3, resize: 'vertical', boxSizing: 'border-box', marginBottom: 12,
          }}
        />
        {error && <div style={{ color: '#c92a3f', fontSize: 12, marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '6px 14px', fontSize: 12,
              border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)',
              borderRadius: 3, cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {t('cutoverReview.modal.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy}
            style={{
              padding: '6px 14px', fontSize: 12,
              border: '1px solid var(--navy)', background: 'var(--navy)', color: '#fff',
              borderRadius: 3, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            {t('cutoverReview.modal.confirmAndStart')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
};
const td: React.CSSProperties = {
  padding: '6px 8px', fontSize: 12, color: 'var(--text)', verticalAlign: 'top',
};
