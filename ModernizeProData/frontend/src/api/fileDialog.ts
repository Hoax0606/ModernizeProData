import { api, unwrap, type ApiResponse } from './client';

export interface PickResult {
  path: string | null;
  cancelled: boolean;
}

export const fileDialogApi = {
  /**
   * Open an OS-native folder picker on the machine running the backend.
   * Returns the absolute path, or { cancelled: true } if the user dismissed.
   *
   * Works because backend ships co-located with the desktop app (jpackage)
   * — backend and browser run on the same user PC.
   */
  pickDirectory: (startPath?: string, title?: string): Promise<PickResult> =>
    unwrap(api.post<ApiResponse<PickResult>>('/api/v1/util/pick-directory', {
      startPath: startPath ?? null,
      title: title ?? null,
    })),
};
