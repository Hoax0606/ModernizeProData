-- License v2: bind to a specific PC via Windows MachineGuid (or Linux machine-id).
--
-- Nullable so already-imported v=1 licenses keep working unchanged. When set,
-- LicenseService.currentStatus() compares against HardwareFingerprint.value()
-- and reports LicenseStatus.INVALID on mismatch (LicenseEnforcementFilter then
-- blocks every non-license endpoint).
ALTER TABLE license
    ADD COLUMN hardware_id varchar(128);
