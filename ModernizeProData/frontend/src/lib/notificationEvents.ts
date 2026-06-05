import type { TranslationKey } from '../i18n';

/**
 * Solution Settings 의 "All-project notifications" 에 표시되는 글로벌 이벤트 목록.
 *
 * 이 이벤트들은 전 프로젝트 공통(global)으로만 on/off 한다 — 프로젝트별 설정은 없다.
 * 여기 없는 이벤트(run.* / 승인 등)는 토글이 없으므로 항상 알림이 뜬다(default true).
 *
 * i18n: label/desc 는 기존 `projectSettings.notify.event.*` 키 재사용
 * (정책상 label 은 ko/ja/en 동일 영문, desc 는 언어별 번역).
 */
export interface NotificationEventDef {
  k: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
}

export const GLOBAL_EVENTS: NotificationEventDef[] = [
  { k: 'snapshot.created',  labelKey: 'projectSettings.notify.event.snapCreated.label',     descKey: 'projectSettings.notify.event.snapCreated.desc' },
  { k: 'snapshot.deleted',  labelKey: 'projectSettings.notify.event.snapDeleted.label',     descKey: 'projectSettings.notify.event.snapDeleted.desc' },
  { k: 'snapshot.baseline', labelKey: 'projectSettings.notify.event.snapBaseline.label',    descKey: 'projectSettings.notify.event.snapBaseline.desc' },
  { k: 'ddl.imported',      labelKey: 'projectSettings.notify.event.ddlImported.label',     descKey: 'projectSettings.notify.event.ddlImported.desc' },
  { k: 'project.created',   labelKey: 'projectSettings.notify.event.projectCreated.label',  descKey: 'projectSettings.notify.event.projectCreated.desc' },
  { k: 'project.phase',     labelKey: 'projectSettings.notify.event.phaseChanged.label',    descKey: 'projectSettings.notify.event.phaseChanged.desc' },
  { k: 'project.assignee',  labelKey: 'projectSettings.notify.event.assigneeChanged.label', descKey: 'projectSettings.notify.event.assigneeChanged.desc' },
];
