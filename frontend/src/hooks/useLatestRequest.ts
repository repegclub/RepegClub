import { useCallback, useRef } from "react";

// Guards against stale-response races in hooks that fetch async data: if two
// calls to `load()` overlap (e.g. the wallet or selected round changes twice
// quickly) and the older request resolves after the newer one, its result
// must not overwrite state that the newer request already set. Call `start()`
// once per load, then only apply the result if `isCurrent(token)` is still
// true when the async work finishes.
export function useLatestRequest() {
  const tokenRef = useRef(0);

  const start = useCallback(() => ++tokenRef.current, []);
  const isCurrent = useCallback((token: number) => token === tokenRef.current, []);

  return { start, isCurrent };
}
