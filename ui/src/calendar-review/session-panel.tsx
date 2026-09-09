"use client";

import { useSyncExternalStore } from "react";
import type { CalendarReviewHttpSession } from "./http-session.ts";
import { CalendarReviewPanel } from "./review-panel";

/** Inactive composition, not an app route. The parent owns the session and
 * must bind on every identity/tenant/token transition and dispose on logout.
 * Unmount cancels this panel's reads, but does not dispose a shared session.
 */
export function CalendarReviewSessionPanel({
  session,
}: {
  session: CalendarReviewHttpSession;
}) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  return (
    <CalendarReviewPanel {...snapshot} onClearSession={() => session.clear()} />
  );
}
