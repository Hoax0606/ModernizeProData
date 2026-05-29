import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useWorkspaceStore, type ProjectPhase } from '../store/workspace';
import { useSnapshotsStore, usePinnedSnapshotsStore, isPinEligible, type SnapshotStatus, type SnapshotType } from '../store/snapshots';
import { useAuthStore } from '../store/auth';
import { useActiveProjectReadOnly } from '../store/readOnly';
import { useAuditLogStore } from '../store/auditLog';
import { useExecutionPreflightStore, type PreflightSnapshotResult } from '../store/executionPreflight';
import { useTobeDdlStore } from '../store/tobeDdl';
import { isAllPass } from '../lib/preflightValidation';
import { useT, type TranslationKey } from '../i18n';

/**
 * Versions tab — 매핑 스냅샷 관리.
 *  - 스냅샷 생성 = commit (draft 상태, 로컬 rollback 지점)
 *  - Request = coordinator 에게 승인 요청 (draft → pending)
 *  - Approve / Reject 는 All Projects → Approvals 에서만 처리
 */
export function VersionsPage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const readOnly = useActiveProjectReadOnly();

  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  /* Per-snapshot preflight result cache — populated by Execution page only.
     Versions reads it as a gate for Request Review.  Fallback は undefined にして
     매 render 마다 새 reference 가 되는 무한 루프 회피. */
  const preflightBySnapshot = useExecutionPreflightStore(
    (s) => activeProjectId ? s.byProject[activeProjectId]?.bySnapshot : undefined,
  ) as Record<string, PreflightSnapshotResult> | undefined;

  /* TO-BE DDL — Request Review ゲートで「cache が全テーブル覆ってるか」を判定するのに必要.
     Execution 側でも同じ store を使っているのでキャッシュヒットが期待できる. */
  const tobeSchema = useTobeDdlStore((s) => activeProjectId ? s.schemasByProject[activeProjectId] : undefined);
  const fetchTobeDdl = useTobeDdlStore((s) => s.fetch);
  useEffect(() => {
    if (!activeProjectId) return;
    if (!tobeSchema) fetchTobeDdl(activeProjectId).catch(() => { /* DDL 미등록 — 게이트가 잠긴 채로 표시 */ });
  }, [activeProjectId, tobeSchema, fetchTobeDdl]);
  const allTobeTableNames = useMemo(
    () => (tobeSchema?.tables ?? []).map((t) => t.table.physicalName),
    [tobeSchema],
  );

  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchByProject = useSnapshotsStore((s) => s.fetchByProject);
  const pinnedIds = usePinnedSnapshotsStore((s) => s.pinnedIds);
  const togglePin = usePinnedSnapshotsStore((s) => s.togglePin);
  const snapshots = useMemo(() => {
    const list = allSnapshots
      .filter((s) => s.projectId === activeProjectId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // pinned 가 상단에. 둘 다 같은 그룹 안에서는 최신순 유지
    return list.sort((a, b) => {
      const ap = pinnedIds.includes(a.id) ? 1 : 0;
      const bp = pinnedIds.includes(b.id) ? 1 : 0;
      return bp - ap;
    });
  }, [allSnapshots, activeProjectId, pinnedIds]);
  const createSnapshot = useSnapshotsStore((s) => s.createSnapshot);
  const requestSnapshot = useSnapshotsStore((s) => s.requestSnapshot);
  const deleteSnapshot = useSnapshotsStore((s) => s.deleteSnapshot);

  // 마운트 시 + 프로젝트 변경 시 서버에서 fetch
  useEffect(() => {
    if (activeProjectId) {
      void fetchByProject(activeProjectId);
    }
  }, [activeProjectId, fetchByProject]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<SnapshotType>('mapping');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [descError, setDescError] = useState('');
  const nameRef = useRef<HTMLTextAreaElement | null>(null);
  const descRef = useRef<HTMLTextAreaElement | null>(null);

  // Snapshot name / Description 박스가 줄넘김에 따라 자동 확장
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [newName, createOpen]);

  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // textareaDesc.maxHeight (160) 까지만 자라고, 그 이후는 내부 스크롤
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [newDesc, createOpen]);

  // Description 입력 규칙: 같은 글자 10번 이상 연속 금지. 그 외 길이/줄바꿈 제한 없음 —
  // 좌측 카드에 description 미리보기가 없어졌으므로 첫 줄을 강제로 끊을 이유도 없다.
  const handleDescChange = (raw: string) => {
    if (/(.)\1{9,}/.test(raw)) {
      setDescError(t('versions.descError.repeat'));
      return;
    }
    setDescError('');
    setNewDesc(raw);
  };

  // cutover snapshot 확인 다이얼로그
  const [cutoverConfirmOpen, setCutoverConfirmOpen] = useState(false);

  // 선택된 스냅샷
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const selectedSnapshot = useMemo(
    () => snapshots.find((s) => s.id === selectedSnapshotId) ?? null,
    [snapshots, selectedSnapshotId],
  );

  /* Request Review ゲート用に 3 つの flag を計算:
     - exists: その snapshot に対して preflight cache がある
     - passed: cache の全 check が pass
     - coversAll: cache の selectedTables が DDL の全 TO-BE テーブルを覆っている
     仕様: 3 つ全部 true でないと Request Review 不可. */
  const requestReviewGate = useMemo(() => {
    if (!selectedSnapshot) return { exists: false, passed: false, coversAll: false };
    const cached = preflightBySnapshot?.[selectedSnapshot.id];
    const exists = !!cached;
    const passed = !!cached && isAllPass(cached.results);
    const coversAll = !!cached
      && allTobeTableNames.length > 0
      && allTobeTableNames.every((name) => cached.selectedTables.includes(name));
    return { exists, passed, coversAll };
  }, [selectedSnapshot, preflightBySnapshot, allTobeTableNames]);

  // 페이지 첫 진입 시 한 번만 최신 snapshot 자동 선택.
  // polling / 외부 변경으로 snapshots 가 갱신돼도 사용자가 보고 있던 화면을 강제 전환하지 않음
  // (사용자가 row 를 누르거나 새 스냅샷 생성 시에만 selectedSnapshotId 변경).
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (snapshots.length === 0) return;
    setSelectedSnapshotId(snapshots[0].id);
    initializedRef.current = true;
  }, [snapshots]);
  // 프로젝트 전환 시 다시 자동 선택되도록 reset
  useEffect(() => {
    initializedRef.current = false;
    setSelectedSnapshotId(null);
  }, [activeProjectId]);

  // 알림 클릭으로 들어왔을 때 location.state.selectSnapshotId 로 지정된 스냅샷을 자동 선택.
  // - dependency 에서 `snapshots` 제거: 10초 polling 으로 snapshots 갱신될 때 effect 가 재실행되어
  //   사용자가 클릭하지 않은 snapshot 으로 강제 이동되는 것 방지.
  // - location.key 마다 1회만 처리되도록 ref 가드.
  // - 처리한 뒤 location.state 즉시 클리어 (history.replaceState 가 비동기일 수 있어 ref 가 1차 가드).
  const location = useLocation();
  const handledLocationKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (handledLocationKeyRef.current === location.key) return;
    const st = location.state as { selectSnapshotId?: string | null } | null;
    const targetId = st?.selectSnapshotId;
    if (!targetId) {
      handledLocationKeyRef.current = location.key;
      return;
    }
    setSelectedSnapshotId(targetId);
    initializedRef.current = true;
    handledLocationKeyRef.current = location.key;
    window.history.replaceState({}, '');
  }, [location.key]);

  // AUDIT LOG 접기/펼치기 상태
  const [auditLogExpanded, setAuditLogExpanded] = useState(true);

  // Audit Log — store 에서 가져옴 (localStorage 영속, 페이지 이동에도 보존)
  const allAuditLogs = useAuditLogStore((s) => s.logs);
  const addAuditLogEntry = useAuditLogStore((s) => s.add);
  const clearAuditLogByProject = useAuditLogStore((s) => s.clearByProject);
  const auditLogs = useMemo(
    () => allAuditLogs.filter((l) => l.projectId === activeProjectId),
    [allAuditLogs, activeProjectId],
  );

  // rehearsal 이후 phase 에서만 cutover snapshot 생성 가능
  const POST_REHEARSAL: ProjectPhase[] = ['rehearsal', 'ready', 'cutover', 'hypercare', 'done'];
  const canCreateCutover = project ? POST_REHEARSAL.includes(project.phase) : false;

  // Audit Log 추가 함수
  const addAuditLog = (
    action: string,
    description: string,
    snapshotName?: string,
    snapshotId?: string,
    snapshotType?: 'mapping' | 'cutover',
  ) => {
    if (!activeProjectId) return;
    addAuditLogEntry({
      projectId: activeProjectId,
      user: user?.username || 'Unknown',
      action,
      description,
      snapshotName,
      snapshotId,
      snapshotType,
    });
  };

  if (!project) {
    return (
      <div>
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>{t('versions.empty.noProject')}</div>
        </div>
      </div>
    );
  }

  const resetCreate = () => {
    setCreateOpen(false);
    setCreateType('mapping');
    setNewName('');
    setNewDesc('');
    setDescError('');
  };

  const openCreate = (type: SnapshotType) => {
    if (type === 'cutover') {
      setCutoverConfirmOpen(true);
      return;
    }
    setCreateType(type);
    setCreateOpen(true);
  };

  const handleCutoverConfirm = () => {
    setCutoverConfirmOpen(false);
    setCreateType('cutover');
    setCreateOpen(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    
    try {
      const newSnapshot = await createSnapshot(project.id, {
        name,
        type: createType,
        description: newDesc.trim() || undefined,
      });

      // 방금 만든 snapshot 을 자동 선택
      setSelectedSnapshotId(newSnapshot.id);

      // Audit log 기록 (description 이 있으면 전체 포함)
      const actionLabel = createType === 'cutover' ? 'Cutover Snapshot created' : 'Snapshot created';
      const desc = newDesc.trim();
      const auditDesc = desc
        ? `Created new ${createType} snapshot: ${name}\n${desc}`
        : `Created new ${createType} snapshot: ${name}`;
      addAuditLog(actionLabel, auditDesc, newSnapshot.version || 'v1.0', newSnapshot.id, createType);

      resetCreate();
    } catch (error) {
      console.error('Failed to create snapshot:', error);
      const failLabel = createType === 'cutover' ? 'Cutover Snapshot creation failed' : 'Snapshot creation failed';
      addAuditLog(failLabel, `Failed to create snapshot: ${name}`);
    }
  };

  const handleRequest = async (id: string) => {
    try {
      await requestSnapshot(id);

      // Audit log 기록
      const snapshot = snapshots.find(s => s.id === id);
      addAuditLog(
        'approval requested',
        `Requested approval for snapshot: ${snapshot?.name}`,
        snapshot?.version,
        snapshot?.id,
        snapshot?.type ?? 'mapping',
      );

      // Phase 전환은 approve 시점에 처리 (ApprovalsPage)
    } catch (error) {
      console.error('Failed to request approval:', error);
      addAuditLog('request failed', `Failed to request approval for snapshot: ${snapshots.find(s => s.id === id)?.name}`);
    }
  };

  return (
    <div>
      <div style={styles.toolbar}>
        <div style={{ flex: 1 }} />
        {!createOpen && (
          <>
            <button
              onClick={() => openCreate('mapping')}
              style={{ ...styles.btnPrimary, ...(readOnly ? styles.btnDisabled : {}) }}
              disabled={readOnly}
            >
              {t('versions.create')}
            </button>
            <button
              onClick={() => openCreate('cutover')}
              style={{ ...styles.btnCutover, ...(readOnly ? styles.btnDisabled : {}) }}
              disabled={readOnly}
            >
              {t('versions.createCutover')}
            </button>
            {snapshots.length > 0 && (
              <button
                onClick={async () => {
                  if (!confirm('Delete all snapshots in this project?')) return;
                  for (const s of snapshots) await deleteSnapshot(s.id);
                  if (activeProjectId) clearAuditLogByProject(activeProjectId);
                }}
                style={{ ...styles.btnGhost, color: 'var(--red)', borderColor: 'var(--red)', ...(readOnly ? styles.btnDisabled : {}) }}
                disabled={readOnly}
              >
                Delete all ({snapshots.length})
              </button>
            )}
          </>
        )}
      </div>

      {/* Cutover snapshot 확인 다이얼로그 */}
      {cutoverConfirmOpen && (
        <div style={styles.cutoverConfirm}>
          <div style={styles.cutoverConfirmTitle}>{t('versions.cutoverConfirm.title')}</div>
          <div style={styles.cutoverConfirmDesc}>{t('versions.cutoverConfirm.desc')}</div>
          <div style={styles.cutoverConfirmActions}>
            <button onClick={handleCutoverConfirm} style={{ ...styles.btnCutover, ...(readOnly ? styles.btnDisabled : {}) }} disabled={readOnly}>{t('versions.cutoverConfirm.proceed')}</button>
            <button onClick={() => setCutoverConfirmOpen(false)} style={styles.btnGhost}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {createOpen && (
        <form onSubmit={handleCreate} style={{
          ...styles.createForm,
          ...(createType === 'cutover' ? {
            background: 'var(--red-50)',
            borderColor: 'var(--red)',
          } : {}),
        }}>
          <div style={styles.createHeader}>
            <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--mono)', color: createType === 'cutover' ? 'var(--red)' : 'var(--navy)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {createType === 'cutover' ? t('versions.type.cutover') : t('versions.type.mapping')} snapshot
            </div>
            <div style={styles.createActions}>
              <button type="submit" style={{ ...styles.btnPrimary, ...(newName.trim() && !readOnly ? {} : styles.btnDisabled) }} disabled={!newName.trim() || readOnly}>
                {t('versions.create.submit')}
              </button>
              <button type="button" onClick={resetCreate} style={styles.btnGhost}>
                {t('versions.cancelCreate')}
              </button>
            </div>
          </div>
          <div style={styles.createStack}>
            <Field label={t('versions.create.name')}>
              <textarea
                ref={nameRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('versions.create.namePh')}
                style={styles.input}
                autoFocus
                required
                rows={1}
              />
            </Field>
            <Field label={t('versions.create.desc')}>
              <div style={{ position: 'relative', width: '100%' }}>
                <textarea
                  ref={descRef}
                  value={newDesc}
                  onChange={(e) => handleDescChange(e.target.value)}
                  style={styles.textareaDesc}
                  rows={2}
                />
                {!newDesc && (
                  <div style={styles.textareaPlaceholder}>
                    {t('versions.create.descPh')}
                  </div>
                )}
                {descError && <div style={styles.descError}>{descError}</div>}
              </div>
            </Field>
          </div>
        </form>
      )}

      <div style={styles.mainContent}>
        {/* 왼쪽: 스냅샷 목록 */}
        <div style={styles.snapshotsList}>
          <div style={styles.snapshotsHeader}>
            <h3 style={styles.snapshotsTitle}>Snapshots</h3>
            <div style={styles.snapshotsCount}>{snapshots.length} versions</div>
          </div>
          
          {snapshots.length === 0 ? (
            <div style={styles.emptySnapshots}>
              <div style={styles.emptySnapshotsTitle}>No snapshots yet</div>
              <div style={styles.emptySnapshotsDesc}>Create your first snapshot to start version control</div>
            </div>
          ) : (
            <div style={styles.snapshotsContainer}>
              {snapshots.map((s) => {
                const isSelected = selectedSnapshotId === s.id;
                const isPinned = pinnedIds.includes(s.id);

                return (
                  <div
                    key={s.id}
                    style={{
                      ...styles.snapshotItem,
                      ...(isSelected ? styles.snapshotItemSelected : {}),
                      position: 'relative',
                    }}
                    onClick={() => {
                      setSelectedSnapshotId(s.id);
                    }}
                  >
                    {isPinned && (
                      <span style={styles.pinIcon} title={t('versions.pin.iconAria')} aria-label={t('versions.pin.iconAria')}>
                        <PinIconSvg />
                      </span>
                    )}
                    <div style={styles.snapshotItemHeader}>
                      <div style={styles.snapshotVersion}>
                        {s.version || `v1.${snapshots.length - snapshots.indexOf(s) - 1}`}
                        {s.type === 'cutover' && (
                          <span style={styles.cutoverTag}>Cutover snapshot</span>
                        )}
                        {s.status !== 'draft' && (
                          <span style={{ ...styles.statusBadgeSmall, ...statusTone(s.status) }}>
                            {s.status.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <div style={styles.snapshotItemName}>{s.name}</div>

                    {/* description 은 우측 상세 패널에서만 보여줌 — 좌측 카드에는 표시 안 함 */}

                    <div style={styles.snapshotItemMeta}>
                      <span>{s.createdBy}</span>
                      <span>·</span>
                      <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 오른쪽: 선택된 스냅샷 상세 정보 */}
        <div style={styles.detailPanel}>
          {selectedSnapshot ? (
            <SnapshotDetailView
              snapshot={selectedSnapshot}
              onRequest={() => handleRequest(selectedSnapshot.id)}
              readOnly={readOnly}
              isPinned={pinnedIds.includes(selectedSnapshot.id)}
              pinEligible={isPinEligible(selectedSnapshot, project.phase)}
              onTogglePin={() => togglePin(selectedSnapshot.id)}
              preflightResultExists={requestReviewGate.exists}
              preflightPassed={requestReviewGate.passed}
              preflightCoversAllTables={requestReviewGate.coversAll}
            />
          ) : (
            <div style={styles.noSelectionMessage}>
              <div style={styles.noSelectionTitle}>Select a snapshot</div>
              <div style={styles.noSelectionDesc}>Choose a snapshot from the list to view its details and current status</div>
            </div>
          )}
        </div>
      </div>

      {/* Version 페이지 하단 Audit Log */}
      <div style={styles.auditLogSection}>
        <div 
          onClick={() => setAuditLogExpanded(!auditLogExpanded)}
          style={styles.auditLogHeader}
        >
          <span style={styles.auditLogArrow}>{auditLogExpanded ? '▾' : '▸'}</span>
          <h3 style={styles.auditLogSectionTitle}>AUDIT LOG ({auditLogs.length})</h3>
        </div>
        {auditLogExpanded && (
          <div style={styles.auditLogContainer}>
            <AuditLogEntries auditLogs={auditLogs} />
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_KEY: Record<SnapshotStatus, TranslationKey> = {
  draft:    'versions.status.draft',
  pending:  'versions.status.pending',
  approved: 'versions.status.approved',
  rejected: 'versions.status.rejected',
};

function statusTone(s: SnapshotStatus): React.CSSProperties {
  switch (s) {
    case 'draft':    return { background: 'var(--panel-2)', color: 'var(--text-3)', borderColor: 'var(--border-strong)' };
    case 'pending':  return { background: 'var(--amber-50)', color: 'var(--amber)', borderColor: 'var(--amber)' };
    case 'approved': return { background: 'var(--green-50)', color: 'var(--green)', borderColor: 'var(--green)' };
    case 'rejected': return { background: 'var(--red-50)',   color: 'var(--red)',   borderColor: 'var(--red)' };
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={styles.th}>{children}</th>;
}

export function PinIconSvg({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      {children}
    </div>
  );
}

function ChangeRow({ kind, category, rawKey, detail, fieldChanges }: {
  kind: 'added' | 'modified' | 'removed';
  category: 'rule' | 'binding' | 'codeMap';
  /** 백엔드 key 원본 (schema.table.column / schema.table / domain:sourceValue) */
  rawKey: string;
  detail: string;
  fieldChanges?: Array<{ field: string; before: string; after: string }> | null;
}) {
  const t = useT();
  // 헤더에 표시할 이름 — rule 은 schema.table.column 풀 경로 그대로.
  const displayName = rawKey;

  // 표시 대상은 asisColumn / transformSql 두 필드만.
  // 옛 snapshot 의 changes JSON 이 4 필드(asisSchema/Table 포함) 로 박제돼 있을 수도 있어
  // frontend 에서 필터링 — 옛/새 snapshot 무관하게 동일한 화면.
  const fields = (fieldChanges ?? []).filter(
    (fc) => fc.field === 'asisColumn' || fc.field === 'transformSql'
  );

  // "사실상 삭제" detect — mapping page 에서 초기화하면 row 는 남고 값만 비워짐.
  // backend 는 MODIFIED 로 보내지만, 모든 after 가 (unassigned) 이면 UI 는 DELETED 로.
  const isEffectivelyDeleted =
    kind === 'modified'
    && fields.length > 0
    && fields.every((f) => f.after === '(unassigned)');
  const effectiveKind: 'added' | 'modified' | 'removed' =
    isEffectivelyDeleted ? 'removed' : kind;

  const palette = effectiveKind === 'added'
    ? { color: 'var(--green)', bg: 'var(--green-50)', symbol: '+', label: t('versions.changes.status.added') }
    : effectiveKind === 'removed'
      ? { color: 'var(--red)', bg: 'var(--red-50)', symbol: '−', label: t('versions.changes.status.deleted') }
      : { color: 'var(--amber)', bg: 'var(--amber-50)', symbol: '~', label: t('versions.changes.status.modified') };

  // ADDED, MODIFIED 만 토글 가능. DELETED 는 펼침 영역 없음 (헤더만).
  const canExpand = fields.length > 0 && effectiveKind !== 'removed';

  // backend 의 field 식별자 → 사용자에게 보여줄 라벨 (i18n)
  const fieldLabel = (f: string): string => {
    switch (f) {
      case 'asisColumn':   return t('versions.changes.field.asisColumn');
      case 'transformSql': return t('versions.changes.field.rule');
      default:             return f;
    }
  };

  // backend 의 sentinel "(unassigned)" 를 현재 언어로 치환
  const valueLabel = (v: string): string =>
    v === '(unassigned)' ? t('versions.changes.unassigned') : v;

  // 헤더 우측 라벨 — backend detail 을 신뢰하지 않고 client-side 재계산.
  // ADDED/DELETED 는 라벨 없음 (화살표만). MODIFIED 는 변경 항목에 따라.
  const headerLabel = (() => {
    if (effectiveKind === 'added' || effectiveKind === 'removed') return '';
    if (effectiveKind === 'modified') {
      const hasCol = fields.some((f) => f.field === 'asisColumn');
      const hasSql = fields.some((f) => f.field === 'transformSql');
      if (hasCol && hasSql) return t('versions.changes.label.both');
      if (hasCol)           return t('versions.changes.label.column');
      if (hasSql)           return t('versions.changes.label.rule');
      return detail; // fallback
    }
    return detail;
  })();

  // 기본은 접힌 상태. 헤더 클릭 시 토글.
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      borderLeft: `3px solid ${palette.color}`,
      background: 'var(--panel)',
      fontFamily: 'var(--mono)',
    }}>
      {/* 헤더 — 좌측: [symbol][BADGE][displayName], 우측: [detail][▶]. canExpand 면 클릭 토글. */}
      <div
        onClick={canExpand ? () => setExpanded((x) => !x) : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px 6px 10px',
          cursor: canExpand ? 'pointer' : 'default',
          userSelect: canExpand ? 'none' : 'auto',
        }}
      >
        <span style={{ ...styles.changeSymbol, color: palette.color }}>
          {palette.symbol}
        </span>
        <span style={{
          ...styles.changeBadgePill,
          background: palette.bg,
          color: palette.color,
          borderColor: palette.color,
        }}>
          {palette.label}
        </span>
        <span style={styles.changeTable}>{displayName}</span>
        {/* 우측: detail (의미적 라벨) + 토글 화살표 */}
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-3)',
            fontSize: 11,
          }}
        >
          {headerLabel && <span>{headerLabel}</span>}
          {canExpand && (
            <span
              style={{
                display: 'inline-block',
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease',
                fontSize: 10,
              }}
            >
              ▶
            </span>
          )}
        </span>
      </div>

      {/* 펼친 sub-row 영역 — 가로 스크롤 가능 */}
      {canExpand && expanded && (
        <div
          style={{
            borderTop: '1px dashed var(--border)',
            background: 'var(--panel-2)',
            overflowX: 'auto',  // 긴 텍스트는 좌우 스크롤로 확인
          }}
        >
          {/*
            단일 grid 컨테이너에 모든 행의 cell 을 펼침 — column 폭이 전체 max-content
            기준으로 통일되어 화살표 / after 가 세로로 정확히 정렬됨.
            (이전엔 각 행이 독립 grid 라 column 폭이 행마다 달라져 들쭉날쭉했음.)
          */}
          <div
            style={{
              padding: '6px 12px 8px 36px',
              display: 'grid',
              // col 3 이 'auto' 면 grid 가 남은 부모 폭을 그 col 에 몰아주어 화살표가
              // 늘어나 보임 → after 가 우측 끝으로 밀려남. 4 col 모두 content 만큼만:
              gridTemplateColumns: '130px max-content max-content max-content',
              alignItems: 'center',
              columnGap: 16,
              rowGap: 4,
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'nowrap',
              minWidth: 'max-content',
            }}
          >
            {fields.map((fc, i) => [
              <span key={`f-${i}`} style={{ color: 'var(--text-3)' }}>{fieldLabel(fc.field)}</span>,
              // before: 우측 정렬 — 짧은 텍스트도 화살표 바로 옆까지 붙음
              <span key={`b-${i}`} style={{ color: 'var(--text-3)', textAlign: 'right' }}>{valueLabel(fc.before)}</span>,
              <span key={`a-${i}`} style={{ color: 'var(--text-4)' }}>→</span>,
              // after: 좌측 정렬 (default) — 화살표 바로 옆에 붙음
              <span key={`v-${i}`} style={{ color: 'var(--text)', fontWeight: 500 }}>{valueLabel(fc.after)}</span>,
            ])}
          </div>
        </div>
      )}
    </div>
  );
}

function SnapshotDetailView({
  snapshot, onRequest, readOnly, isPinned, pinEligible, onTogglePin,
  preflightResultExists, preflightPassed, preflightCoversAllTables,
}: {
  snapshot: {
    id: string;
    name: string;
    version?: string;
    description?: string;
    status: SnapshotStatus;
    type?: SnapshotType;
    createdBy: string;
    createdAt: string;
    approvedBy?: string;
    approvedAt?: string;
    rejectedBy?: string;
    rejectedAt?: string;
    rejectionReason?: string;
    tableCount: number;
    ruleCount: number;
  };
  onRequest: () => void;
  readOnly?: boolean;
  isPinned: boolean;
  pinEligible: boolean;
  onTogglePin: () => void;
  /** Execution 画面でこの snapshot に対して preflight を走らせた結果が cache されているか. */
  preflightResultExists: boolean;
  /** その結果が all-pass か. */
  preflightPassed: boolean;
  /** cache の selectedTables が DDL の全 TO-BE テーブルを覆っているか. */
  preflightCoversAllTables: boolean;
}) {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const [confirmingRequest, setConfirmingRequest] = useState(false);

  /* Request Review ゲート: Execution 画面側で「全テーブル × 全 preflight pass」cache 必須.
     優先度: cache 不在 > 部分選択 > 失敗あり. */
  const requestBlockedReason = !preflightResultExists
    ? t('versions.preflight.notRun')
    : !preflightCoversAllTables
      ? t('versions.preflight.partialSelection')
      : !preflightPassed
        ? t('versions.preflight.blocked')
        : '';
  const canRequest = !readOnly && preflightPassed && preflightCoversAllTables;

  return (
    <div style={styles.detailContent}>
      {/* 헤더 */}
      <div style={styles.detailHeader}>
        <div style={styles.detailTitleSection}>
          <h2 style={styles.detailTitle}>{snapshot.name}</h2>
          <div style={styles.detailVersion}>
            {snapshot.version || 'v1.0'}
          </div>
          {snapshot.type === 'cutover' && (
            <span style={styles.cutoverTagLarge}>Cutover snapshot</span>
          )}
          {snapshot.status !== 'draft' && (
            <span style={{ ...styles.statusBadge, ...statusTone(snapshot.status) }}>
              {snapshot.status.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* 기본 정보 */}
      <div style={styles.detailSection}>
        <h3 style={styles.detailSectionTitle}>Information</h3>
        <div style={styles.detailGrid}>
          <div style={styles.detailGridItem}>
            <span style={styles.detailLabel}>Created by</span>
            <span style={styles.detailValue}>{snapshot.createdBy}</span>
          </div>
          <div style={styles.detailGridItem}>
            <span style={styles.detailLabel}>Created at</span>
            <span style={styles.detailValue}>{new Date(snapshot.createdAt).toLocaleString()}</span>
          </div>
          <div style={styles.detailGridItem}>
            <span style={styles.detailLabel}>Tables</span>
            <span style={styles.detailValue}>{snapshot.tableCount}</span>
          </div>
          <div style={styles.detailGridItem}>
            <span style={styles.detailLabel}>Rules</span>
            <span style={styles.detailValue}>{snapshot.ruleCount}</span>
          </div>
        </div>
      </div>

      {/* 설명 — 전체 표시 */}
      {snapshot.description && (
        <div style={styles.detailSection}>
          <h3 style={styles.detailSectionTitle}>Description</h3>
          <div style={styles.detailDescription}>{snapshot.description}</div>
        </div>
      )}

      {/* 승인 상태 (왼쪽 절반) + Pin 컨트롤 (오른쪽 절반) */}
      <div style={styles.detailSection}>
        <div style={styles.approvalRow}>
          <div style={styles.approvalCol}>
            <h3 style={styles.detailSectionTitle}>Approval Status</h3>
            <div style={styles.approvalSection}>
          {snapshot.status === 'draft' && (
            <div style={{
              ...styles.statusCard,
              ...(confirmingRequest ? {
                background: 'var(--green-50)',
                borderColor: 'var(--green)',
              } : {}),
            }}>
              <div style={styles.statusContent}>
                {/* 確認中はそのまま confirm prompt. 通常時は canRequest で
                    「準備完了 (緑)」と「ブロック理由 (amber)」を排他表示. */}
                {confirmingRequest ? (
                  <div style={styles.statusDesc}>
                    {t('versions.confirmRequestPre')}<b>{snapshot.name}</b>{t('versions.confirmRequestPost')}
                  </div>
                ) : canRequest ? (
                  <div style={styles.statusDesc}>
                    {t('versions.statusDesc.draftReady')}
                  </div>
                ) : (
                  <div style={{ ...styles.statusDesc, color: 'var(--amber)' }}>
                    ⚠ {requestBlockedReason}
                  </div>
                )}
              </div>
              {confirmingRequest ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => {
                      setConfirmingRequest(false);
                      onRequest();
                    }}
                    style={{ ...styles.btnPrimary, ...(canRequest ? {} : styles.btnDisabled) }}
                    disabled={!canRequest}
                    title={requestBlockedReason}
                  >
                    Confirm
                  </button>
                  <button onClick={() => setConfirmingRequest(false)} style={styles.btnGhost}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingRequest(true)}
                  style={{ ...styles.btnPrimary, ...(canRequest ? {} : styles.btnDisabled) }}
                  disabled={!canRequest}
                  title={requestBlockedReason}
                >
                  Request Review
                </button>
              )}
            </div>
          )}
          
          {snapshot.status === 'pending' && (
            <div style={{ ...styles.statusCard, background: 'var(--amber-50)', borderColor: 'var(--amber)' }}>
              <div style={styles.statusContent}>
                <div style={{ ...styles.statusTitle, color: 'var(--amber)' }}>{t('versions.status.pending')}</div>
                <div style={styles.statusDesc}>{t('versions.statusDesc.pending')}</div>
              </div>
            </div>
          )}

          {snapshot.status === 'approved' && (
            <div style={{ ...styles.statusCard, background: 'var(--green-50)', borderColor: 'var(--green)' }}>
              <div style={styles.statusContent}>
                <div style={{ ...styles.statusTitle, color: 'var(--green)' }}>{t('versions.status.approved')}</div>
                <div style={styles.statusDesc}>
                  {snapshot.approvedBy && snapshot.approvedAt && (
                    t('versions.statusDesc.approved', {
                      date: new Date(snapshot.approvedAt).toLocaleDateString(),
                      who: snapshot.approvedBy,
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {snapshot.status === 'rejected' && (
            <div style={{ ...styles.statusCard, background: 'var(--red-50)', borderColor: 'var(--red)' }}>
              <div style={styles.statusContent}>
                <div style={{ ...styles.statusTitle, color: 'var(--red)' }}>{t('versions.status.rejected')}</div>
                <div style={styles.statusDesc}>
                  {snapshot.rejectedBy && snapshot.rejectedAt && (
                    t('versions.statusDesc.rejected', {
                      date: new Date(snapshot.rejectedAt).toLocaleDateString(),
                      who: snapshot.rejectedBy,
                    })
                  )}
                  {snapshot.rejectionReason && (
                    <div style={styles.rejectionReason}>
                      {t('versions.reasonPrefix')}{snapshot.rejectionReason}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
            </div>
          </div>

          {/* Pin to top */}
          <div style={styles.approvalCol}>
            <h3 style={styles.detailSectionTitle}>{t('versions.pin.section')}</h3>
            <div style={styles.pinCard}>
              <div style={styles.statusContent}>
                <div style={styles.statusDesc}>
                  {isPinned
                    ? t('versions.pin.descPinned')
                    : pinEligible
                      ? t('versions.pin.descEligible')
                      : t('versions.pin.descIneligible')}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                onClick={onTogglePin}
                disabled={!isPinned && !pinEligible}
                style={{
                  ...styles.pinToggle,
                  ...(isPinned ? styles.pinToggleOn : {}),
                  ...(!isPinned && !pinEligible ? styles.pinToggleDisabled : {}),
                }}
                aria-checked={isPinned}
                aria-label={isPinned ? t('versions.pin.toggleTitleUnpin') : t('versions.pin.toggleTitlePin')}
                title={
                  !isPinned && !pinEligible
                    ? t('versions.pin.toggleTitleIneligible')
                    : isPinned
                      ? t('versions.pin.toggleTitleUnpin')
                      : t('versions.pin.toggleTitlePin')
                }
              >
                <span
                  style={{
                    ...styles.pinToggleKnob,
                    ...(isPinned ? styles.pinToggleKnobOn : {}),
                  }}
                />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 변경사항 vs 이전 버전 */}
      {(() => {
        const ch = snapshot.changes;
        // summary 를 items 기반으로 재계산 — "사실상 삭제" (modified 인데 모든 after 가
        // (unassigned)) 가 ChangeRow 에서 DELETED 로 표시되므로 카운트도 같이 맞춤.
        const itemsForSummary = ch?.items ?? [];
        const summary = itemsForSummary.reduce(
          (acc, it) => {
            const filtered = (it.fieldChanges ?? []).filter(
              (fc) => fc.field === 'asisColumn' || fc.field === 'transformSql'
            );
            const isEffectivelyDeleted =
              it.kind === 'modified'
              && filtered.length > 0
              && filtered.every((f) => f.after === '(unassigned)');
            const effKind = isEffectivelyDeleted ? 'removed' : it.kind;
            if (effKind === 'added')    acc.added++;
            if (effKind === 'modified') acc.modified++;
            if (effKind === 'removed')  acc.removed++;
            return acc;
          },
          { added: 0, modified: 0, removed: 0 },
        );
        const total = summary.added + summary.modified + summary.removed;
        const compareLabel = ch?.previousVersion
          ? t('versions.changes.compareLabel', { version: ch.previousVersion })
          : t('versions.changes.firstSnapshot');
        return (
          <div style={styles.detailSection}>
            <div style={styles.changesSectionHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ ...styles.detailSectionTitle, margin: 0 }}>{t('versions.changes.title')} ({total})</h3>
                <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{compareLabel}</span>
              </div>
              <div style={styles.changesSummary}>
                {summary.added > 0 && (
                  <span style={styles.summaryBadgeAdded}>{summary.added} {t('versions.changes.status.added')}</span>
                )}
                {summary.modified > 0 && (
                  <span style={styles.summaryBadgeModified}>{summary.modified} {t('versions.changes.status.modified')}</span>
                )}
                {summary.removed > 0 && (
                  <span style={{
                    ...styles.summaryBadgeAdded,
                    background: 'var(--red-50)',
                    color: 'var(--red)',
                    borderColor: 'var(--red)',
                  }}>{summary.removed} {t('versions.changes.status.deleted')}</span>
                )}
              </div>
            </div>

            <div style={styles.changesContainer}>
              {!ch || total === 0 ? (
                <div style={{ padding: '12px 16px', color: 'var(--text-3)', fontStyle: 'italic' }}>
                  {t('versions.changes.noChanges')}
                </div>
              ) : (
                ch.items.map((it, i) => (
                  <ChangeRow
                    key={`${it.kind}-${it.category}-${it.key}-${i}`}
                    kind={it.kind}
                    category={it.category}
                    rawKey={it.key}
                    detail={it.detail}
                    fieldChanges={it.fieldChanges}
                  />
                ))
              )}
            </div>
          </div>
        );
      })()}

    </div>
  );
}

function AuditLogEntries({ auditLogs }: { auditLogs: Array<{
  id: string;
  timestamp: string;
  user: string;
  action: string;
  description: string;
  snapshotName?: string;
  projectId?: string;
}> }) {



  return (
    <div style={styles.auditLogTableWrap}>
      <table style={styles.auditLogTable}>
        <thead>
          <tr>
            <th style={styles.auditLogTh}>Date</th>
            <th style={styles.auditLogTh}>Time</th>
            <th style={styles.auditLogTh}>User</th>
            <th style={styles.auditLogTh}>Action</th>
            <th style={styles.auditLogTh}>Snapshot</th>
            <th style={styles.auditLogTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          {auditLogs.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ ...styles.auditLogTd, textAlign: 'center', color: 'var(--text-4)', fontStyle: 'italic' }}>
                No audit logs yet. Perform actions to see them here.
              </td>
            </tr>
          ) : (
            auditLogs.map((log, index) => (
              <tr key={log.id}>
                <td style={styles.auditLogTd}>
                  {new Date(log.timestamp).toLocaleDateString()}
                </td>
                <td style={styles.auditLogTd}>
                  {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td style={styles.auditLogTd}>
                  {log.user}
                </td>
                <td style={styles.auditLogTd}>
                  {log.action.replace(/\b\w/g, (c) => c.toUpperCase())}
                </td>
                <td style={styles.auditLogTd}>
                  {log.snapshotName || '—'}
                </td>
                <td style={{ ...styles.auditLogTd, whiteSpace: 'pre-wrap' }}>
                  {log.description}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { marginBottom: 14 },
  h1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  subtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  toolbar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },

  // 메인 레이아웃
  mainContent: { 
    display: 'flex', 
    gap: 16, 
    height: 'calc(100vh - 350px)', 
    minHeight: 450 
  },

  // 왼쪽 스냅샷 목록
  snapshotsList: { 
    width: 240, 
    minWidth: 220,
    background: 'var(--panel)', 
    border: '1px solid var(--border)', 
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  snapshotsHeader: { 
    padding: '10px 14px', 
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  snapshotsTitle: { 
    margin: 0, 
    fontSize: 12, 
    fontWeight: 600, 
    color: 'var(--text)' 
  },
  snapshotsCount: { 
    fontSize: 10, 
    color: 'var(--text-3)', 
    fontFamily: 'var(--mono)' 
  },
  snapshotsContainer: { 
    flex: 1, 
    overflow: 'auto' 
  },
  emptySnapshots: { 
    padding: '40px 20px', 
    textAlign: 'center' 
  },
  emptySnapshotsTitle: { 
    fontSize: 13, 
    fontWeight: 600, 
    color: 'var(--text-3)', 
    marginBottom: 8 
  },
  emptySnapshotsDesc: { 
    fontSize: 11, 
    color: 'var(--text-4)', 
    lineHeight: 1.5 
  },

  snapshotItem: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
  snapshotItemSelected: {
    background: 'var(--navy-50)',
    borderLeft: '3px solid var(--navy)'
  },
  snapshotItemHeader: { 
    display: 'flex', 
    alignItems: 'center', 
    justifyContent: 'space-between', 
    marginBottom: 6 
  },
  snapshotVersion: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  cutoverTag: {
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--red)',
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 2,
    padding: '1px 6px',
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  cutoverTagLarge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid var(--red)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    background: 'var(--red-50)',
    color: 'var(--red)',
  },
  snapshotItemName: { 
    fontSize: 12, 
    fontWeight: 500, 
    color: 'var(--text)', 
    marginBottom: 4, 
    lineHeight: 1.3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden'
  },
  snapshotItemDesc: { 
    fontSize: 10, 
    color: 'var(--text-3)', 
    marginBottom: 6, 
    lineHeight: 1.3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden'
  },
  snapshotItemMeta: { 
    fontSize: 9, 
    color: 'var(--text-4)', 
    fontFamily: 'var(--mono)', 
    display: 'flex', 
    gap: 3, 
    alignItems: 'center',
    marginBottom: 6
  },
  snapshotItemActions: { 
    display: 'flex', 
    justifyContent: 'flex-end' 
  },

  requestConfirmItem: {
    padding: '10px 14px',
    background: 'var(--amber-50)',
    border: '1px solid var(--amber)',
    borderRadius: 4,
    margin: '4px 10px',
  },
  requestConfirmContent: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 12,
  },
  requestConfirmActions: { display: 'flex', gap: 8 },

  // 오른쪽 상세 패널
  detailPanel: { 
    flex: 1, 
    background: 'var(--panel)', 
    border: '1px solid var(--border)', 
    borderRadius: 6,
    overflow: 'hidden'
  },
  detailContent: {
    padding: '24px 28px',
    height: '100%',
    overflow: 'auto'
  },
  detailHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 22,
    paddingBottom: 14,
    borderBottom: '1px solid var(--border)'
  },
  detailTitleSection: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  },
  detailTitle: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text)'
  },
  detailVersion: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    padding: '3px 7px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)'
  },
  detailStatus: {},

  detailSection: {
    marginBottom: 56
  },
  detailSectionTitle: {
    margin: '0 0 12px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-2)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontFamily: 'var(--mono)'
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr 1fr',
    gap: 12
  },
  detailGridItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3
  },
  detailLabel: {
    fontSize: 9,
    fontWeight: 600,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  detailValue: {
    fontSize: 11,
    color: 'var(--text)',
    fontFamily: 'var(--mono)'
  },
  detailDescription: {
    fontSize: 11,
    color: 'var(--text-2)',
    lineHeight: 1.45,
    background: 'var(--panel-2)',
    padding: 10,
    borderRadius: 4,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
  },

  approvalSection: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
  },
  approvalRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 14,
    alignItems: 'stretch',
  },
  approvalCol: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  pinCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '11px 12px',
    background: 'var(--panel-2)',
    borderRadius: 6,
    border: '1px solid var(--border)',
    flex: 1,
  },
  pinToggle: {
    position: 'relative',
    width: 40,
    height: 22,
    padding: 0,
    border: '1px solid var(--border-strong)',
    borderRadius: 999,
    background: 'var(--panel-2)',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease, border-color 0.15s ease',
    flexShrink: 0,
  },
  pinToggleOn: {
    background: 'var(--navy)',
    borderColor: 'var(--navy)',
  },
  pinToggleDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  pinToggleKnob: {
    position: 'absolute',
    top: 1,
    left: 1,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
    transition: 'transform 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinToggleKnobOn: {
    transform: 'translateX(18px)',
  },
  pinToggleKnobIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinIcon: {
    position: 'absolute',
    top: 8,
    right: 10,
    color: 'var(--navy)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  statusCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '11px 12px',
    background: 'var(--panel-2)',
    borderRadius: 6,
    border: '1px solid var(--border)',
    flex: 1,
  },
  statusIcon: { fontSize: 16 },
  statusContent: { flex: 1, minWidth: 0 },
  statusTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: 3
  },
  statusDesc: {
    fontSize: 10,
    color: 'var(--text-3)',
    lineHeight: 1.35,
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  rejectionReason: {
    marginTop: 6,
    padding: 8,
    background: 'var(--red-50)',
    borderRadius: 4,
    fontSize: 11,
    color: 'var(--red)',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },

  changesSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  changesSummary: {
    display: 'flex',
    gap: 6
  },
  summaryBadgeAdded: {
    padding: '1px 9px',
    background: 'var(--green-50)',
    color: 'var(--green)',
    border: '1px solid var(--green)',
    borderRadius: 999,
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  summaryBadgeModified: {
    padding: '1px 9px',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 999,
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  changesContainer: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--panel)',
    // 약 10 행 (실측 한 행 ≒ 30px) 까지만 보이고, 나머지는 세로 스크롤.
    // 가로 overflow 는 각 ChangeRow 의 sub-row 영역이 자체 스크롤로 처리하므로
    // 부모는 세로만 잡아주면 됨.
    maxHeight: 300,
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  changeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 12px 6px 10px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
    fontFamily: 'var(--mono)',
  },
  changeSymbol: {
    width: 12,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    flexShrink: 0,
  },
  changeBadgePill: {
    display: 'inline-block',
    padding: '1px 10px',
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 999,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    minWidth: 70,
    textAlign: 'center',
    flexShrink: 0,
  },
  changeTable: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    flexShrink: 0,
  },
  changeDetailInline: {
    flex: 1,
    fontSize: 10,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    textAlign: 'right',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  changeUiOnlyBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 9,
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },

  // Audit Log 섹션 (페이지 하단)
  auditLogSection: {
    marginTop: 16,
    paddingTop: 12,
  },
  auditLogHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    marginBottom: 8,
  },
  auditLogArrow: {
    color: 'var(--text-4)',
    fontSize: 10,
    width: 10,
    userSelect: 'none',
  },
  auditLogSectionTitle: {
    margin: 0,
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: 'var(--mono)'
  },

  // Audit Log 테이블
  auditLogContainer: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    overflow: 'hidden'
  },
  auditLogTableWrap: {
    overflow: 'auto',
    maxHeight: 160
  },
  auditLogTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11
  },
  auditLogTh: {
    padding: '6px 8px',
    textAlign: 'left',
    fontSize: 9,
    fontWeight: 600,
    color: 'var(--text-4)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontFamily: 'var(--mono)',
    background: 'var(--panel-2)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap'
  },
  auditLogTd: {
    padding: '4px 8px',
    fontSize: 10,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    borderBottom: '1px solid var(--border-light)'
  },

  noSelectionMessage: { 
    height: '100%', 
    display: 'flex', 
    flexDirection: 'column', 
    alignItems: 'center', 
    justifyContent: 'center', 
    textAlign: 'center',
    padding: 40
  },
  noSelectionIcon: { 
    fontSize: 48, 
    marginBottom: 16 
  },
  noSelectionTitle: { 
    fontSize: 16, 
    fontWeight: 600, 
    color: 'var(--text-2)', 
    marginBottom: 8 
  },
  noSelectionDesc: { 
    fontSize: 12, 
    color: 'var(--text-3)', 
    lineHeight: 1.5, 
    maxWidth: 300 
  },

  statusBadgeSmall: {
    display: 'inline-block',
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  btnRequest: {
    padding: '4px 8px',
    background: 'var(--navy)',
    color: 'white',
    border: 'none',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnCancel: {
    padding: '4px 8px',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    color: 'var(--text-2)',
    borderRadius: 3,
    fontSize: 10,
    cursor: 'pointer',
  },
  btnConfirm: {
    padding: '4px 8px',
    background: 'var(--navy)',
    color: 'white',
    border: 'none',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 600,
    cursor: 'pointer',
  },
  pendingBadge: {
    padding: '2px 6px',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
  },

  cutoverConfirm: {
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 5,
    padding: 14,
    marginBottom: 12,
  },
  cutoverConfirmTitle: { fontSize: 13, fontWeight: 700, color: 'var(--red)', marginBottom: 6 },
  cutoverConfirmDesc: { fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 10 },
  cutoverConfirmActions: { display: 'flex', justifyContent: 'flex-end', gap: 6 },

  createForm: {
    background: 'var(--green-50)',
    border: '1px solid var(--green)',
    borderRadius: 5,
    padding: 12,
    marginBottom: 12,
  },
  createRow: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10, alignItems: 'end' },
  createHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  createStack: { display: 'flex', flexDirection: 'column', gap: 8 },
  createActions: { display: 'flex', justifyContent: 'flex-end', gap: 6 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--text)' },
  input: {
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    lineHeight: 1.4,
    outline: 'none',
    width: '100%',
    minHeight: 35,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    resize: 'none',
    overflow: 'hidden',
    display: 'block',
  },
  textareaDesc: {
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    outline: 'none',
    width: '100%',
    minHeight: 56,
    maxHeight: 160,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    resize: 'none',
    lineHeight: 1.4,
    display: 'block',
    overflow: 'auto',
  },
  descError: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 2,
    fontSize: 10.5,
    color: 'var(--red)',
    whiteSpace: 'nowrap',
  },
  textareaPlaceholder: {
    position: 'absolute',
    top: 8,
    left: 11,
    fontSize: 12.5,
    lineHeight: 1.4,
    color: '#9ca3af',
    pointerEvents: 'none',
    fontFamily: 'inherit',
  },


  statusBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  reasonNote: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    marginTop: 3,
    fontFamily: 'var(--mono)',
    fontStyle: 'italic',
  },

  empty: { background: 'var(--panel)', border: '1px dashed var(--border-strong)', borderRadius: 6, padding: '50px 24px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' },

  typeBadge: {
    display: 'inline-block', padding: '2px 7px', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
    border: '1px solid', borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.3,
  },
  typeMapping: { background: 'var(--navy-50)', color: 'var(--navy)', borderColor: 'var(--navy)' },
  typeCutover: { background: 'var(--red-50)', color: 'var(--red)', borderColor: 'var(--red)' },

  btnPrimary: {
    padding: '6px 12px', background: 'var(--navy)', color: '#fff', border: '1px solid var(--navy)',
    borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnCutover: {
    padding: '6px 12px', background: 'var(--red)', color: '#fff', border: '1px solid var(--red)',
    borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnGhost: {
    padding: '6px 12px', background: 'var(--panel)', border: '1px solid var(--border-strong)',
    color: 'var(--text-2)', borderRadius: 4, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },

  miniBtn: {
    padding: '3px 9px', fontSize: 11, border: '1px solid var(--border-strong)',
    background: 'var(--panel)', color: 'var(--text-2)', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  miniBtnRequest: {
    padding: '3px 9px', fontSize: 11, border: '1px solid var(--navy)',
    background: 'var(--panel)', color: 'var(--navy)', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600,
  },
  pendingTag: {
    padding: '3px 8px', fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--mono)',
    background: 'var(--amber-50)', color: 'var(--amber)', border: '1px solid var(--amber)',
    borderRadius: 3, whiteSpace: 'nowrap',
  },

};
