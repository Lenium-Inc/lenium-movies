import { useEffect, useState } from "react";

const EVENT = "freestream:stats";

/**
 * Bump counter whenever watch stats are saved so components that read the
 * localStorage stats can re-derive on playback progress / achievements.
 */
export function useStatsRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const handler = () => setRevision(revision => revision + 1);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  return revision;
}