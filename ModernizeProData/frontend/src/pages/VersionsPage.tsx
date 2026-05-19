import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore, type ProjectPhase } from '../store/workspace';
import { useSnapshotsStore, type SnapshotStatus, type SnapshotType } from '../store/snapshots';
import { useAuthStore } from '../store/auth';
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

  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchByProject = useSnapshotsStore((s) => s.fetchByProject);
  const snapshots = useMemo(
    () => allSnapshots.filter((s) => s.projectId === activeProjectId).slice().reverse(),
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

  // cutover snapshot 확인 다이얼로그
  const [cutoverConfirmOpen, setCutoverConfirmOpen] = useState(false);

  // request 확인
  const [requestId, setRequestId] = useState<string | null>(null);
  
  // 선택된 스냅샷
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const selectedSnapshot = useMemo(
    () => snapshots.find((s) => s.id === selectedSnapshotId) ?? null,
    [snapshots, selectedSnapshotId],
  );

  // AUDIT LOG 접기/펼치기 상태
  const [auditLogExpanded, setAuditLogExpanded] = useState(true);

  // 통합된 Audit Log 상태 (프로젝트 전체)
  const [auditLogs, setAuditLogs] = useState<Array<{
    id: string;
    timestamp: string;
    user: string;
    action: string;
    description: string;
    snapshotName?: string;
  }>>([]);

  // rehearsal 이후 phase 에서만 cutover snapshot 생성 가능
  const POST_REHEARSAL: ProjectPhase[] = ['rehearsal', 'ready', 'cutover', 'hypercare', 'done'];
  const canCreateCutover = project ? POST_REHEARSAL.includes(project.phase) : false;

  // Audit Log 추가 함수
  const addAuditLog = (action: string, description: string, snapshotName?: string) => {
    const newLog = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      user: user?.username || 'Unknown',
      action,
      description,
      snapshotName
    };
    setAuditLogs(prev => [newLog, ...prev]);
  };

  if (!project) {
    return (
      <div>
        <div style={styles.header}>
          <h1 style={styles.h1}>{t('versions.title')}</h1>
          <p style={styles.subtitle}>{t('versions.subtitle')}</p>
        </div>
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
      
      // Audit log 기록
      addAuditLog('snapshot created', `Created new ${createType} snapshot: ${name}`, newSnapshot.version || 'v1.0');
      
      resetCreate();
    } catch (error) {
      console.error('Failed to create snapshot:', error);
      addAuditLog('snapshot creation failed', `Failed to create snapshot: ${name}`);
    }
  };

  const handleRequest = async (id: string) => {
    try {
      await requestSnapshot(id);
      
      // Audit log 기록
      const snapshot = snapshots.find(s => s.id === id);
      addAuditLog('approval requested', `Requested approval for snapshot: ${snapshot?.name}`, snapshot?.version);
      
      // Phase 전환은 approve 시점에 처리 (ApprovalsPage)
      setRequestId(null);
    } catch (error) {
      console.error('Failed to request approval:', error);
      addAuditLog('request failed', `Failed to request approval for snapshot: ${snapshots.find(s => s.id === id)?.name}`);
      setRequestId(null);
    }
  };

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.h1}>{t('versions.title')}</h1>
        <p style={styles.subtitle}>{project.name} · {t('versions.subtitle')}</p>
      </div>

      <div style={styles.toolbar}>
        {snapshots.length > 0 && (
          <button
            onClick={async () => {
              if (!confirm('Delete all snapshots in this project?')) return;
              for (const s of snapshots) await deleteSnapshot(s.id);
            }}
            style={{ ...styles.btnGhost, color: 'var(--red)', borderColor: 'var(--red)' }}
          >
            Delete all ({snapshots.length})
          </button>
        )}
        <div style={{ flex: 1 }} />
        {!createOpen ? (
          <>
            <button onClick={() => openCreate('mapping')} style={styles.btnPrimary}>
              {t('versions.create')}
            </button>
            <button
              onClick={() => openCreate('cutover')}
              style={styles.btnCutover}
            >
              {t('versions.createCutover')}
            </button>
          </>
        ) : (
          <button onClick={resetCreate} style={styles.btnGhost}>
            {t('versions.cancelCreate')}
          </button>
        )}
      </div>

      {/* Cutover snapshot 확인 다이얼로그 */}
      {cutoverConfirmOpen && (
        <div style={styles.cutoverConfirm}>
          <div style={styles.cutoverConfirmTitle}>{t('versions.cutoverConfirm.title')}</div>
          <div style={styles.cutoverConfirmDesc}>{t('versions.cutoverConfirm.desc')}</div>
          <div style={styles.cutoverConfirmActions}>
            <button onClick={() => setCutoverConfirmOpen(false)} style={styles.btnGhost}>{t('common.cancel')}</button>
            <button onClick={handleCutoverConfirm} style={styles.btnCutover}>{t('versions.cutoverConfirm.proceed')}</button>
          </div>
        </div>
      )}

      {createOpen && (
        <form onSubmit={handleCreate} style={styles.createForm}>
          <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--mono)', color: createType === 'cutover' ? 'var(--red)' : 'var(--navy)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {createType === 'cutover' ? t('versions.type.cutover') : t('versions.type.mapping')} snapshot
          </div>
          <div style={styles.createRow}>
            <Field label={t('versions.create.name')}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('versions.create.namePh')}
                style={styles.input}
                autoFocus
                required
              />
            </Field>
            <Field label={t('versions.create.desc')}>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder={t('versions.create.descPh')}
                style={styles.input}
              />
            </Field>
          </div>
          <div style={styles.createActions}>
            <button type="submit" style={{ ...styles.btnPrimary, ...(newName.trim() ? {} : styles.btnDisabled) }} disabled={!newName.trim()}>
              {t('versions.create.submit')}
            </button>
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
                
                /* ── request 확인 바 ── */
                if (requestId === s.id) {
                  return (
                    <div key={s.id} style={styles.requestConfirmItem}>
                      <div style={styles.requestConfirmContent}>
                        <span>Request approval for <b>{s.name}</b>?</span>
                        <div style={styles.requestConfirmActions}>
                          <button onClick={() => setRequestId(null)} style={styles.btnCancel}>Cancel</button>
                          <button onClick={() => handleRequest(s.id)} style={styles.btnConfirm}>Confirm</button>
                        </div>
                      </div>
                    </div>
                  );
                }
                
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
                      </div>
                      <span style={{ ...styles.statusBadgeSmall, ...statusTone(s.status) }}>
                        {s.status.toUpperCase()}
                      </span>
                    </div>
                    
                    <div style={styles.snapshotItemName}>{s.name}</div>
                    
                    {s.description && (
                      <div style={styles.snapshotItemDesc}>{s.description}</div>
                    )}
                    
                    <div style={styles.snapshotItemMeta}>
                      <span>{s.createdBy}</span>
                      <span>·</span>
                      <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    </div>
                    
                    <div style={styles.snapshotItemActions}>
                      {s.status === 'draft' && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setRequestId(s.id);
                          }} 
                          style={styles.btnRequest}
                        >
                          Request
                        </button>
                      )}
                      {s.status === 'pending' && (
                        <span style={styles.pendingBadge}>Pending</span>
                      )}
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
            <SnapshotDetailView snapshot={selectedSnapshot} onRequest={() => setRequestId(selectedSnapshot.id)} />
          ) : (
            <div style={styles.noSelectionMessage}>
              <div style={styles.noSelectionIcon}>📋</div>
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

function SnapshotDetailView({ snapshot, onRequest }: { 
  snapshot: { 
    id: string; 
    name: string; 
    version?: string; 
    description?: string; 
    status: SnapshotStatus; 
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
}) {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  
  const handleRequestClick = () => {
    onRequest();
  };
  
  return (
    <div style={styles.detailContent}>
      {/* 헤더 */}
      <div style={styles.detailHeader}>
        <div style={styles.detailTitleSection}>
          <h2 style={styles.detailTitle}>{snapshot.name}</h2>
          <div style={styles.detailVersion}>
            {snapshot.version || 'v1.0'}
          </div>
        </div>
        <div style={styles.detailStatus}>
          <span style={{ ...styles.statusBadge, ...statusTone(snapshot.status) }}>
            {snapshot.status.toUpperCase()}
          </span>
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

      {/* 설명 */}
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
            <div style={styles.statusCard}>
              <div style={styles.statusIcon}>📝</div>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>Draft</div>
                <div style={styles.statusDesc}>This snapshot is ready to be submitted for review</div>
              </div>
              <button onClick={handleRequestClick} style={styles.btnPrimary}>
                Request Review
              </button>
            </div>
          )}
          
          {snapshot.status === 'pending' && (
            <div style={styles.statusCard}>
              <div style={styles.statusIcon}>⏳</div>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>Pending Review</div>
                <div style={styles.statusDesc}>Waiting for coordinator approval</div>
              </div>
            </div>
          )}
          
          {snapshot.status === 'approved' && (
            <div style={styles.statusCard}>
              <div style={styles.statusIcon}>✅</div>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>Approved</div>
                <div style={styles.statusDesc}>
                  {snapshot.approvedBy && snapshot.approvedAt && (
                    <>Approved by {snapshot.approvedBy} on {new Date(snapshot.approvedAt).toLocaleDateString()}</>
                  )}
                </div>
              </div>
            </div>
          )}
          
          {snapshot.status === 'rejected' && (
            <div style={styles.statusCard}>
              <div style={styles.statusIcon}>❌</div>
              <div style={styles.statusContent}>
                <div style={styles.statusTitle}>Rejected</div>
                <div style={styles.statusDesc}>
                  {snapshot.rejectedBy && snapshot.rejectedAt && (
                    <>Rejected by {snapshot.rejectedBy} on {new Date(snapshot.rejectedAt).toLocaleDateString()}</>
                  )}
                  {snapshot.rejectionReason && (
                    <div style={styles.rejectionReason}>
                      Reason: {snapshot.rejectionReason}
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
          <h3 style={styles.detailSectionTitle}>Changes vs Previous (7)</h3>
          <div style={styles.changesSummary}>
            <span style={styles.summaryBadgeAdded}>4 ADDED</span>
            <span style={styles.summaryBadgeModified}>3 MODIFIED</span>
          </div>
        </div>
        
        <div style={styles.changesContainer}>
          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeAdded}>+</span>
              <span style={styles.changeStatus}>ADDED</span>
              <span style={styles.changeTable}>public.transaction_all</span>
            </div>
            <div style={styles.changeDetail}>New UNION target (t23 to t24)</div>
          </div>

          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeModified}>~</span>
              <span style={styles.changeStatus}>MODIFIED</span>
              <span style={styles.changeTable}>public.customer bindings</span>
            </div>
            <div style={styles.changeDetail}>op CUST_PROFILE → cc CUST_CONTACT (was single-source)</div>
          </div>

          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeModified}>~</span>
              <span style={styles.changeStatus}>MODIFIED</span>
              <span style={styles.changeTable}>public.customer.phone_e164</span>
            </div>
            <div style={styles.changeDetail}>source: op.TEL_NO → cc.TEL_NO</div>
          </div>

          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeAdded}>+</span>
              <span style={styles.changeStatus}>ADDED</span>
              <span style={styles.changeTable}>public.customer.email</span>
            </div>
            <div style={styles.changeDetail}>source: cc.EMAIL_ADDR, confidence 95%</div>
          </div>

          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeAdded}>+</span>
              <span style={styles.changeStatus}>ADDED</span>
              <span style={styles.changeTable}>public.customer.preferred_channel</span>
            </div>
            <div style={styles.changeDetail}>source: cc.PREF_CHANNEL, confidence 80%</div>
          </div>

          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeAdded}>+</span>
              <span style={styles.changeStatus}>ADDED</span>
              <span style={styles.changeTable}>public.customer.marketing_opt_in</span>
            </div>
            <div style={styles.changeDetail}>source: cc.OPT_IN_FLG</div>
          </div>

          <div style={styles.changeEntry}>
            <div style={styles.changeHeader}>
              <span style={styles.changeTypeModified}>~</span>
              <span style={styles.changeStatus}>MODIFIED</span>
              <span style={styles.changeTable}>public.transaction_2024.direction</span>
            </div>
            <div style={styles.changeDetail}>source confidence lowered 0.75 → 0.65</div>
          </div>
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
                  {log.action}
                </td>
                <td style={styles.auditLogTd}>
                  {log.snapshotName || '—'}
                </td>
                <td style={styles.auditLogTd}>
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
    fontFamily: 'var(--mono)' 
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
    padding: '36px 40px', 
    height: '100%', 
    overflow: 'auto' 
  },
  detailHeader: { 
    display: 'flex', 
    alignItems: 'center', 
    justifyContent: 'space-between', 
    marginBottom: 32, 
    paddingBottom: 20, 
    borderBottom: '1px solid var(--border)' 
  },
  detailTitleSection: { 
    display: 'flex', 
    alignItems: 'center', 
    gap: 12 
  },
  detailTitle: { 
    margin: 0, 
    fontSize: 20, 
    fontWeight: 600, 
    color: 'var(--text)' 
  },
  detailVersion: { 
    background: 'var(--navy-50)', 
    color: 'var(--navy)', 
    padding: '4px 8px', 
    borderRadius: 4, 
    fontSize: 11, 
    fontWeight: 700, 
    fontFamily: 'var(--mono)' 
  },
  detailStatus: {},

  detailSection: { 
    marginBottom: 32 
  },
  detailSectionTitle: { 
    margin: '0 0 12px', 
    fontSize: 13, 
    fontWeight: 600, 
    color: 'var(--text-2)', 
    textTransform: 'uppercase', 
    letterSpacing: 0.5, 
    fontFamily: 'var(--mono)' 
  },
  detailGrid: { 
    display: 'grid', 
    gridTemplateColumns: '1fr 1fr 1fr 1fr', 
    gap: 16 
  },
  detailGridItem: { 
    display: 'flex', 
    flexDirection: 'column', 
    gap: 4 
  },
  detailLabel: { 
    fontSize: 11, 
    fontWeight: 600, 
    color: 'var(--text-3)', 
    textTransform: 'uppercase', 
    letterSpacing: 0.5 
  },
  detailValue: { 
    fontSize: 12, 
    color: 'var(--text)', 
    fontFamily: 'var(--mono)' 
  },
  detailDescription: { 
    fontSize: 12, 
    color: 'var(--text-2)', 
    lineHeight: 1.5, 
    background: 'var(--panel-2)', 
    padding: 12, 
    borderRadius: 4 
  },

  approvalSection: {},
  statusCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '16px',
    background: 'var(--panel-2)',
    borderRadius: 6,
    border: '1px solid var(--border)',
  },
  statusIcon: { fontSize: 20 },
  statusContent: { flex: 1 },
  statusTitle: { 
    fontSize: 13, 
    fontWeight: 600, 
    color: 'var(--text)', 
    marginBottom: 4 
  },
  statusDesc: { 
    fontSize: 11, 
    color: 'var(--text-3)', 
    lineHeight: 1.4 
  },
  rejectionReason: { 
    marginTop: 6, 
    padding: 8, 
    background: 'var(--red-50)', 
    borderRadius: 4, 
    fontSize: 11, 
    color: 'var(--red)' 
  },

  changesSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16
  },
  changesSummary: {
    display: 'flex',
    gap: 8
  },
  summaryBadgeAdded: {
    padding: '2px 8px',
    background: 'var(--green-50)',
    color: 'var(--green)',
    borderRadius: 12,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  summaryBadgeModified: {
    padding: '2px 8px',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    borderRadius: 12,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  changesContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden'
  },
  changeEntry: {
    background: 'var(--panel)',
    borderBottom: '1px solid var(--border)',
  },
  changeHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 12px',
    fontSize: 11,
    fontFamily: 'var(--mono)'
  },
  changeTypeAdded: {
    width: 16,
    height: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--green-50)',
    color: 'var(--green)',
    borderRadius: 2,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'var(--mono)'
  },
  changeTypeModified: {
    width: 16,
    height: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    borderRadius: 2,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'var(--mono)'
  },
  changeStatus: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    minWidth: 60
  },
  changeTable: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    flex: 1
  },
  changeDetail: {
    padding: '4px 12px 8px 40px',
    fontSize: 11,
    color: 'var(--text-3)',
    lineHeight: 1.4,
    fontFamily: 'var(--mono)'
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
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    padding: 12,
    marginBottom: 12,
  },
  createRow: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10, alignItems: 'end' },
  createActions: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--text)' },
  input: {
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    outline: 'none',
    width: '100%',
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
