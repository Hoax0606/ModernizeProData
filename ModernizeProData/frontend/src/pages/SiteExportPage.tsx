import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../i18n';
import { tobeDdlApi } from '../api/tobeDdl';
import type { DdlSchema } from '../api/asisDdl';
import {
  buildManifest,
  DEFAULT_FORMATS,
  generateZipBundle,
  pathSafeName,
  triggerBlobDownload,
  type SchemaCount,
  type SelectedFormats,
} from '../lib/siteExportManifest';
import { SiteExportPicker } from '../components/SiteExportPicker';
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

  const manifest = useMemo(
    () => buildManifest({ projects: siteProjects, schemaCounts, selectedFormats, bundleStem }),
    [siteProjects, schemaCounts, selectedFormats, bundleStem],
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
      const blob = await generateZipBundle({
        site,
        projects: siteProjects,
        schemas,
        manifest,
        generatedAt,
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
