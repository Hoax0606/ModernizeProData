package com.ksinfo.modernize_pro_data.common.perf;

import jakarta.persistence.EntityManagerFactory;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 60s 간격으로 Hibernate Statistics dump — PG axis 측정 핵심.
 *
 * 출력: queryCount / queryMaxMs / sessionCount / entity/collection fetch / maxQuery.
 * 매 dump 후 {@code stats.clear()} → 각 라인은 "지난 60s" 단위 sample.
 *
 * 활성 조건: dev profile + modernize.perf.enabled=true + application-dev.yml 의
 * spring.jpa.properties.hibernate.generate_statistics=true.
 */
@Component
@Profile("dev")
@ConditionalOnProperty(name = "modernize.perf.enabled", havingValue = "true")
@RequiredArgsConstructor
@Slf4j
public class HibernateStatsDumper {

    private final EntityManagerFactory entityManagerFactory;

    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    public void dump() {
        Statistics stats = entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
        if (!stats.isStatisticsEnabled()) return;

        long qc = stats.getQueryExecutionCount();
        long qmax = stats.getQueryExecutionMaxTime();
        String qmaxQ = stats.getQueryExecutionMaxTimeQueryString();
        long sc = stats.getSessionOpenCount();
        long entityFetch = stats.getEntityFetchCount();
        long collectionFetch = stats.getCollectionFetchCount();

        log.info("[perf] hibernate queryCount={} queryMaxMs={} sessionCount={} entityFetch={} collectionFetch={} maxQuery=\"{}\"",
                qc, qmax, sc, entityFetch, collectionFetch,
                qmaxQ == null ? "-" : qmaxQ.replace('\n', ' ').replace('"', '\''));

        stats.clear();
    }
}
