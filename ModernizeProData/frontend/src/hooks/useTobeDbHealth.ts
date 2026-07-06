import { useQuery } from '@tanstack/react-query';
import { tobeDbApi, type TobeDbHealth } from '../api/tobeDb';

/**
 * 환경별 TO-BE DB 실시간 도달성 polling.
 *
 * - 컴포넌트가 mount 되어 있는 동안만 poll → 아무도 안 보면 probe 안 함.
 * - 서버측 5s 캐시가 있어 brower 여러 개여도 실제 DB probe 는 (site,env)당 5s 1회.
 * - `siteId` 가 실제 사이트(s-…)일 때만 enabled. 생성 중(미저장) 사이트는 skip.
 *
 * @param siteId   대상 사이트 id ('' / 미저장이면 disabled)
 * @param enabled  추가 게이트 (예: 모달 열림 / 화면 활성). 기본 true.
 * @param intervalMs polling 주기. 기본 10s.
 */
export function useTobeDbHealth(
  siteId: string | null | undefined,
  enabled = true,
  intervalMs = 10_000,
) {
  const on = !!siteId && siteId.startsWith('s-') && enabled;
  const query = useQuery<TobeDbHealth>({
    queryKey: ['tobe-db-health', siteId],
    enabled: on,
    queryFn: () => tobeDbApi.health(siteId!),
    refetchInterval: on ? intervalMs : false,
    staleTime: intervalMs - 2_000,
    retry: false,
  });
  return query.data;
}
