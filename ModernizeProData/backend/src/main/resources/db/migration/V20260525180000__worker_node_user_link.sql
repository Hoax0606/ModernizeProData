-- Phase 5 redesign: worker_node is now tied to a Coordinator admin user.
--
-- Earlier model: master issued a WK-* token; Worker auth'd with that token.
-- New model: master creates an admin-role user (= "Worker" in roleLabel) with
-- a site_id; the Worker daemon logs in with that user's password to its
-- Coordinator and self-registers a worker_node row tied to that user. No
-- separate token issuance.

-- 1. users.site_id -- which site does this admin/Worker user belong to.
--    Null for master and viewer; required (by app logic, not by SQL) when
--    role = admin so self-register knows where to place the worker.
ALTER TABLE users
    ADD COLUMN site_id varchar(40) REFERENCES sites(id) ON DELETE SET NULL;

-- 2. Drop the token columns that no longer apply.
ALTER TABLE worker_node DROP COLUMN token_hash;
ALTER TABLE worker_node DROP COLUMN token_prefix;

-- 3. Link worker_node to the issuing user. ON DELETE CASCADE so deleting the
--    admin user also wipes their worker_node row (no orphan rows after a
--    revoke-via-user-delete).
ALTER TABLE worker_node
    ADD COLUMN user_id varchar(40) REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX idx_worker_node_user ON worker_node (user_id);
