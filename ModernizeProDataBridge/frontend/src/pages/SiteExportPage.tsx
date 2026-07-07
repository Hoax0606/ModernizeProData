import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';
import { tobeDdlApi } from '../api/tobeDdl';
import { asisDdlApi, type DdlSchema } from '../api/asisDdl';
import {
  useSnapshotsStore,
  usePinnedSnapshotsStore,
  type MappingSnapshot,
  type SnapshotData,
} from '../store/snapshots';
import { snapshotApi } from '../api/workspace';
import { runsApi, type TableResultView } from '../api/runs';
import { validationApi, type ValidationReportDto } from '../api/validation';
import {
  buildManifest,
  DEFAULT_FORMATS,
  generateZipBundle,
  pathSafeName,
  triggerBlobDownload,
  type ProjectArtifactData,
  type SchemaCount,
  type SelectedFormats,
} from '../lib/siteExportManifest';
import type { DiffRule } from './ArtifactsPage';
import { SiteExportPicker, type FormatAvailability } from '../components/SiteExportPicker';
import { SiteExportPreview, type PreviewView } from '../components/SiteExportPreview';

/**
 * Site export — 사이트 단위 일괄 export.
 * 프로토타입(Prototype/src/exporttab.jsx) 의 site-scope UX 포트.
 * 좌측 300px picker + 우측 preview (DB design spec / Site summary / Manifest).
 * 백엔드 export job 미구현 — JSZip 으로 manifest 기반 client-side zip 생성.
 */
export function SiteExportPage() {
  const t = useT();
  const sites = useWorkspaceStore((s) => s.sites);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const siteProjects = useMemo(
    () => projects.filter((p) => p.siteId === activeSiteId),
    [projects, activeSiteId],
  );

  // TO-BE schema — preview 와 manifest 카운트, 그리고 DB design spec workbook
  // 본문에 모두 쓰이므로 raw schema 도 함께 보관한다.
  const [schemaCounts, setSchemaCounts] = useState<Record<string, SchemaCount>>({});
  const [schemas, setSchemas] = useState<Record<string, DdlSchema>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const projectIdsKey = useMemo(
    () => siteProjects.map((p) => p.id).sort().join(','),
    [siteProjects],
  );
  useEffect(() => {
    if (siteProjects.length === 0) {
      setSchemaCounts({});
      setSchemas({});
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all(
      siteProjects.map(async (p) => {
        try {
          const schema = await tobeDdlApi.get(p.id);
          const tables = schema.tables.length;
          const columns = schema.tables.reduce((s, tw) => s + tw.columns.length, 0);
          return { id: p.id, schema, counts: { tables, columns } };
        } catch {
          return { id: p.id, schema: null, counts: { tables: 0, columns: 0 } };
        }
      }),
    ).then((entries) => {
      if (!alive) return;
      setSchemaCounts(Object.fromEntries(entries.map((e) => [e.id, e.counts])));
      setSchemas(Object.fromEntries(
        entries.filter((e): e is { id: string; schema: DdlSchema; counts: SchemaCount } => e.schema !== null)
              .map((e) => [e.id, e.schema]),
      ));
      setLoading(false);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdsKey]);

  const [selectedFormats, setSelectedFormats] = useState<SelectedFormats>(DEFAULT_FORMATS);
  const [view, setView] = useState<PreviewView>('summary');
  const [busy, setBusy] = useState<boolean>(false);
  // 현재 미리보기 중인 포맷 — picker 라벨 클릭으로 변경. 체크박스 (다운로드 선택) 와 분리.
  // 초기값 'summary' — 페이지 진입 시 Site Summary 영역 강조.
  type PreviewedFormat = keyof SelectedFormats | null;
  const [previewedFormat, setPreviewedFormat] = useState<PreviewedFormat>('summary');
  // 현재 미리보기 중인 프로젝트 — SiteExportPreview 의 View dropdown 으로 변경.
  // null = 'Site Summary' 모드 (모든 프로젝트 aggregate). string = 특정 프로젝트 id.
  const [viewProjectId, setViewProjectId] = useState<string | null>(null);
  // site 전환 시 previewedFormat 리셋, viewProjectId 는 첫 프로젝트로 auto-pick.
  // View dropdown 에 Site Summary 옵션이 없어졌으므로 항상 한 프로젝트가 선택돼 있어야 함.
  useEffect(() => {
    setPreviewedFormat('summary');
    setViewProjectId(siteProjects[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSiteId]);
  // siteProjects 가 늦게 로드되는 경우 — 처음 mount 때 빈 배열이면 위 effect 가 null 로 설정.
  // 로드되면 그제서야 첫 프로젝트로 채워 줌.
  useEffect(() => {
    if (viewProjectId == null && siteProjects.length > 0) {
      setViewProjectId(siteProjects[0].id);
    }
  }, [siteProjects, viewProjectId]);

  // Mapping/Migration/Validation 미리보기에 쓰이는 snapshot data — viewProjectId 의 최신 mapping snapshot.
  // 'summary' 모드에서는 fetch 불필요. project 선택 + format-specific previewedFormat 때만.
  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchSnapshotsBySite = useSnapshotsStore((s) => s.fetchBySite);
  useEffect(() => {
    if (activeSiteId) fetchSnapshotsBySite(activeSiteId).catch(() => {});
  }, [activeSiteId, fetchSnapshotsBySite]);
  const latestSnapshotByProject = useMemo(() => {
    const out: Record<string, MappingSnapshot | null> = {};
    for (const p of siteProjects) {
      const list = allSnapshots
        .filter((s) => s.projectId === p.id && s.type === 'mapping')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      out[p.id] = list[0] ?? null;
    }
    return out;
  }, [allSnapshots, siteProjects]);

  const previewProject = useMemo(
    () => viewProjectId ? siteProjects.find((p) => p.id === viewProjectId) ?? null : null,
    [siteProjects, viewProjectId],
  );
  const previewSnapshot = previewProject ? latestSnapshotByProject[previewProject.id] ?? null : null;

  // 좌측 picker 체크박스 availability — snapshot status 와 무관하게 항상 모두 활성.
  const availability: FormatAvailability = {
    mapping: null, migration: null, validation: null, summary: null,
  };
  const previewTobeSchema = previewProject ? schemas[previewProject.id] ?? null : null;
  const [previewSnapshotData, setPreviewSnapshotData] = useState<SnapshotData | null>(null);
  useEffect(() => {
    if (!previewSnapshot) {
      setPreviewSnapshotData(null);
      return;
    }
    let cancelled = false;
    snapshotApi
      .getMapping(previewSnapshot.id)
      .then((d) => { if (!cancelled) setPreviewSnapshotData(d); })
      .catch(() => { if (!cancelled) setPreviewSnapshotData(null); });
    return () => { cancelled = true; };
  }, [previewSnapshot]);

  // Migration SQL 워크북에 쓰일 실 run 데이터 — previewProject 의 가장 최근 finished run 의
  // transform stage 결과. success / failed / aborted / timed_out 모두 허용 — partial 성공도
  // 박제된 compiled_sql 은 보존되므로 실데이터로 의미 있음 (백엔드 주석: "run 시점에 박제되므로
  // mapping_rules 가 나중에 바뀌어도 그 run 에서 실제로 돌았던 SQL 이 그대로 남는다").
  // 워크북은 run 의 최종 status 를 banner 로 표시해 partial 인지 명확히 한다.
  const [previewRunData, setPreviewRunData] = useState<{
    runId: string; runStartedAt: string | null; runStatus: string; tables: TableResultView[];
  } | null>(null);
  useEffect(() => {
    if (!previewProject) {
      setPreviewRunData(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const history = await runsApi.listByProject(previewProject.id);
        // finished_at 있는 run = terminal (success/failed/aborted/timed_out). 가장 최근것.
        // listByProject 는 startedAt DESC 정렬이므로 첫 finished 가 latest.
        const latestFinished = history.find((r) => r.finishedAt != null);
        if (!latestFinished) {
          if (!cancelled) setPreviewRunData(null);
          return;
        }
        const stages = await runsApi.stages(latestFinished.id);
        // compiled_sql 박제된 테이블 — transform stage 에서 SQL 까지 compile 한 row 만.
        // 실패 run 에서도 일부 테이블은 SQL compile + 실행까지 갔으므로 그 row 들은 표시.
        const tables = stages.flatMap((s) => s.tables).filter((t) => t.compiledSql != null);
        if (!cancelled) {
          setPreviewRunData({
            runId: latestFinished.id,
            runStartedAt: latestFinished.startedAt,
            runStatus: latestFinished.status,
            tables,
          });
        }
      } catch {
        if (!cancelled) setPreviewRunData(null);
      }
    })();
    return () => { cancelled = true; };
  }, [previewProject]);

  // generatedAt 은 mount 시점에 한 번 — preview 와 download 가 같은 시각을 공유.
  // 형식: 'YYYY-MM-DD HH:MM JST'
  const generatedAt = useMemo(() => formatGeneratedAt(new Date()), []);
  // 파일명용 stamp: 'YYYY-MM-DD-HHmm'
  const stamp = useMemo(
    () => `${generatedAt.slice(0, 10)}-${generatedAt.slice(11, 16).replace(':', '')}`,
    [generatedAt],
  );
  // zip 파일명 stem == zip 내부 최상위 폴더명. 둘이 일치해 풀었을 때 어색함 없음.
  const bundleStem = useMemo(
    () => `site-export-${pathSafeName(site?.name ?? 'unknown')}-${stamp}`,
    [site, stamp],
  );

  /* 각 project 별 활성 snapshot 의 박제된 successTables (= "마지막 전환 기준 실 테이블 명").
     mount 후 fetch — manifest preview / zip 양쪽에서 일관된 파일명 사용. */
  const [tablesByProject, setTablesByProject] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (siteProjects.length === 0) {
      setTablesByProject({});
      return;
    }
    let alive = true;
    (async () => {
      const snapshotsStore = useSnapshotsStore.getState();
      const pinned = usePinnedSnapshotsStore.getState().pinnedIds;
      await Promise.all(siteProjects.map((p) => snapshotsStore.fetchByProject(p.id)));
      const refreshed = useSnapshotsStore.getState().snapshots;
      const result: Record<string, string[]> = {};
      for (const p of siteProjects) {
        const projectMapping = refreshed.filter((s) => s.projectId === p.id && s.type === 'mapping');
        const active = projectMapping.find((s) => pinned.includes(s.id))
          ?? [...projectMapping].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const ctx = active?.executionContext;
        if (ctx) {
          const set = new Set<string>();
          for (const st of ctx.stages) {
            for (const tr of st.tables) {
              if (tr.status === 'success') set.add(tr.tobeTable);
            }
          }
          if (set.size > 0) result[p.id] = [...set];
        }
      }
      if (alive) setTablesByProject(result);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdsKey]);

  const manifest = useMemo(
    () => buildManifest({ projects: siteProjects, schemaCounts, selectedFormats, bundleStem, tablesByProject }),
    [siteProjects, schemaCounts, selectedFormats, bundleStem, tablesByProject],
  );
  const totalTables = useMemo(
    () => siteProjects.reduce((a, p) => a + (schemaCounts[p.id]?.tables ?? p.tableCount ?? 0), 0),
    [siteProjects, schemaCounts],
  );

  // sidebar 프로젝트 클릭으로 site export 페이지를 빠져나갈 때 race 회피용 가드.
  if (activeProjectId || !site) return null;

  if (siteProjects.length === 0) {
    return (
      <div style={styles.emptyWrap}>
        <div style={styles.emptyTitle}>{t('siteExport.empty.title')}</div>
        <div style={styles.emptyDesc}>{t('siteExport.empty.desc')}</div>
      </div>
    );
  }

  const noFormat = manifest.length === 0;

  const handleDownload = async () => {
    if (busy || noFormat) return;
    setBusy(true);
    try {
      // 각 프로젝트 별 활성 snapshot (pinned > latest mapping) 의 실데이터 fetch.
      const snapshotsAll = useSnapshotsStore.getState().snapshots;
      const pinnedIds = usePinnedSnapshotsStore.getState().pinnedIds;
      // snapshots 가 아직 fetch 안 된 경우 — 안전하게 한 번 더 보장.
      await Promise.all(siteProjects.map((p) => useSnapshotsStore.getState().fetchByProject(p.id)));
      const refreshedSnapshots = useSnapshotsStore.getState().snapshots;

      const projectArtifacts: Record<string, ProjectArtifactData> = {};
      await Promise.all(siteProjects.map(async (p) => {
        const projectMapping = refreshedSnapshots
          .filter((s) => s.projectId === p.id && s.type === 'mapping');
        const pinned = projectMapping.find((s) => pinnedIds.includes(s.id));
        const active = pinned
          ?? [...projectMapping].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!active) {
          // snapshot 자체 없음 — DDL 만 추가될 수 있도록 placeholder.
          const [asis, tobe] = await Promise.all([
            asisDdlApi.get(p.id).catch(() => null),
            tobeDdlApi.get(p.id).catch(() => null),
          ]);
          projectArtifacts[p.id] = {
            snapshotId: null, rules: [], asisSchema: asis, tobeSchema: tobe,
            successTables: null, compiledSqlByTable: {}, validationByTable: {},
          };
          return;
        }
        const [mappingData, asis, tobe] = await Promise.all([
          snapshotApi.getMapping(active.id).catch(() => null),
          asisDdlApi.get(p.id).catch(() => null),
          tobeDdlApi.get(p.id).catch(() => null),
        ]);
        const ctx = active.executionContext ?? null;
        const successTables = ctx
          ? new Set(ctx.stages.flatMap((st) => st.tables.filter((t) => t.status === 'success').map((t) => t.tobeTable.toLowerCase())))
          : null;
        const compiledSqlByTable: Record<string, string> = {};
        const loadStage = ctx?.stages.find((s) => s.stageKey === 'load');
        if (loadStage) {
          for (const tr of loadStage.tables) {
            if (tr.compiledSql) compiledSqlByTable[tr.tobeTable.toLowerCase()] = tr.compiledSql;
          }
        }
        /* validation_reports — snapshot 의 박제된 run 의 결과. runId 가 없으면 빈 map. */
        const validationByTable: Record<string, ValidationReportDto> = {};
        if (ctx?.runId) {
          try {
            const list = await validationApi.listByRun(ctx.runId);
            for (const r of list) validationByTable[r.tobeTable] = r;
          } catch {
            /* 404 / 그 외 — run 이 너무 옛것이라 validation_reports row 없을 수도. silent. */
          }
        }
        projectArtifacts[p.id] = {
          snapshotId: active.id,
          rules: (mappingData?.rules ?? []) as unknown as DiffRule[],
          asisSchema: asis,
          tobeSchema: tobe,
          successTables,
          compiledSqlByTable,
          validationByTable,
        };
      }));
      // snapshots 변수는 의도적으로 사용 안 함 — getState() 직접 호출로 최신 보장.
      void snapshotsAll;

      const blob = await generateZipBundle({
        site,
        projects: siteProjects,
        schemas,
        manifest,
        generatedAt,
        projectArtifacts,
      });
      triggerBlobDownload(blob, `${bundleStem}.zip`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.root}>
      <SiteExportPicker
        siteName={site.name}
        tableCount={totalTables}
        fileCount={manifest.length}
        selectedFormats={selectedFormats}
        onSelectedFormatsChange={setSelectedFormats}
        previewedFormat={previewedFormat}
        onPreviewSelect={setPreviewedFormat}
        availability={availability}
        busy={busy}
        onDownload={handleDownload}
        downloadDisabledReason={noFormat ? t('siteExport.empty.noFormats') : undefined}
      />
      <SiteExportPreview
        site={site}
        projects={siteProjects}
        schemaCounts={schemaCounts}
        manifest={manifest}
        view={view}
        onViewChange={setView}
        generatedAt={generatedAt}
        viewProjectId={viewProjectId}
        onViewProjectChange={setViewProjectId}
        previewedFormat={previewedFormat}
        onReset={() => setPreviewedFormat('summary')}
        previewProject={previewProject}
        previewSnapshotData={previewSnapshotData}
        previewTobeSchema={previewTobeSchema}
        previewRunData={previewRunData}
      />
      {loading && <div style={styles.loadingBadge}>{t('siteExport.loading')}</div>}
    </div>
  );
}

function formatGeneratedAt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${time} JST`;
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr',
    height: '100%',
    minHeight: 0,
    position: 'relative',
  },
  emptyWrap: {
    padding: 40,
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 12,
    color: 'var(--text-3)',
  },
  loadingBadge: {
    position: 'absolute',
    top: 8,
    right: 12,
    padding: '3px 9px',
    background: 'var(--panel-2, var(--panel))',
    color: 'var(--text-3)',
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    border: '1px solid var(--border)',
    borderRadius: 3,
  },
};
