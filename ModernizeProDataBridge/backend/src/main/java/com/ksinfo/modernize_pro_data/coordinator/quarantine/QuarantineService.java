package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

/**
 * Stage runner 가 validation 위반 row 발견 시 호출.
 * 한 (run, stage, binding, rule) 묶음을 1 row 로 저장.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class QuarantineService {

    private final QuarantineEntryRepository repo;

    @Transactional
    public QuarantineEntry record(String runId, String stageInstanceId, String bindingId,
                                  String ruleId, String ruleName,
                                  QuarantineSeverity severity,
                                  Map<String, Object> sampleData,
                                  long rowCount, Long logLineSeq) {
        QuarantineEntry q = QuarantineEntry.create(runId, stageInstanceId, bindingId,
                ruleId, ruleName, severity, sampleData, rowCount, logLineSeq);
        log.info("quarantine recorded runId={} stage={} binding={} rule={} severity={} rows={}",
                runId, stageInstanceId, bindingId, ruleName, severity, rowCount);
        return repo.save(q);
    }
}
