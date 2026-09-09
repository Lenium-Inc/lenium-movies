// player/VideoPlayer.tsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize, Settings, Subtitles, X, Loader2, WifiOff, Server, Monitor } from 'lucide-react';

export interface StreamMirror {
  name: string;
  url: string;
}

export interface VideoPlayerProps {
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
    mirrors?: StreamMirror[];
  };
  mirrors?: StreamMirror[];
  season?: number;
  episode?: number;
  mediaType?: "movie" | "tv";
  onPlayEpisode?: (season: number, episode: number) => void;
}

const QUALITY_ORDER = ['480p', '720p', '1080p'] as const;
type Quality = typeof QUALITY_ORDER[number];

// Quality parameter mapping for different embed providers
function applyQualityToUrl(url: string, quality: Quality): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // VidSrc.me / VidSrc.xyz / VidSrc.cc - supports quality parameter
    if (hostname.includes('vidsrc')) {
      urlObj.searchParams.set('quality', quality);
      return urlObj.toString();
    }
    
    // Embed.su - supports quality parameter
    if (hostname.includes('embed.su')) {
      urlObj.searchParams.set('quality', quality);
      return urlObj.toString();
    }
    
    // 2embed - uses different parameter
    if (hostname.includes('2embed')) {
      urlObj.searchParams.set('q', quality);
      return urlObj.toString();
    }
    
    // Multiembed - uses qual parameter
    if (hostname.includes('multiembed')) {
      urlObj.searchParams.set('qual', quality);
      return urlObj.toString();
    }
    
    // Default: return original URL (provider handles quality internally)
    return url;
  } catch {
    return url;
  }
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  streamUrl,
  title,
  poster,
  onClose,
  movie,
  mirrors = [],
  season,
  episode,
  mediaType,
  onPlayEpisode,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [progress, setProgress] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [qualityMenuOpen, setQualityMenuOpen] = useState<boolean>(false);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState<boolean>(false);
  const [mirrorMenuOpen, setMirrorMenuOpen] = useState<boolean>(false);
  const [currentQuality, setCurrentQuality] = useState<Quality>('480p');
  const [currentSubtitles, setCurrentSubtitles] = useState<string>('Off');
  const [currentMirror, setCurrentMirror] = useState<number>(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qualityChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if we're using an iframe embed (most providers) vs direct video
  const isEmbed = useMemo(() => {
    const url = allMirrors[currentMirror]?.url || streamUrl;
    return url.includes('embed') || url.includes('vidsrc') || url.includes('goojara');
  }, [streamUrl, mirrors, currentMirror]);

  const allMirrors = useMemo(() => {
    const baseMirrors: StreamMirror[] = [{ name: 'Server Alpha (VidSrc Me)', url: streamUrl }];
    if (mirrors.length) return [...baseMirrors, ...mirrors];
    return baseMirrors;
  }, [streamUrl, mirrors]);

  const currentMirrorUrl = useMemo(() => {
    const url = allMirrors[currentMirror]?.url || streamUrl;
    // Apply default 480p quality to embed URLs
    if (isEmbed) {
      return applyQualityToUrl(url, currentQuality);
    }
    return url;
  }, [allMirrors, currentMirror, streamUrl, currentQuality, isEmbed]);

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  }, [isPlaying]);

  // For direct video playback
  useEffect(() => {
    if (isEmbed) return; // Skip for iframe embeds
    
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!isNaN(video.duration)) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setIsLoading(false);
      video.play().catch(() => setIsPlaying(false));
    };

    const handleError = () => {
      const error = video.error?.message || 'Playback failed';
      setPlaybackError(`Error: ${error}. Trying next server...`);
      setIsLoading(false);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('waiting', () => setIsLoading(true));
    video.addEventListener('playing', () => setIsLoading(false));
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('waiting', () => setIsLoading(true));
      video.removeEventListener('playing', () => setIsLoading(false));
      video.removeEventListener('error', handleError);
    };
  }, [currentMirrorUrl, currentMirror, isEmbed]);

  // For iframe embeds - listen for load events
  useEffect(() => {
    if (!isEmbed) return;
    
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      setIframeLoaded(true);
      setIsLoading(false);
    };

    const handleError = () => {
      setPlaybackError('Failed to load embed. Trying next server...');
      setIsLoading(false);
    };

    iframe.addEventListener('load', handleLoad);
    iframe.addEventListener('error', handleError);

    return () => {
      iframe.removeEventListener('load', handleLoad);
      iframe.removeEventListener('error', handleError);
    };
  }, [currentMirrorUrl, isEmbed]);

  const togglePlay = useCallback(() => {
    if (isEmbed) {
      // For embeds, we can't directly control playback
      // The embed handles its own play/pause
      setIsPlaying(!isPlaying);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying, isEmbed]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (isEmbed) return; // Can't seek iframe embeds directly
    const video = videoRef.current;
    if (!video || isNaN(duration)) return;
    const seekTime = (parseFloat(e.target.value) / 100) * duration;
    video.currentTime = seekTime;
    setProgress(parseFloat(e.target.value));
  }, [duration, isEmbed]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (isEmbed) return; // Can't control iframe volume directly
    const video = videoRef.current;
    if (!video) return;
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    setIsMuted(newVol === 0);
    video.volume = newVol;
  }, [isEmbed]);

  const toggleMute = useCallback(() => {
    if (isEmbed) {
      setIsMuted(!isMuted);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (isMuted) {
      video.volume = volume || 0.5;
      setIsMuted(false);
    } else {
      video.volume = 0;
      setIsMuted(true);
    }
  }, [isMuted, volume, isEmbed]);

  const toggleFullscreen = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!document.fullscreenElement) {
      player.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }, []);

  const switchMirror = useCallback((index: number) => {
    if (index === currentMirror) return;
    setCurrentMirror(index);
    setIsLoading(true);
    setPlaybackError(null);
    setQualityMenuOpen(false);
    setIframeLoaded(false);
  }, [currentMirror]);

  const switchQuality = useCallback((quality: Quality) => {
    if (quality === currentQuality) return;
    
    setCurrentQuality(quality);
    setIsLoading(true);
    setPlaybackError(null);
    setQualityMenuOpen(false);
    setIframeLoaded(false);

    // For embeds, the URL change will trigger reload
    if (isEmbed) {
      qualityChangeTimeoutRef.current = setTimeout(() => {
        setIsLoading(false);
      }, 1500);
    }
  }, [currentQuality, isEmbed]);

  const formatTime = useCallback((seconds: number) => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    
    if (isEmbed) {
      // Limited keyboard support for embeds
      switch (e.key) {
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
      }
      return;
    }
    
    const video = videoRef.current;
    if (!video) return;

    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(duration, video.currentTime + 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        setVolume(video.volume);
        setIsMuted(false);
        break;
      case 'ArrowDown':
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        setVolume(video.volume);
        if (video.volume === 0) setIsMuted(true);
        break;
      case 'm':
        toggleMute();
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'Escape':
        if (document.fullscreenElement) {
          document.exitFullscreen();
        }
        break;
    }
  }, [togglePlay, toggleMute, toggleFullscreen, duration, isEmbed]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Prevent context menu on video/iframe
  const preventContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div
      ref={playerRef}
      onMouseMove={handleMouseMove}
      onContextMenu={preventContextMenu}
      className="relative w-full h-full aspect-video rounded-xl overflow-hidden bg-black select-none font-sans"
    >
      {/* Background Poster / Loading State */}
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
            <img src={poster} alt={title} className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm" />
            <div className="relative z-20 flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
              {playbackError ? (
                <p className="text-white/80 font-medium text-sm tracking-wider text-center max-w-md">{playbackError}</p>
              ) : (
                <p className="text-white/80 font-medium text-sm tracking-wider">Loading stream at {currentQuality}...</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Video Element (for direct streams) */}
      {!isEmbed && (
        <video
          ref={videoRef}
          src={currentMirrorUrl}
          poster={poster}
          className="w-full h-full object-contain cursor-pointer"
          onClick={togglePlay}
          onContextMenu={preventContextMenu}
          playsInline
          preload="metadata"
        />
      )}

      {/* Iframe Embed (for VidSrc, etc.) */}
      {isEmbed && (
        <iframe
          ref={iframeRef}
          src={currentMirrorUrl}
          title={title}
          className="w-full h-full border-0"
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
          onLoad={() => setIframeLoaded(true)}
          style={{ pointerEvents: 'auto' }} // Critical: ensure iframe receives pointer events
        />
      )}

      {/* Top Header Overlay */}
      <div className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-white text-base font-semibold tracking-wide drop-shadow-md truncate">{title}</h1>
          {mediaType === 'tv' && season && episode && (
            <span className="px-2 py-0.5 text-xs font-medium bg-white/10 border border-white/10 rounded text-white/80">
              S{season} E{episode}
            </span>
          )}
          {isEmbed && (
            <span className="px-2 py-0.5 text-xs font-medium bg-blue-500/20 border border-blue-500/30 rounded text-blue-400 flex items-center gap-1">
              <Monitor className="h-3 w-3" />
              Embed
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-black/40 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom Controls */}
      <div className={`absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex flex-col gap-2.5 transition-opacity duration-300 z-30 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        
        {/* Timeline Scrubber - only for direct video */}
        {!isEmbed && (
          <div className="relative group flex items-center">
            <input
              type="range"
              min="0"
              max="100"
              value={progress || 0}
              onChange={handleSeek}
              className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-red-600 hover:h-2 transition-all"
              onMouseDown={() => { if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current); }}
              onMouseUp={() => handleMouseMove()}
            />
          </div>
        )}

        {/* Control Buttons Bar */}
        <div className="flex items-center justify-between text-white flex-wrap gap-3">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <button onClick={togglePlay} className="hover:text-red-500 transition-colors flex-shrink-0" aria-label={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
            </button>
            
            {!isEmbed && (
              <>
                <button onClick={() => { const v = videoRef.current; if (v) v.currentTime -= 10; }} className="hover:text-red-500 transition-colors flex-shrink-0" aria-label="Rewind 10s">
                  <RotateCcw className="w-5 h-5" />
                </button>
                <button onClick={() => { const v = videoRef.current; if (v) v.currentTime += 10; }} className="hover:text-red-500 transition-colors flex-shrink-0" aria-label="Forward 10s">
                  <RotateCw className="w-5 h-5" />
                </button>
              </>
            )}

            {/* Volume Control - only for direct video */}
            {!isEmbed && (
              <div className="flex items-center gap-2 group flex-shrink-0">
                <button onClick={toggleMute} className="hover:text-red-500 transition-colors flex-shrink-0" aria-label={isMuted ? "Unmute" : "Mute"}>
                  {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white hover:accent-red-500 transition-all"
                  onMouseDown={() => { if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current); }}
                />
              </div>
            )}

            {/* Timestamp - only for direct video */}
            {!isEmbed && (
              <span className="text-xs font-medium text-white/80 flex-shrink-0">
                {formatTime(videoRef.current?.currentTime || 0)} / {formatTime(duration)}
              </span>
            )}

            {isEmbed && (
              <span className="text-xs font-medium text-white/60 flex-shrink-0">
                Stream via embed provider
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 relative flex-shrink-0">
            {/* Subtitles Button - only for direct video */}
            {!isEmbed && (
              <div className="relative z-40">
                <button
                  onClick={() => { setSubtitleMenuOpen(!subtitleMenuOpen); setQualityMenuOpen(false); setMirrorMenuOpen(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                >
                  <Subtitles className="w-4 h-4" />
                  <span>{currentSubtitles}</span>
                </button>
                {subtitleMenuOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-36 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                    {['Off', 'English', 'Spanish', 'French'].map((sub) => (
                      <button
                        key={sub}
                        onClick={(e) => { e.stopPropagation(); setCurrentSubtitles(sub); setSubtitleMenuOpen(false); }}
                        className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentSubtitles === sub ? 'text-red-500 font-bold' : 'text-white'}`}
                      >
                        {sub}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Quality Selector */}
            <div className="relative z-40">
              <button
                onClick={() => { setQualityMenuOpen(!qualityMenuOpen); setSubtitleMenuOpen(false); setMirrorMenuOpen(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                disabled={isEmbed && !currentMirrorUrl.includes('quality=')}
              >
                <Settings className="w-4 h-4" />
                <span>{currentQuality}</span>
                {isEmbed && <span className="text-[10px] text-white/40">(embed)</span>}
              </button>
              {qualityMenuOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-28 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                  {QUALITY_ORDER.map((q) => (
                    <button
                      key={q}
                      onClick={(e) => { e.stopPropagation(); switchQuality(q); }}
                      disabled={isEmbed && !currentMirrorUrl.includes('quality=')}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentQuality === q ? 'text-red-500 font-bold' : 'text-white'} ${isEmbed && !currentMirrorUrl.includes('quality=') ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Mirror/Server Selector */}
            {allMirrors.length > 1 && (
              <div className="relative z-40">
                <button
                  onClick={() => { setMirrorMenuOpen(!mirrorMenuOpen); setSubtitleMenuOpen(false); setQualityMenuOpen(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                >
                  <Server className="w-4 h-4" />
                  <span>{allMirrors[currentMirror]?.name || `Server ${currentMirror + 1}`}</span>
                </button>
                {mirrorMenuOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-44 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                    {allMirrors.map((mirror, idx) => (
                      <button
                        key={idx}
                        onClick={(e) => { e.stopPropagation(); switchMirror(idx); }}
                        className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors flex items-center gap-2 ${currentMirror === idx ? 'text-red-500 font-bold' : 'text-white'}`}
                      >
                        {currentMirror === idx && <Loader2 className="w-3 h-3 animate-spin" />}
                        {mirror.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button onClick={toggleFullscreen} className="hover:text-red-500 transition-colors flex-shrink-0" aria-label="Fullscreen">
              <Maximize className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};