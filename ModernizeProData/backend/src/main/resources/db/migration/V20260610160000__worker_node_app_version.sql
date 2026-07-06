-- Worker daemon 이 self-register / heartbeat 시 보고하는 설치 앱 버전 (예: 1.0.25).
-- 빌드가 -Dmodernize.version 으로 주입한 값. User Management(Worker Nodes 탭)에서
-- 각 워커의 버전을 표시하기 위한 컬럼. 구버전 워커(미보고)는 NULL.
ALTER TABLE worker_node ADD COLUMN app_version VARCHAR(32);
