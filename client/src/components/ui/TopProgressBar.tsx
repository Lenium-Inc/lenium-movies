import { useEffect, useState } from "react";

/**
 * Global top progress bar for page transitions and data loading.
 * Shows a subtle animated bar at the top of the viewport.
 */
export function TopProgressBar({ isLoading }: { isLoading: boolean }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setProgress(0);
      return;
    }

    // Simulate progress animation
    let currentProgress = 0;
    const interval = setInterval(() => {
      currentProgress += Math.random() * 15;
      if (currentProgress > 90) currentProgress = 90;
      setProgress(currentProgress);
    }, 200);

    return () => clearInterval(interval);
  }, [isLoading]);

  useEffect(() => {
    if (isLoading && progress >= 90) {
      // Complete the progress when loading finishes
      const completeInterval = setInterval(() => {
        setProgress(p => {
          if (p >= 100) {
            clearInterval(completeInterval);
            return 100;
          }
          return p + 10;
        });
      }, 50);
      return () => clearInterval(completeInterval);
    }
  }, [isLoading, progress]);

  if (!isLoading && progress === 0) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 h-1 z-[100] bg-transparent pointer-events-none"
      role="progressbar"
      aria-valuenow={Math.round(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Loading progress"
    >
      <div
        className="h-full bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-600 transition-all duration-300 ease-out"
        style={{ width: `${Math.min(progress, 100)}%` }}
      />
      <div className="absolute top-0 right-0 h-full w-12 bg-gradient-to-l from-transparent to-indigo-500 opacity-50" />
    </div>
  );
}

/**
 * Hook to manage global loading state across the app
 */
export function useTopProgress() {
  const [loadingCount, setLoadingCount] = useState(0);

  const startLoading = () => setLoadingCount(c => c + 1);
  const stopLoading = () => setLoadingCount(c => Math.max(0, c - 1));

  return {
    isLoading: loadingCount > 0,
    startLoading,
    stopLoading,
  };
}
