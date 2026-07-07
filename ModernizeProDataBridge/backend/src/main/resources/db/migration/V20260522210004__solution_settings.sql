-- feature/schedule: Solution-level configuration (단일 row, id=1).
--
-- 主用途:
--   - Internal scheduler (Quartz Nightly) ON/OFF + mode (common/individual) + 共通時刻
--   - External integrations (REST/CLI 외부 트리거) ON/OFF + 연계 정보
--   - 둘은 mutex (DB CHECK 制約 + 서비스 계층 auto-flip 양면 강제). 양쪽 OFF 는 허용.
--
-- internal_mode:
--   'common'     — solution_settings.internal_common_time 으로 全 project 一斉 발화
--   'individual' — project.schedule_start_time 으로 project 별 발화
--   NULL         — internal_enabled=false 일 때. ON 으로 만들 때는 mode 명시 필수.

CREATE TABLE solution_settings (
    id                          INTEGER      PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Internal scheduler
    internal_enabled            BOOLEAN      NOT NULL DEFAULT FALSE,
    internal_mode               VARCHAR(16),
    internal_common_time        TIME,

    -- External integrations
    external_enabled            BOOLEAN      NOT NULL DEFAULT FALSE,
    /* External API endpoint — 外部スケジューラ / curl がアクセスする本ツール URL.
       Trigger examples docs に substitute される. master が UI で明示入力する. */
    external_api_endpoint       VARCHAR(512),

    updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by                  VARCHAR(64),

    -- Internal/External 동시 ON 금지 (둘 다 OFF 는 허용)
    CONSTRAINT solution_settings_mutex_chk
        CHECK (NOT (internal_enabled AND external_enabled)),

    -- internal_mode 値 制約
    CONSTRAINT solution_settings_internal_mode_chk
        CHECK (internal_mode IS NULL OR internal_mode IN ('common', 'individual'))
);

-- 단일 row 강제 — startup 時 SolutionSettingsRepository.get() 이 참조.
INSERT INTO solution_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
