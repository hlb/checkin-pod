export const CAMERA_CODE_RELEASE_MS = 1_500;

export type CameraScanState = Readonly<{
  code: string;
  lastSeenAt: number;
}>;

export const EMPTY_CAMERA_SCAN_STATE: CameraScanState = {
  code: "",
  lastSeenAt: 0,
};

export function advanceCameraScanState(
  state: CameraScanState,
  detectedCode: string,
  now: number,
): { state: CameraScanState; codeToScan: string | null } {
  const code = detectedCode.trim();
  if (!code) {
    if (state.code && now - state.lastSeenAt >= CAMERA_CODE_RELEASE_MS) {
      return { state: EMPTY_CAMERA_SCAN_STATE, codeToScan: null };
    }
    return { state, codeToScan: null };
  }

  const nextState = { code, lastSeenAt: now };
  return {
    state: nextState,
    codeToScan: code === state.code ? null : code,
  };
}
