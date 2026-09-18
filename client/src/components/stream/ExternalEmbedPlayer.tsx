import React, { useEffect, useRef, useState, useCallback } from "react";
import { Maximize, Monitor, ExternalLink, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { isExternalEmbedUrl, getEmbedHostName } from "@/lib/streamUtils";

export interface ExternalEmbedPlayerProps {
  streamUrl: string;
  title: string;
  poster: string;
  onClose: () => void;
  movie?: {
    id: string;
    title: string;
    media_type?: "movie" | "tv";
    season?: number;
    episode?: number;
  };
  mediaType?: "movie" | "tv";
  season?: number;
  episode?: number;
  isLoading?: boolean;
  playbackError?: string | null;
  onRetry?: () => void;
  onIframeLoad?: () => void;
}

export function ExternalEmbedPlayer({
  streamUrl,
  title,
  poster,
  onClose,
  movie,
  mediaType,
  season,
  episode,
  isLoading = false,
  playbackError,
  onRetry,
  onIframeLoad,
}: ExternalEmbedPlayerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [localError, setLocalError] = useState<string | null>(playbackError || null);
  const playerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hostName = getEmbedHostName(streamUrl);

  useEffect(() => {
    setLocalError(playbackError || null);
  }, [playbackError]);

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  }, []);

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true);
    setLocalError(null);
    onIframeLoad?.();
  }, [onIframeLoad]);

  const handleIframeError = useCallback(() => {
    setLocalError("Failed to load external player. The provider may be blocking embedding.");
    setIframeLoaded(false);
  }, []);

  const handleRetry = useCallback(() => {
    setLocalError(null);
    setIframeLoaded(false);
    if (iframeRef.current) {
      iframeRef.current.src = streamUrl;
    }
    onRetry?.();
  }, [streamUrl, onRetry]);

  const toggleFullscreen = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!document.fullscreenElement) {
      player.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      switch (e.key) {
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "Escape":
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
      }
    },
    [toggleFullscreen]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const preventContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div
      ref={playerRef}
      onMouseMove={handleMouseMove}
      onContextMenu={preventContextMenu}
      className="relative w-full h-full aspect-video rounded-2xl overflow-hidden bg-black select-none font-sans"
    >
      {/* Background Poster / Loading State / Error State */}
      {!iframeLoaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
            <img
              src={poster}
              alt={title}
              className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm"
            />
            <div className="relative z-20 flex flex-col items-center gap-4">
              {localError ? (
                <div className="text-center max-w-md px-4">
                  <AlertCircle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
                  <p className="text-white/80 font-medium text-sm tracking-wider mb-3">
                    {localError}
                  </p>
                  <button
                    onClick={handleRetry}
                    className="flex items-center gap-2 mx-auto px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-white text-sm font-medium transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                  </button>
                </div>
              ) : (
                <div className="text-center">
                  <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-white/80 font-medium text-sm tracking-wider">
                    Connecting to {hostName}...
                  </p>
                  <p className="text-xs text-white/50 mt-1">External player - controls provided by provider</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Iframe Embed */}
      <iframe
        ref={iframeRef}
        src={streamUrl}
        title={`${title} - external player`}
        className="w-full h-full border-0"
        allowFullScreen
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media; accelerometer; clipboard-write"
        referrerPolicy="origin"
        onLoad={handleIframeLoad}
        onError={handleIframeError}
      />

      {/* Top Header Overlay */}
      <div
        className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-white text-base font-semibold tracking-wide drop-shadow-md truncate">
            {title}
          </h1>
          {mediaType === "tv" && season && episode && (
            <span className="px-2 py-0.5 text-xs font-medium bg-white/10 border border-white/10 rounded text-white/80">
              S{season} E{episode}
            </span>
          )}
          <span className="px-2 py-0.5 text-xs font-medium bg-blue-500/20 border border-blue-500/30 rounded text-blue-400 flex items-center gap-1">
            <Monitor className="h-3 w-3" />
            {hostName} (External)
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-black/40 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all flex-shrink-0"
          aria-label="Close player"
        >
          <Maximize className="w-4 h-4 rotate-45" />
        </button>
      </div>

      {/* Bottom Controls - Minimal for external embeds */}
      <div
        className={`absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <div className="flex items-center gap-3 text-white/70 text-xs">
          <span className="flex items-center gap-1">
            <ExternalLink className="w-3 h-3" />
            Playing via {hostName}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleFullscreen}
            className="hover:text-red-500 transition-colors flex-shrink-0"
            aria-label="Fullscreen"
          >
            <Maximize className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* External player notice - shown briefly on load */}
      {!iframeLoaded && !localError && (
        <div
          className="absolute bottom-4 left-4 right-4 z-20 animate-fade-in"
          style={{ animation: "fadeIn 0.3s ease-out" }}
        >
          <div className="bg-black/80 backdrop-blur-md border border-white/10 rounded-lg p-3 text-center text-white/80 text-sm">
            <p className="flex items-center justify-center gap-2">
              <Monitor className="w-4 h-4" />
              Loading external player from <strong>{hostName}</strong> — playback controls are provided by the embed provider.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}