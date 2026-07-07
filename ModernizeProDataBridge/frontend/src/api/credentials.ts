import { api, unwrap, type ApiResponse } from './client';

/**
 * Scheduler ページ External integrations カードの API token 関連 endpoint.
 *
 * 外部スケジューラが token を発行し、本ツールはそれを登録するのみ (register).
 *   - GET    /api/v1/credentials/current     — 現 default credential の masked display
 *   - POST   /api/v1/credentials/register    — 外部から受け取った平文 token を登録 (旧 default 自動 revoke)
 *   - POST   /api/v1/credentials/{id}/revoke — 明示的 revoke
 */

export interface CurrentCredentialDto {
  credentialId: string | null;
  maskedDisplay: string | null;
  /** ⚠ 平文 token. PoC 要件で BE が平文保管 → 別 session でも表示可. security 妥協. */
  tokenPlain: string | null;
  active: boolean;
  generatedAt: string | null;
  lastUsedAt: string | null;
}

export interface RegisterRequest {
  plainToken: string;       // 外部スケジューラが発行した平文 token.
}

export interface RegisterResultDto {
  credentialId: string;
  maskedDisplay: string;
  /** ⚠ 同上 — register 直後にも plain を return. */
  tokenPlain: string;
}

export const credentialsApi = {
  /** 現 default の masked display 取得. 未登録なら active=false. */
  getCurrent: () =>
    unwrap(api.get<ApiResponse<CurrentCredentialDto>>('/api/v1/credentials/current')),

  /** 外部スケジューラが発行した token を登録. 旧 default は自動 revoke. */
  register: (req: RegisterRequest) =>
    unwrap(api.post<ApiResponse<RegisterResultDto>>('/api/v1/credentials/register', req)),

  /** 指定 credential を revoke. */
  revoke: (id: string) =>
    unwrap(api.post<ApiResponse<unknown>>(`/api/v1/credentials/${id}/revoke`)),
};
