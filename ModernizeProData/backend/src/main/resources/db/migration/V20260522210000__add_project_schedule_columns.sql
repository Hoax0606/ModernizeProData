-- feature/schedule: projects 에 schedule 関連 column 추가.
--
-- solution_settings.internal_mode 가 'individual' 일 때만 schedule_start_time 가
-- 사용됨. mode='common' 시는 solution_settings.internal_common_time 가 사용.
--
-- schedule_next_run_at 는 Quartz 가 계산한 다음 발화 시각의 cache (UI 표시 용).
-- schedule_last_run_at 는 마지막 실행 시각 (misfire 판정 용).

ALTER TABLE projects
    ADD COLUMN schedule_start_time   TIME,
    ADD COLUMN schedule_last_run_at  TIMESTAMPTZ,
    ADD COLUMN schedule_next_run_at  TIMESTAMPTZ;

-- "이 project 가 schedule 에 참여하는가" 의 partial index.
-- mode='individual' 時 SchedulerInitializer.rescheduleAllNightly() 가 조회.
CREATE INDEX idx_projects_schedule_start_time
    ON projects (schedule_start_time)
    WHERE schedule_start_time IS NOT NULL;
