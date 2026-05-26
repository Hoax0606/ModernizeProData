package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface QuarantineEntryRepository extends JpaRepository<QuarantineEntry, String> {

    List<QuarantineEntry> findByRunIdOrderByCreatedAtAsc(String runId);

    List<QuarantineEntry> findByRunIdInOrderByCreatedAtAsc(List<String> runIds);
}
