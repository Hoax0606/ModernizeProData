-- ==========================================================================
--  Project: organization (営業店・社員)
--  AS-IS Oracle. Self-referencing FK (branch parent / employee manager) +
--  cross-table FK (employee → branch). 02_master の M_* には依存しない。
-- ==========================================================================

-- --------------------------------------------------------------------------
--  営業店マスタ (Branch master) — 自己参照 FK + 稼働フラグ
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_M_BRANCH START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE M_BRANCH (
    BRANCH_ID          NUMBER(8)      NOT NULL,
    BRANCH_CD          VARCHAR2(10)   NOT NULL,
    BRANCH_NM          VARCHAR2(80)   NOT NULL,
    PARENT_BRANCH_ID   NUMBER(8),
    ADDRESS            VARCHAR2(500),
    OPENED_DT          DATE           NOT NULL,
    ACTIVE_FLG         CHAR(1)        DEFAULT 'Y' NOT NULL,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT PK_M_BRANCH         PRIMARY KEY (BRANCH_ID),
    CONSTRAINT UK_M_BRANCH_CD      UNIQUE (BRANCH_CD),
    CONSTRAINT CK_M_BRANCH_ACTIVE  CHECK (ACTIVE_FLG IN ('Y', 'N')),
    CONSTRAINT FK_M_BRANCH_PARENT  FOREIGN KEY (PARENT_BRANCH_ID) REFERENCES M_BRANCH (BRANCH_ID)
);

COMMENT ON TABLE  M_BRANCH                  IS '営業店マスタ';
COMMENT ON COLUMN M_BRANCH.PARENT_BRANCH_ID IS '上位営業店 ID. NULL は本部 / 統括拠点.';
COMMENT ON COLUMN M_BRANCH.ACTIVE_FLG       IS '稼働フラグ Y=有効 / N=停止';

-- --------------------------------------------------------------------------
--  社員マスタ (Employee master) — 営業店 N:1 + 上司 self-ref FK
-- --------------------------------------------------------------------------
CREATE SEQUENCE SEQ_M_EMPLOYEE START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE M_EMPLOYEE (
    EMPLOYEE_ID        NUMBER(10)     NOT NULL,
    EMPLOYEE_CD        VARCHAR2(20)   NOT NULL,
    EMPLOYEE_NM        VARCHAR2(100)  NOT NULL,
    BRANCH_ID          NUMBER(8)      NOT NULL,
    MANAGER_ID         NUMBER(10),
    ROLE_CD            VARCHAR2(10)   NOT NULL,
    EMAIL              VARCHAR2(128)  NOT NULL,
    HIRED_DT           DATE           NOT NULL,
    ACTIVE_FLG         CHAR(1)        DEFAULT 'Y' NOT NULL,
    ENTRY_TS           DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT PK_M_EMPLOYEE        PRIMARY KEY (EMPLOYEE_ID),
    CONSTRAINT UK_M_EMPLOYEE_CD     UNIQUE (EMPLOYEE_CD),
    CONSTRAINT UK_M_EMPLOYEE_EMAIL  UNIQUE (EMAIL),
    CONSTRAINT CK_M_EMPLOYEE_ROLE   CHECK (ROLE_CD IN ('営業', '管理', '事務', '監査', 'IT')),
    CONSTRAINT CK_M_EMPLOYEE_ACTIVE CHECK (ACTIVE_FLG IN ('Y', 'N')),
    CONSTRAINT FK_M_EMPLOYEE_BR     FOREIGN KEY (BRANCH_ID)  REFERENCES M_BRANCH (BRANCH_ID),
    CONSTRAINT FK_M_EMPLOYEE_MGR    FOREIGN KEY (MANAGER_ID) REFERENCES M_EMPLOYEE (EMPLOYEE_ID)
);

COMMENT ON TABLE  M_EMPLOYEE             IS '社員マスタ';
COMMENT ON COLUMN M_EMPLOYEE.MANAGER_ID  IS '上司の EMPLOYEE_ID (自己参照, NULL 可)';
COMMENT ON COLUMN M_EMPLOYEE.ROLE_CD     IS '職種 営業 / 管理 / 事務 / 監査 / IT';
