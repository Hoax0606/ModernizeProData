-- Add unique constraints:
--   sites: name is globally unique
--   projects: (site_id, name) is unique (same name OK in different sites)
--
-- Existing duplicates (PoC data) are renamed with a (dup-<id-suffix>) tag
-- before the constraint is applied, so the migration cannot fail on legacy
-- rows. Operators can rename them back manually if needed.

UPDATE sites s
   SET name = s.name || ' (dup-' || substring(s.id, 3) || ')'
 WHERE EXISTS (
       SELECT 1
         FROM sites s2
        WHERE s2.name = s.name
          AND s2.created_at < s.created_at
       );

ALTER TABLE sites
  ADD CONSTRAINT uq_sites_name UNIQUE (name);

UPDATE projects p
   SET name = p.name || ' (dup-' || substring(p.id, 3) || ')'
 WHERE EXISTS (
       SELECT 1
         FROM projects p2
        WHERE p2.site_id = p.site_id
          AND p2.name = p.name
          AND p2.created_at < p.created_at
       );

ALTER TABLE projects
  ADD CONSTRAINT uq_projects_site_name UNIQUE (site_id, name);
