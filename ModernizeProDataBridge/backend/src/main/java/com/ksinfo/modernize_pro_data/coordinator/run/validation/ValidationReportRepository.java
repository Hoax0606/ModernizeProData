package com.ksinfo.modernize_pro_data.coordinator.run.validation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ValidationReportRepository extends JpaRepository<ValidationReport, String> {

    /** 한 run 의 모든 binding 결과 일람 — Artifacts 페이지 multi-table 뷰. */
    List<ValidationReport> findByRunId(String runId);

    /** Artifacts 페이지의 단일 binding 조회. */
    Optional<ValidationReport> findByRunIdAndBindingId(String runId, String bindingId);

    /** TO-BE 물리 테이블명으로 조회 — FE 가 binding ID 모르고 tableName 만 가진 경우 fallback. */
    Optional<ValidationReport> findByRunIdAndTobeTable(String runId, String tobeTable);
}
