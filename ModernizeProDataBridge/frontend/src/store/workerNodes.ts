import { create } from 'zustand';
import { workerApi, type WorkerSummaryDto } from '../api/worker';

export type NodeStatus = 'online' | 'offline' | 'registering' | 'revoked';

export interface WorkerNode {
  id: string;
  /** Hostname the daemon reported at register time. */
  name: string;
  /** Site this worker belongs to (mirrored from owner user.site_id). */
  siteId: string | null;
  /** Owner admin user id (NULL only for very old rows before the redesign). */
  userId: string | null;
  status: NodeStatus;
  /** Audit: which username self-registered this row. */
  createdBy: string;
  registeredAt: string | null;
  lastHeartbeatAt: string | null;
  /** 설치 앱 버전 (예: 1.0.25). 미보고/구버전은 null. */
  appVersion: string | null;
}

interface WorkerNodesState {
  nodes: WorkerNode[];
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  revokeNode: (workerId: string) => Promise<void>;
}

/** Map backend status -> UI status. */
function mapStatus(s: WorkerSummaryDto['status']): NodeStatus {
  switch (s) {
    case 'PROVISIONED': return 'registering';
    case 'REGISTERED':  return 'online';
    case 'REVOKED':     return 'revoked';
    default:            return 'offline';
  }
}

function toNode(dto: WorkerSummaryDto): WorkerNode {
  return {
    id: dto.workerId,
    name: dto.name,
    siteId: dto.siteId,
    userId: dto.userId,
    status: mapStatus(dto.status),
    createdBy: dto.createdBy,
    registeredAt: dto.registeredAt,
    lastHeartbeatAt: dto.lastSeenAt,
    appVersion: dto.appVersion ?? null,
  };
}

/**
 * Worker Node 관리 store — Coordinator 가 노드를 클러스터에 등록·해지.
 * worker_node 테이블의 RPC: list / issue / revoke. ClusterAdminModal 의
 * Worker Nodes 탭이 이 store 를 통해 backend 와 통신한다.
 */
export const useWorkerNodesStore = create<WorkerNodesState>((set) => ({
  nodes: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const rows = await workerApi.list();
      set({ nodes: rows.map(toNode), loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message ?? 'list failed' });
    }
  },

  revokeNode: async (workerId) => {
    await workerApi.revoke(workerId);
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === workerId ? { ...n, status: 'revoked' as NodeStatus } : n),
    }));
  },
}));
