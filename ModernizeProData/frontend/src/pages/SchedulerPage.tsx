/**
 * Scheduler 管理ページ.
 *
 * セクション:
 *   - Internal scheduler card  — Quartz Nightly の ON/OFF + mode (common/individual) + 時刻
 *   - External integrations    — token 登録 + 外部 URL + curl 実行例
 *   - Run history              — 全 project 横断, 最新 50, abort action
 *
 * Internal/External は mutex (BE の CHECK constraint + service 自動 flip で二重強制).
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { useWorkspaceStore } from '../store/workspace';
import { useSettingsStore } from '../store/settings';
import { ApiError } from '../api/client';
import { runsApi, type RunHistoryDto, type RunTableResult } from '../api/runs';
import { credentialsApi, type CurrentCredentialDto } from '../api/credentials';
import { solutionSettingsApi, type SolutionSettingsDto, type InternalMode } from '../api/solutionSettings';
import { scheduleApi } from '../api/schedule';
import { Toggle } from '../components/Toggle';
import { Radio } from '../components/Checkbox';
import { useT } from '../i18n';
import { toHHmm, toHHmmss, formatTimestamp, formatTimeMs, formatDuration } from '../lib/formatters';

export function SchedulerPage() {
  const t = useT();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';

  const allProjects = useWorkspaceStore((s) => s.projects);
  const allSites = useWorkspaceStore((s) => s.sites);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const fetchSites = useWorkspaceStore((s) => s.fetchSites);
  const fetchProjects = useWorkspaceStore((s) => s.fetchProjects);
  /* SchedulerPage は active site の context で開かれる前提.
     trigger curl 例 / project schedule 設定 / project 一覧 などはすべて active site
     に絞る. activeSiteId が null の時は空 list (= site が選ばれていない、サイドバーで
     site を選択するように促す形). */
  const sites = useMemo(
    () => allSites.filter((s) => s.id === activeSiteId),
    [allSites, activeSiteId],
  );
  const projects = useMemo(
    () => allProjects.filter((p) => p.siteId === activeSiteId),
    [allProjects, activeSiteId],
  );

  // settings store の externalIntegrations toggle は BE と optimistic mirror.
  const setStoreExternalIntegrations = useSettingsStore((s) => s.setExternalIntegrations);

  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<RunHistoryDto[]>([]);
  /** Run history 行絞り込み. 空文字 = All. */
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('');
  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>('');
  const [historyTriggerFilter, setHistoryTriggerFilter] = useState<string>('');
  /** Run History の drill-down 展開行 (複数同時展開可). */
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const toggleExpandedRun = (runId: string) => setExpandedRunIds((cur) => {
    const next = new Set(cur);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  });

  const [credential, setCredential] = useState<CurrentCredentialDto | null>(null);
  const [settings, setSettings] = useState<SolutionSettingsDto | null>(null);

  // BE solution_settings の mirror. baseline は BE 応答直後の値で isDirty 判定用.
  const [internalOn, setInternalOn] = useState(false);
  const [internalBaseline, setInternalBaseline] = useState(false);
  const [externalOn, setExternalOn] = useState(false);
  const [externalBaseline, setExternalBaseline] = useState(false);
  const [extEndpoint, setExtEndpoint] = useState<string>('');
  const [extEndpointBaseline, setExtEndpointBaseline] = useState<string>('');

  // Internal mode (common/individual). null = 未選択 (Internal=ON 時は Save 不可).
  const [internalMode, setInternalMode] = useState<InternalMode | null>(null);
  const [internalModeBaseline, setInternalModeBaseline] = useState<InternalMode | null>(null);
  const [internalCommonTime, setInternalCommonTime] = useState<string>('');
  const [internalCommonTimeBaseline, setInternalCommonTimeBaseline] = useState<string>('');
  const [projectTimes, setProjectTimes] = useState<Record<string, string>>({});
  const [projectTimesBaseline, setProjectTimesBaseline] = useState<Record<string, string>>({});

  // ⚠ BE が平文 (token_plain) も保管しているため、credential.tokenPlain は plain を含む.
  // PoC 要件、security 妥協.
  const [tokenInput, setTokenInput] = useState<string>('');
  const [registering, setRegistering] = useState(false);

  const [saving, setSaving] = useState(false);

  // Trigger examples docs の shell type 切替.
  //   bash       — `-d '{...}'`
  //   windows    — `-d "{\"...\"}"` (cmd / Task Scheduler)
  //   powershell — `curl.exe --% ...` + windows escape (PowerShell の引数加工を `--%` で回避)
  const [shellMode, setShellMode] = useState<'bash' | 'windows' | 'powershell'>('bash');

  useEffect(() => {
    fetchSites().then(() => {
      useWorkspaceStore.getState().sites.forEach((s) => fetchProjects(s.id));
    });
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * projects 가 fetch 된 後, baseline (DB 값) 을 동기화.
   * draft (projectTimes) 는 첫 sync 時만 baseline 으로 채움 — 그 後는 user 가 직접 편집.
   */
  useEffect(() => {
    const base: Record<string, string> = {};
    projects.forEach((p) => { base[p.id] = p.scheduleStartTime ? toHHmm(p.scheduleStartTime) : ''; });
    setProjectTimesBaseline(base);
    setProjectTimes((cur) => {
      // 既存 draft 가 없는 project 만 baseline 으로 채움 (편집 중인 값을 덮어쓰지 않기 위해)
      const next = { ...cur };
      projects.forEach((p) => {
        if (!(p.id in next)) next[p.id] = base[p.id];
      });
      return next;
    });
  }, [projects]);

  const refreshHistory = async () => {
    try {
      const h = await runsApi.listAll();
      setHistory(h);
    } catch (e) {
      setError(formatError(e));
    }
  };

  const refreshAll = async () => {
    setError(null);
    try {
      const [h, c, s] = await Promise.all([
        runsApi.listAll(),
        credentialsApi.getCurrent().catch(() => null),
        solutionSettingsApi.get().catch(() => null),
      ]);
      setHistory(h);
      if (c) setCredential(c);
      if (s) {
        setSettings(s);
        // baseline 갱신 — Save 直後 isDirty 가 false 로 落ちる
        setInternalOn(s.internalEnabled);
        setInternalBaseline(s.internalEnabled);
        setExternalOn(s.externalEnabled);
        setExternalBaseline(s.externalEnabled);
        setInternalMode(s.internalMode);
        setInternalModeBaseline(s.internalMode);
        const ct = s.internalCommonTime ? toHHmm(s.internalCommonTime) : '';
        setInternalCommonTime(ct);
        setInternalCommonTimeBaseline(ct);
        const ep = s.externalApiEndpoint ?? '';
        setExtEndpoint(ep);
        setExtEndpointBaseline(ep);
        setStoreExternalIntegrations(s.externalEnabled);
      }
    } catch (e) {
      setError(formatError(e));
    }
  };

  /** Mutex helper — 한쪽 ON 이면 다른 쪽이 자동 OFF (BE 의 CHECK constraint 와 양면 강제). */
  const handleInternalToggle = () => {
    setInternalOn((v) => {
      const next = !v;
      if (next) setExternalOn(false);
      return next;
    });
  };
  const handleExternalToggle = () => {
    setExternalOn((v) => {
      const next = !v;
      if (next) setInternalOn(false);
      return next;
    });
  };

  /**
   * Phase 5: mode 선택 시 default time prefill.
   *   - common 선택: common_time 비어있으면 22:00 prefill
   *   - individual 선택: project 別 빈 칸을 22:00 prefill
   */
  const handleSelectMode = (mode: InternalMode) => {
    setInternalMode(mode);
    if (mode === 'common' && !internalCommonTime) {
      setInternalCommonTime('22:00');
    } else if (mode === 'individual') {
      setProjectTimes((cur) => {
        const next = { ...cur };
        projects.forEach((p) => {
          if (!next[p.id]) next[p.id] = '22:00';
        });
        return next;
      });
    }
  };

  const handleProjectTimeChange = (projectId: string, value: string) => {
    setProjectTimes((cur) => ({ ...cur, [projectId]: value }));
  };

  /**
   * 外部スケジューラから受け取った token を BE に登録.
   * 既存 default credential があれば BE が自動 revoke.
   * 平文はサーバ側に未保管 — hash + display のみ.
   */
  const handleRegisterToken = async () => {
    if (registering) return;
    if (tokenInput.length < 16) {
      setError(t('scheduler.errors.tokenTooShort'));
      return;
    }
    setRegistering(true);
    setError(null);
    try {
      const result = await credentialsApi.register({ plainToken: tokenInput });
      setCredential({
        credentialId: result.credentialId,
        maskedDisplay: result.maskedDisplay,
        tokenPlain: result.tokenPlain,
        active: true,
        generatedAt: new Date().toISOString(),
        lastUsedAt: null,
      });
      setTokenInput('');
    } catch (e) {
      setError(formatError(e));
    } finally {
      setRegistering(false);
    }
  };

  /**
   * Unified Save — Internal/External 양 카드의 draft 를 한꺼번에 commit.
   * 1) PATCH /solution-settings 1 발로 internal/external 双方 + mode + common_time + ext config
   * 2) Individual mode 라면 변경된 project 마다 PATCH /projects/{id}/schedule
   * 3) BE 응답으로 baselines 갱신, projects 재 fetch
   */
  const handleSave = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await solutionSettingsApi.update({
        internalEnabled: internalOn,
        internalMode: internalOn ? internalMode : null,
        internalCommonTime: internalOn && internalMode === 'common' && internalCommonTime
          ? toHHmmss(internalCommonTime)
          : null,
        externalEnabled: externalOn,
        externalApiEndpoint: extEndpoint,
      });

      // Individual mode: per-project schedule_start_time 個別 patch (변경된 것 만)
      if (updated.internalEnabled && updated.internalMode === 'individual') {
        for (const p of projects) {
          const draft = projectTimes[p.id];
          const baseline = projectTimesBaseline[p.id] ?? '';
          if (draft && draft !== baseline) {
            await scheduleApi.update(p.id, { startTime: toHHmmss(draft) });
          }
        }
        const ws = useWorkspaceStore.getState();
        for (const s of ws.sites) {
          await ws.fetchProjects(s.id);
        }
      }

      // local state ↔ BE 결과 同期 + baselines reset
      setSettings(updated);
      setInternalOn(updated.internalEnabled);
      setExternalOn(updated.externalEnabled);
      setInternalBaseline(updated.internalEnabled);
      setExternalBaseline(updated.externalEnabled);
      setInternalMode(updated.internalMode);
      setInternalModeBaseline(updated.internalMode);
      const ct = updated.internalCommonTime ? toHHmm(updated.internalCommonTime) : '';
      setInternalCommonTime(ct);
      setInternalCommonTimeBaseline(ct);
      const ep = updated.externalApiEndpoint ?? '';
      setExtEndpoint(ep);
      setExtEndpointBaseline(ep);
      setStoreExternalIntegrations(updated.externalEnabled);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * dirty + validation. 둘 다 통과해야 Save 활성.
   * Validation 規則 (Internal=ON 일 때만):
   *   - mode=null → 不可
   *   - mode=common + common_time 空 → 不可
   *   - mode=individual + 어느 project 라도 time 空 → 不可
   * External 측은 validation 制約 없음.
   */
  const { dirty, canSave } = useMemo(() => {
    // dirty 판정
    let isDirty = false;
    if (internalOn !== internalBaseline) isDirty = true;
    else if (internalMode !== internalModeBaseline) isDirty = true;
    else if (internalCommonTime !== internalCommonTimeBaseline) isDirty = true;
    else if (externalOn !== externalBaseline) isDirty = true;
    else if (extEndpoint !== extEndpointBaseline) isDirty = true;
    else {
      for (const p of projects) {
        const draft = projectTimes[p.id] ?? '';
        const base = projectTimesBaseline[p.id] ?? '';
        if (draft !== base) { isDirty = true; break; }
      }
    }
    // validation
    let valid = true;
    if (internalOn) {
      if (internalMode === null) valid = false;
      else if (internalMode === 'common' && !internalCommonTime) valid = false;
      else if (internalMode === 'individual') {
        for (const p of projects) {
          if (!projectTimes[p.id]) { valid = false; break; }
        }
      }
    }
    return { dirty: isDirty, canSave: isDirty && valid };
  }, [internalOn, internalBaseline, internalMode, internalModeBaseline,
      internalCommonTime, internalCommonTimeBaseline,
      externalOn, externalBaseline,
      extEndpoint, extEndpointBaseline,
      projects, projectTimes, projectTimesBaseline]);

  const handleAbort = async (runId: string) => {
    try { await runsApi.devAbort(runId, 'aborted from dev test page (manual reset)'); await refreshHistory(); }
    catch (e) { setError(formatError(e)); }
  };

  /* Page scope = active site. History も active site の project が走らせた run のみ.
     runsApi.listAll() は全 site 横断で返るため FE 側で project.siteId 照合. */
  const activeSiteProjectIds = useMemo(
    () => new Set(allProjects.filter((p) => p.siteId === activeSiteId).map((p) => p.id)),
    [allProjects, activeSiteId],
  );
  const historyForSite = useMemo(
    () => history.filter((r) => activeSiteProjectIds.has(r.projectId)),
    [history, activeSiteProjectIds],
  );

  /** Run history dropdown 選択肢 — 現データに存在する値だけ derive. */
  const historyStatusOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyForSite) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [historyForSite]);
  const historyTypeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyForSite) m.set(r.runType, (m.get(r.runType) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [historyForSite]);
  const historyTriggerOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of historyForSite) m.set(r.triggerSource, (m.get(r.triggerSource) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [historyForSite]);
  const filteredHistory = useMemo(() => historyForSite.filter((r) => {
    if (historyStatusFilter && r.status !== historyStatusFilter) return false;
    if (historyTypeFilter && r.runType !== historyTypeFilter) return false;
    if (historyTriggerFilter && r.triggerSource !== historyTriggerFilter) return false;
    return true;
  }), [historyForSite, historyStatusFilter, historyTypeFilter, historyTriggerFilter]);

  /* データから消えた値を選んでた場合は filter をリセット. */
  useEffect(() => {
    if (historyStatusFilter && !historyStatusOptions.some(([v]) => v === historyStatusFilter)) {
      setHistoryStatusFilter('');
    }
  }, [historyStatusOptions, historyStatusFilter]);
  useEffect(() => {
    if (historyTypeFilter && !historyTypeOptions.some(([v]) => v === historyTypeFilter)) {
      setHistoryTypeFilter('');
    }
  }, [historyTypeOptions, historyTypeFilter]);
  useEffect(() => {
    if (historyTriggerFilter && !historyTriggerOptions.some(([v]) => v === historyTriggerFilter)) {
      setHistoryTriggerFilter('');
    }
  }, [historyTriggerOptions, historyTriggerFilter]);

  if (!isMaster) {
    return (
      <div style={styles.page}>
        <div style={styles.banner}>{t('scheduler.banner.masterRequired')}</div>
        <button onClick={() => navigate('/')}>{t('scheduler.action.goHome')}</button>
      </div>
    );
  }

  // Trigger examples docs 用 coordinator URL の解決順:
  //   1. master が UI で入力した extEndpoint (= BE solution_settings.external_api_endpoint)
  //   2. 未入力なら placeholder ── 「<COORDINATOR_URL>」のまま docs に出る
  // ブラウザ URL からの自動類推は localhost で開いてる時に誤った値 (= 別 PC で使えない)
  // を出す問題があるため廃止. master が客先 deploy 時に確実な値を入れる責任.
  const coordinatorUrl = extEndpoint.trim() || '<COORDINATOR_URL>';

  // Trigger examples 内に埋め込む token:
  //   - BE が平文保管しているので credential.tokenPlain を埋め込む
  //   - 未登録 / legacy row 等で plain 取れない場合は <YOUR_TOKEN> placeholder
  const tokenForDocs = credential?.tokenPlain ?? '<YOUR_TOKEN>';

  // 1 行表記: bash の `\` line continuation は PowerShell/cmd で解釈が違うため避ける.
  // curl の起動行と body のクォート形式を shellMode で切替.
  //   bash         : curl ... -d '{...}'
  //   windows      : curl ... -d "{\"...\"}"
  //   powershell   : curl.exe --% ... -d "{\"...\"}"   (--% で PowerShell の引数加工を停止)
  const curlCmd = shellMode === 'powershell' ? 'curl.exe --%' : 'curl';
  const quoteBody = (obj: Record<string, string>) => {
    const json = JSON.stringify(obj);
    return shellMode === 'bash' ? `'${json}'` : `"${json.replace(/"/g, '\\"')}"`;
  };
  /* /runs/all は siteId 必須 (2026-05-29 改). このページは active site scope なので
     その site の bulk + その site の project の single だけを表示. */
  const activeSite = sites[0] ?? null;
  const triggerExamplesText = (() => {
    if (!activeSite) {
      return '# (サイドバーで site を選んでください)';
    }
    const bulkCmd = `${curlCmd} -X POST ${coordinatorUrl}/api/v1/runs/all -H "Authorization: Bearer ${tokenForDocs}" -H "Content-Type: application/json" -d ${quoteBody({ siteId: activeSite.id })}`;
    const singleCmds = projects.length === 0
      ? '# (この site にはまだ project がありません)'
      : projects.map((p) => {
          const body = quoteBody({ projectId: p.id });
          return `# ${p.name} (phase=${p.phase})\n${curlCmd} -X POST ${coordinatorUrl}/api/v1/runs -H "Authorization: Bearer ${tokenForDocs}" -H "Content-Type: application/json" -d ${body}`;
        }).join('\n\n');
    return `${t('scheduler.external.docs.bulkComment')}\n${bulkCmd}\n\n${t('scheduler.external.docs.singleComment')}\n${singleCmds}`;
  })();

  return (
    <div style={styles.page}>
      <div style={styles.titleRow}>
        <h2 style={{ ...styles.h2, margin: 0 }}>{t('scheduler.title')}</h2>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          style={{
            ...styles.btnPrimary,
            ...((!canSave || saving) ? styles.btnPrimaryDisabled : {}),
          }}
          title={dirty && !canSave ? t('scheduler.save.tooltip.invalidInternal') : ''}
        >
          {saving ? '' : t('common.save')}
        </button>
      </div>

      {/* Internal scheduler (Quartz Nightly) — External 와 mutex.
          Phase 5: Internal=ON 시 mode (common/individual) 선택 + 時刻 입력 필수. */}
      <section style={styles.cardSection}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>{t('solution.internal')}</div>
            <div style={styles.cardDesc}>{t('solution.internal.desc')}</div>
          </div>
          <Toggle
            on={internalOn}
            onChange={handleInternalToggle}
            ariaLabel={t('solution.internal')}
          />
        </div>
        <div style={styles.cardBody}>
          {!internalOn && (
            <div style={styles.hint}>{t('solution.internal.inactiveHint')}</div>
          )}

          {internalOn && (
            <>
              {/* Mode selection — radio */}
              <div style={styles.modeRow}>
                <div style={styles.modeLabel}>{t('scheduler.internal.modeLabel')}</div>
                <label style={styles.radioLabel} onClick={() => handleSelectMode('common')}>
                  <Radio checked={internalMode === 'common'} onChange={() => handleSelectMode('common')} />
                  <span style={{ marginLeft: 6 }}>{t('scheduler.internal.modeCommonLabel')}</span>
                </label>
                <label style={styles.radioLabel} onClick={() => handleSelectMode('individual')}>
                  <Radio checked={internalMode === 'individual'} onChange={() => handleSelectMode('individual')} />
                  <span style={{ marginLeft: 6 }}>{t('scheduler.internal.modeIndividualLabel')}</span>
                </label>
                {internalMode === null && (
                  <div style={styles.warnHint}>{t('scheduler.internal.modeWarn')}</div>
                )}
              </div>

              {/* Common time picker */}
              {internalMode === 'common' && (
                <div style={styles.rowField}>
                  <div style={styles.rowFieldLabel}>
                    <div style={styles.rowFieldTitle}>{t('scheduler.internal.commonTimeTitle')}</div>
                    <div style={styles.rowFieldSub}>{t('scheduler.internal.commonTimeSub')}</div>
                  </div>
                  <input
                    type="time"
                    value={internalCommonTime}
                    onChange={(e) => setInternalCommonTime(e.target.value)}
                    style={{ ...styles.input, maxWidth: 140, flex: 0 }}
                  />
                </div>
              )}

              {/* Per-project time table */}
              {internalMode === 'individual' && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6, lineHeight: 1.5 }}>
                    {t('scheduler.internal.individualHint')}
                  </div>
                  {projects.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '8px 0' }}>{t('scheduler.internal.noProjects')}</div>
                  ) : (
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>{t('scheduler.internal.col.project')}</th>
                          <th style={styles.th}>{t('scheduler.internal.col.site')}</th>
                          <th style={styles.th}>{t('scheduler.internal.col.phase')}</th>
                          <th style={styles.th}>{t('scheduler.internal.col.startTime')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projects.map((p) => {
                          const site = sites.find((s) => s.id === p.siteId);
                          const time = projectTimes[p.id] ?? '';
                          const empty = !time;
                          return (
                            <tr key={p.id}>
                              <td style={styles.td}>{p.name}</td>
                              <td style={styles.td}>{site?.name ?? '-'}</td>
                              <td style={styles.td}>{p.phase}</td>
                              <td style={styles.td}>
                                <input
                                  type="time"
                                  value={time}
                                  onChange={(e) => handleProjectTimeChange(p.id, e.target.value)}
                                  style={{
                                    ...styles.input, maxWidth: 110, flex: 0,
                                    borderColor: empty ? '#dc2626' : 'var(--border-strong)',
                                  }}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}

        </div>
      </section>

      {/* External integrations (REST/CLI) — Internal 와 mutex */}
      <section style={styles.cardSection}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>{t('solution.external')}</div>
            <div style={styles.cardDesc}>{t('solution.external.desc')}</div>
          </div>
          <Toggle
            on={externalOn}
            onChange={handleExternalToggle}
            ariaLabel={t('solution.external')}
          />
        </div>
        <div style={styles.cardBody}>
          {/* Token 登録は External toggle ON/OFF と無関係 — master が操作可能.
              toggle は runtime gate (受け付け endpoint の 503 制御) のみの責務. */}
          <div style={{ ...styles.rowField, flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ marginBottom: 8 }}>
              <div style={styles.rowFieldTitle}>{t('scheduler.external.tokenTitle')}</div>
              <div style={styles.rowFieldSub}>{t('scheduler.external.tokenDesc')}</div>
            </div>

            {/* 現在登録されている token の表示.
                ⚠ BE が平文保管しているため、tokenPlain があれば平文表示 (PoC 要件、security 妥協).
                tokenPlain が無い場合 (legacy row 等) は masked にフォールバック. */}
            {(credential?.tokenPlain || credential?.maskedDisplay) && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <div style={{
                  ...styles.input,
                  flex: 1,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  background: 'var(--panel-2)',
                  wordBreak: 'break-all',
                }}>
                  {credential?.tokenPlain ?? credential?.maskedDisplay}
                </div>
              </div>
            )}

            {/* 新規登録フォーム */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t('scheduler.external.tokenPlaceholder')}
                style={{
                  ...styles.input, flex: 1,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                onClick={handleRegisterToken}
                disabled={registering || tokenInput.length < 16}
                style={{
                  padding: '6px 14px',
                  fontSize: 11,
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  cursor: registering ? 'not-allowed' : 'pointer',
                  opacity: (registering || tokenInput.length < 16) ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {registering ? '' : (credential?.maskedDisplay ? t('scheduler.external.tokenReplace') : t('scheduler.external.tokenRegister'))}
              </button>
            </div>
            {credential?.maskedDisplay && (
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
                {t('scheduler.external.tokenRevokeNote')}
              </div>
            )}
          </div>

          {/* External URL — Trigger examples docs に substitute される client-facing URL.
              master が客先 deploy 時に「外部スケジューラから見える URL」を入力する.
              空欄なら docs は <COORDINATOR_URL> placeholder のまま. */}
          <div style={{ ...styles.rowField, flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ marginBottom: 8 }}>
              <div style={styles.rowFieldTitle}>{t('scheduler.external.urlTitle')}</div>
              <div style={styles.rowFieldSub}>{t('scheduler.external.urlDesc')}</div>
            </div>
            <input
              type="text"
              value={extEndpoint}
              onChange={(e) => setExtEndpoint(e.target.value)}
              placeholder={t('scheduler.external.urlPlaceholder')}
              style={{
                ...styles.input,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Trigger examples — 穴埋め placeholder 式 docs. External ON/OFF 無関係に常時表示. */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
              {t('solution.external.triggerExamples.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 8 }}>
              {t('solution.external.triggerExamples.desc')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {t('scheduler.external.docs.shellLabel')}:
              </span>
              <select
                value={shellMode}
                onChange={(e) => setShellMode(e.target.value as 'bash' | 'windows' | 'powershell')}
                style={{
                  fontSize: 11, padding: '2px 6px',
                  background: 'var(--panel-2)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 3,
                }}
              >
                <option value="bash">{t('scheduler.external.docs.shellBash')}</option>
                <option value="windows">{t('scheduler.external.docs.shellWindows')}</option>
                <option value="powershell">{t('scheduler.external.docs.shellPowershell')}</option>
              </select>
            </div>
            <pre style={{
              padding: 10, margin: 0,
              background: '#0e1a2b', color: '#cad7e8',
              fontFamily: 'var(--mono)', fontSize: 11,
              borderRadius: 3, lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}>
{triggerExamplesText}
            </pre>
          </div>

        </div>
      </section>

      {error && <div style={styles.errorBox}>Error: {error}</div>}

      {/* Run history */}
      <section style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ ...styles.h3, margin: 0 }}>
            {t('scheduler.section.history')}
            {(historyStatusFilter || historyTypeFilter || historyTriggerFilter) && (
              <span style={styles.historyFilterCount}>
                {filteredHistory.length} / {historyForSite.length}
              </span>
            )}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={styles.historyFilterLabel}>
              <span style={styles.historyFilterLabelText}>Status</span>
              <select
                value={historyStatusFilter}
                onChange={(e) => setHistoryStatusFilter(e.target.value)}
                style={styles.historyFilterSelect}
                disabled={historyStatusOptions.length === 0}
              >
                <option value="">All ({historyForSite.length})</option>
                {historyStatusOptions.map(([v, n]) => (
                  <option key={v} value={v}>{v} ({n})</option>
                ))}
              </select>
            </label>
            <label style={styles.historyFilterLabel}>
              <span style={styles.historyFilterLabelText}>Type</span>
              <select
                value={historyTypeFilter}
                onChange={(e) => setHistoryTypeFilter(e.target.value)}
                style={styles.historyFilterSelect}
                disabled={historyTypeOptions.length === 0}
              >
                <option value="">All ({historyForSite.length})</option>
                {historyTypeOptions.map(([v, n]) => (
                  <option key={v} value={v}>{v} ({n})</option>
                ))}
              </select>
            </label>
            <label style={styles.historyFilterLabel}>
              <span style={styles.historyFilterLabelText}>Trigger</span>
              <select
                value={historyTriggerFilter}
                onChange={(e) => setHistoryTriggerFilter(e.target.value)}
                style={styles.historyFilterSelect}
                disabled={historyTriggerOptions.length === 0}
              >
                <option value="">All ({historyForSite.length})</option>
                {historyTriggerOptions.map(([v, n]) => (
                  <option key={v} value={v}>{v} ({n})</option>
                ))}
              </select>
            </label>
            <button
              onClick={refreshHistory}
              style={{
                padding: '4px 10px', fontSize: 11,
                border: '1px solid var(--border)', borderRadius: 3,
                background: 'var(--panel)', color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              {t('scheduler.button.refresh')}
            </button>
          </div>
        </div>
        {filteredHistory.length === 0 ? (
          <div style={{ color: 'var(--text-3)' }}>{t('scheduler.history.empty')}</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, width: 22 }} aria-label="expand"></th>
                <th style={styles.th}>{t('scheduler.history.col.runId')}</th>
                <th style={styles.th}>{t('scheduler.history.col.project')}</th>
                <th style={styles.th}>{t('scheduler.history.col.type')}</th>
                <th style={styles.th}>{t('scheduler.history.col.trigger')}</th>
                <th style={styles.th}>{t('scheduler.history.col.worker')}</th>
                <th style={styles.th}>{t('scheduler.history.col.tables')}</th>
                <th style={styles.th}>{t('scheduler.history.col.status')}</th>
                <th style={styles.th}>{t('scheduler.history.col.started')}</th>
                <th style={styles.th}>{t('scheduler.history.col.finished')}</th>
                <th
                  style={styles.th}
                  title={t('projectSettings.schedule.history.col.duration.tooltip')}
                >
                  {t('scheduler.history.col.duration')}
                </th>
                <th style={styles.th}>{t('scheduler.history.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((h) => {
                const expanded = expandedRunIds.has(h.id);
                const canExpand = h.tableSummary.total > 0;
                const s = h.tableSummary;
                return (
                  <Fragment key={h.id}>
                    <tr
                      onClick={canExpand ? () => toggleExpandedRun(h.id) : undefined}
                      style={{ cursor: canExpand ? 'pointer' : 'default' }}
                    >
                      <td style={{ ...styles.td, textAlign: 'center', padding: '4px 4px' }}>
                        {canExpand && (
                          <span style={{ color: 'var(--text-3)', fontSize: 11, userSelect: 'none' }}>
                            {expanded ? '▾' : '▸'}
                          </span>
                        )}
                      </td>
                      <td style={styles.td}><code>{h.id}</code></td>
                      <td style={styles.td}>
                        <div>{h.projectName}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-4)' }}><code>{h.projectId}</code></div>
                      </td>
                      <td style={styles.td}>{h.runType}</td>
                      <td style={styles.td}>{h.triggerSource}</td>
                      <td style={styles.td}>{h.workerId ?? '-'}</td>
                      <td style={styles.td}>
                        {s.total === 0 ? (
                          <span
                            title={h.tables == null
                              ? t('scheduler.history.tables.all')
                              : `partial: ${h.tables.length}\n${h.tables.join('\n')}`}
                            style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 11 }}
                          >
                            —
                          </span>
                        ) : (
                          <span
                            title={h.tables == null
                              ? t('scheduler.history.tables.all')
                              : `partial: ${h.tables.length}\n${h.tables.join('\n')}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 11 }}
                          >
                            <span style={{ color: 'var(--text-3)' }}>{s.total}</span>
                            {s.success > 0 && <span style={schedSummaryBadge('#166534', '#dcfce7', '#86efac')}>{s.success}✓</span>}
                            {s.failed > 0 && <span style={schedSummaryBadge('#991b1b', '#fee2e2', '#fca5a5')}>{s.failed}✗</span>}
                            {s.running > 0 && <span style={schedSummaryBadge('#92400e', '#fef3c7', '#fcd34d')}>{s.running}</span>}
                          </span>
                        )}
                      </td>
                      <td style={styles.td}>
                        <span style={statusStyle(h.status)}>{h.status}</span>
                      </td>
                      <td style={styles.td}>{formatTimestamp(h.startedAt)}</td>
                      <td style={styles.td}>{h.finishedAt ? formatTimestamp(h.finishedAt) : '-'}</td>
                      <td
                        style={styles.td}
                        title={t('projectSettings.schedule.history.col.duration.tooltip')}
                      >
                        {formatDuration(h.durationMs)}
                      </td>
                      <td style={styles.td}>
                        {h.status === 'running' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleAbort(h.id); }}
                            style={styles.iconBtn}
                            title={t('scheduler.tooltip.abort')}
                            aria-label={t('scheduler.action.abort')}
                          >
                            ⏹
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={12} style={{ padding: 0, background: 'var(--panel-2)' }}>
                          <SchedulerRunDrilldown runId={h.id} t={t} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

    </div>
  );
}

function formatError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

const schedSummaryBadge = (color: string, bg: string, border: string): React.CSSProperties => ({
  display: 'inline-block', padding: '0 5px', borderRadius: 3,
  fontSize: 10, fontWeight: 700, border: `1px solid ${border}`,
  color, background: bg, lineHeight: '14px',
});

/**
 * Scheduler Run History の per-table drill-down sub-row. LogViewerPage の
 * HistoryRunDrilldown と同じく BE /runs/{id}/table-results を取得して表示.
 */
function SchedulerRunDrilldown({ runId, t }: { runId: string; t: (k: string, v?: Record<string, string>) => string }) {
  const { data, isLoading, isError } = useQuery<RunTableResult[]>({
    queryKey: ['run-table-results', runId],
    queryFn: () => runsApi.tableResults(runId),
    staleTime: 5_000,
  });
  if (isLoading) return <div style={schedDrillStyles.note}>{t('projectSettings.schedule.history.drilldown.loading')}</div>;
  if (isError) return <div style={{ ...schedDrillStyles.note, color: 'var(--red)' }}>{t('projectSettings.schedule.history.drilldown.error')}</div>;
  if (!data || data.length === 0) return <div style={schedDrillStyles.note}>{t('projectSettings.schedule.history.drilldown.empty')}</div>;
  return (
    <div style={schedDrillStyles.wrap}>
      <table style={schedDrillStyles.table}>
        <thead>
          <tr>
            <th style={schedDrillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.status')}</th>
            <th style={schedDrillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.table')}</th>
            <th style={{ ...schedDrillStyles.th, textAlign: 'right' }}>{t('projectSettings.schedule.history.drilldown.col.rows')}</th>
            <th style={schedDrillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.started')}</th>
            <th style={schedDrillStyles.th}>{t('projectSettings.schedule.history.drilldown.col.finished')}</th>
            <th style={{ ...schedDrillStyles.th, textAlign: 'right' }}>{t('projectSettings.schedule.history.drilldown.col.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => {
            const fullName = r.tobeSchema ? `${r.tobeSchema}.${r.tobeTable}` : r.tobeTable;
            const color = r.status === 'success' ? '#166534'
              : r.status === 'failed' ? '#991b1b'
              : '#92400e';
            const icon = r.status === 'success' ? '✓' : r.status === 'failed' ? '✗' : '';
            return (
              <tr key={fullName}>
                <td style={{ ...schedDrillStyles.td, color, fontWeight: 700 }}>{icon} {r.status}</td>
                <td style={schedDrillStyles.td}>{fullName}</td>
                <td style={{ ...schedDrillStyles.td, textAlign: 'right' }}>{r.rows.toLocaleString()}</td>
                <td style={schedDrillStyles.td}>{r.startedAt ? formatTimeMs(r.startedAt) : '—'}</td>
                <td style={schedDrillStyles.td}>{r.finishedAt ? formatTimeMs(r.finishedAt) : '—'}</td>
                <td style={{ ...schedDrillStyles.td, textAlign: 'right' }}>{formatDuration(r.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const schedDrillStyles: Record<string, React.CSSProperties> = {
  wrap: { padding: '8px 12px 12px 36px', background: 'var(--panel-2)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' },
  th: {
    textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)',
    color: 'var(--text-3)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  td: { padding: '3px 8px', borderBottom: '1px dashed var(--border)', color: 'var(--text-2)' },
  note: { padding: '8px 12px 8px 36px', color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' },
};
function statusStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = { padding: '2px 6px', borderRadius: 3, fontSize: 11 };
  switch (status) {
    case 'running': return { ...base, background: '#fef3c7', color: '#92400e' };
    case 'success':
    case 'STARTED': return { ...base, background: '#dcfce7', color: '#166534' };
    case 'failed':
    case 'aborted':
    case 'timed_out':
    case 'rejected':
    case 'locked':
    case 'REJECTED':
    case 'LOCKED': return { ...base, background: '#fee2e2', color: '#991b1b' };
    default: return { ...base, background: 'var(--panel-2)', color: 'var(--text-2)' };
  }
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: 20, maxWidth: 1100, margin: '0 auto' },
  banner: {
    padding: '10px 14px', background: '#fee2e2', border: '1px solid #dc2626',
    color: '#991b1b', fontSize: 12, marginBottom: 20, lineHeight: 1.6,
  },
  iconBtn: {
    padding: '2px 8px', fontSize: 14, lineHeight: 1,
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--panel-2)', color: 'var(--text-2)',
    cursor: 'pointer',
  },
  h2: { fontSize: 20, marginTop: 0, marginBottom: 16 },
  h3: { fontSize: 14, marginTop: 0, marginBottom: 8 },
  section: { padding: 14, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 },
  /* Card section (Internal / External). cardHeader 부분이 toggle 行, cardBody 가 입력 행. */
  cardSection: {
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6,
    marginBottom: 16, overflow: 'hidden',
  },
  cardHeader: {
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16,
  },
  cardTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  cardDesc: { fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.55, maxWidth: 720 },
  cardBody: { padding: '4px 16px 14px' },
  hint: { fontSize: 11, color: 'var(--text-3)', padding: '8px 0' },
  titleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 16, gap: 12,
  },
  btnPrimaryDisabled: {
    background: 'var(--border-strong)', borderColor: 'var(--border-strong)',
    color: 'var(--text-3)', cursor: 'not-allowed',
  },
  rowField: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 0', borderBottom: '1px dashed var(--border)', minHeight: 48,
  },
  rowFieldLabel: { width: 220, flexShrink: 0 },
  rowFieldTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--text)' },
  rowFieldSub: { fontSize: 11, color: 'var(--text-3)', fontWeight: 400, marginTop: 3, lineHeight: 1.4 },
  modeRow: { padding: '10px 0', borderBottom: '1px dashed var(--border)' },
  modeLabel: { fontSize: 12.5, fontWeight: 600, color: 'var(--text)', marginBottom: 6 },
  radioLabel: {
    display: 'flex', alignItems: 'center', padding: '4px 0',
    fontSize: 12, color: 'var(--text)', cursor: 'pointer',
  },
  warnHint: {
    marginTop: 6, padding: '4px 8px', fontSize: 11,
    background: '#fef3c7', color: '#92400e',
    border: '1px solid #fbbf24', borderRadius: 3, display: 'inline-block',
  },
  input: {
    flex: 1, width: '100%', padding: '7px 10px',
    border: '1px solid var(--border-strong)', borderRadius: 4,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 12.5, fontFamily: 'var(--mono)', outline: 'none',
  },
  btnPrimary: {
    padding: '7px 18px', fontSize: 12.5, fontWeight: 600,
    border: '1px solid var(--navy)', borderRadius: 4,
    background: 'var(--navy)', color: '#fff', cursor: 'pointer',
    transition: 'background .08s, border-color .08s, opacity .08s',
  },
  errorBox: { padding: '8px 12px', background: '#fee2e2', border: '1px solid #dc2626', color: '#991b1b', borderRadius: 3, fontSize: 11, marginTop: 10 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-2)' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--border)' },
  historyFilterLabel: { display: 'inline-flex', alignItems: 'center', gap: 5 },
  historyFilterLabelText: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  historyFilterSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)',
    fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
    minWidth: 130,
  },
  historyFilterCount: {
    marginLeft: 8, fontSize: 11, fontWeight: 500,
    color: 'var(--text-3)', fontFamily: 'var(--mono)',
  },
};
