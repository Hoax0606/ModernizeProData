import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useWorkspaceStore, type ProjectPhase } from '../store/workspace';
import { useSnapshotsStore, type SnapshotStatus, type SnapshotType } from '../store/snapshots';
import { useAuthStore } from '../store/auth';
import { useActiveProjectReadOnly } from '../store/readOnly';
import { useAuditLogStore } from '../store/auditLog';
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

  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchByProject = useSnapshotsStore((s) => s.fetchByProject);
  const snapshots = useMemo(
    () => allSnapshots
      .filter((s) => s.projectId === activeProjectId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [allSnapshots, activeProjectId],
  );
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

  // Description 입력 규칙: 같은 글자 10번 이상 연속 금지 + 첫째 줄만 20자 초과 시 자동 개행
  const handleDescChange = (raw: string) => {
    if (/(.)\1{9,}/.test(raw)) {
      setDescError('같은 글자를 10번 이상 연속으로 입력할 수 없습니다.');
      return;
    }
    setDescError('');
    const nlIdx = raw.indexOf('\n');
    if (nlIdx === -1) {
      // 아직 한 줄. 20자 넘으면 첫 20자로 끊고 나머지를 다음 줄로
      if (raw.length > 20) {
        setNewDesc(raw.slice(0, 20) + '\n' + raw.slice(20));
      } else {
        setNewDesc(raw);
      }
      return;
    }
    // 이미 줄바꿈이 있음 — 첫 줄만 20자 제한, 그 뒤는 자유
    const firstLine = raw.slice(0, nlIdx);
    const rest = raw.slice(nlIdx); // '\n' 포함
    if (firstLine.length > 20) {
      setNewDesc(firstLine.slice(0, 20) + '\n' + firstLine.slice(20) + rest);
    } else {
      setNewDesc(raw);
    }
  };

  // cutover snapshot 확인 다이얼로그
  const [cutoverConfirmOpen, setCutoverConfirmOpen] = useState(false);

  // 선택된 스냅샷
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const selectedSnapshot = useMemo(
    () => snapshots.find((s) => s.id === selectedSnapshotId) ?? null,
    [snapshots, selectedSnapshotId],
  );

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
        tableCount: project.tableCount,
        ruleCount: 0,
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

                return (
                  <div 
                    key={s.id} 
                    style={{
                      ...styles.snapshotItem,
                      ...(isSelected ? styles.snapshotItemSelected : {})
                    }}
                    onClick={() => {
                      setSelectedSnapshotId(s.id);
                    }}
                  >
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
                    
                    {s.description && (
                      <div style={styles.snapshotItemDesc}>{s.description.split('\n')[0]}</div>
                    )}
                    
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
            <SnapshotDetailView snapshot={selectedSnapshot} onRequest={() => handleRequest(selectedSnapshot.id)} readOnly={readOnly} />
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      {children}
    </div>
  );
}

function ChangeRow({ kind, table, detail }: { kind: 'added' | 'modified'; table: string; detail: string }) {
  const isAdded = kind === 'added';
  return (
    <div style={{
      ...styles.changeRow,
      borderLeft: `3px solid ${isAdded ? 'var(--green)' : 'var(--amber)'}`,
    }}>
      <span style={{ ...styles.changeSymbol, color: isAdded ? 'var(--green)' : 'var(--amber)' }}>
        {isAdded ? '+' : '~'}
      </span>
      <span style={{
        ...styles.changeBadgePill,
        background: isAdded ? 'var(--green-50)' : 'var(--amber-50)',
        color: isAdded ? 'var(--green)' : 'var(--amber)',
        borderColor: isAdded ? 'var(--green)' : 'var(--amber)',
      }}>
        {isAdded ? 'ADDED' : 'MODIFIED'}
      </span>
      <span style={styles.changeTable}>{table}</span>
      <span style={styles.changeDetailInline}>{detail}</span>
    </div>
  );
}

function SnapshotDetailView({ snapshot, onRequest, readOnly }: {
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
}) {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const [confirmingRequest, setConfirmingRequest] = useState(false);

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

      {/* 승인 상태 */}
      <div style={styles.detailSection}>
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
                <div style={styles.statusDesc}>
                  {confirmingRequest
                    ? <><b>{snapshot.name}</b> 스냅샷에 대해 승인을 요청하시겠습니까?</>
                    : '이 스냅샷은 승인 요청 준비가 되었습니다.'}
                </div>
              </div>
              {confirmingRequest ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => {
                      setConfirmingRequest(false);
                      onRequest();
                    }}
                    style={{ ...styles.btnPrimary, ...(readOnly ? styles.btnDisabled : {}) }}
                    disabled={readOnly}
                  >
                    Confirm
                  </button>
                  <button onClick={() => setConfirmingRequest(false)} style={styles.btnGhost}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmingRequest(true)} style={{ ...styles.btnPrimary, ...(readOnly ? styles.btnDisabled : {}) }} disabled={readOnly}>
                  Request Review
                </button>
              )}
            </div>
          )}
          
          {snapshot.status === 'pending' && (
            <div style={styles.statusCard}>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>승인 대기 중</div>
                <div style={styles.statusDesc}>코디네이터의 승인을 기다리고 있습니다.</div>
              </div>
            </div>
          )}

          {snapshot.status === 'approved' && (
            <div style={styles.statusCard}>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>승인됨</div>
                <div style={styles.statusDesc}>
                  {snapshot.approvedBy && snapshot.approvedAt && (
                    <>{new Date(snapshot.approvedAt).toLocaleDateString()}에 {snapshot.approvedBy}님이 승인했습니다.</>
                  )}
                </div>
              </div>
            </div>
          )}

          {snapshot.status === 'rejected' && (
            <div style={styles.statusCard}>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>반려됨</div>
                <div style={styles.statusDesc}>
                  {snapshot.rejectedBy && snapshot.rejectedAt && (
                    <>{new Date(snapshot.rejectedAt).toLocaleDateString()}에 {snapshot.rejectedBy}님이 반려했습니다.</>
                  )}
                  {snapshot.rejectionReason && (
                    <div style={styles.rejectionReason}>
                      사유: {snapshot.rejectionReason}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 변경사항 vs 이전 버전 */}
      <div style={styles.detailSection}>
        <div style={styles.changesSectionHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <h3 style={{ ...styles.detailSectionTitle, margin: 0 }}>Changes (7)</h3>
            <span style={styles.changeUiOnlyBadge}>UI only</span>
          </div>
          <div style={styles.changesSummary}>
            <span style={styles.summaryBadgeAdded}>4 ADDED</span>
            <span style={styles.summaryBadgeModified}>3 MODIFIED</span>
          </div>
        </div>
        
        <div style={styles.changesContainer}>
          <ChangeRow kind="added" table="public.transaction_all" detail="New UNION target (t23 ∪ t24)" />
          <ChangeRow kind="modified" table="public.customer bindings" detail="cp CUST_PROFILE ⋈ cc CUST_CONTACT (was single-source)" />
          <ChangeRow kind="modified" table="public.customer.phone_e164" detail="source: cp.TEL_NO → cc.TEL_NO" />
          <ChangeRow kind="added" table="public.customer.email" detail="source: cc.EMAIL_ADDR, confidence 95%" />
          <ChangeRow kind="added" table="public.customer.preferred_channel" detail="source: cc.PREF_CHANNEL, confidence 80%" />
          <ChangeRow kind="added" table="public.customer.marketing_opt_in" detail="source: cc.OPT_IN_FLG" />
          <ChangeRow kind="modified" table="public.transaction_2024.direction" detail="source confidence lowered 0.75 → 0.65" />
        </div>
      </div>

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
    fontSize: 8.5,
    fontWeight: 600,
    color: 'var(--red)',
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 3,
    padding: '0 4px',
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
    marginBottom: 22
  },
  detailSectionTitle: {
    margin: '0 0 9px',
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

  approvalSection: {},
  statusCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '11px 12px',
    background: 'var(--panel-2)',
    borderRadius: 6,
    border: '1px solid var(--border)',
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
    overflow: 'hidden',
    background: 'var(--panel)',
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
    padding: '6px 12px', background: 'var(--panel)', color: 'var(--red)', border: '1px solid var(--red)',
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
