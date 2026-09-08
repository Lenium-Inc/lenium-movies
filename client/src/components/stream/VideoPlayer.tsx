// player/VideoPlayer.tsx
import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize, Settings, Subtitles, X } from 'lucide-react';

interface VideoPlayerProps {
  streamUrl: string;
  title: string;
  poster: string;
  onClose: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ streamUrl, title, poster, onClose }) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [progress, setProgress] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [qualityMenuOpen, setQualityMenuOpen] = useState<boolean>(false);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState<boolean>(false);
  const [currentQuality, setCurrentQuality] = useState<string>('1080p');
  const [currentSubtitles, setCurrentSubtitles] = useState<string>('Off');

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-hide controls after 3 seconds of inactivity
  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setProgress((video.currentTime / video.duration) * 100);
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setIsLoading(false);
      video.play().catch(() => setIsPlaying(false));
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('waiting', () => setIsLoading(true));
    video.addEventListener('playing', () => setIsLoading(false));

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [streamUrl]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const seekTime = (parseFloat(e.target.value) / 100) * duration;
    if (videoRef.current) {
      videoRef.current.currentTime = seekTime;
    }
    setProgress(parseFloat(e.target.value));
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    setIsMuted(newVol === 0);
    if (videoRef.current) {
      videoRef.current.volume = newVol;
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    if (isMuted) {
      videoRef.current.volume = volume || 0.5;
      setIsMuted(false);
    } else {
      videoRef.current.volume = 0;
      setIsMuted(true);
    }
  };

  const toggleFullscreen = () => {
    if (!playerRef.current) return;
    if (!document.fullscreenElement) {
      playerRef.current.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div 
      ref={playerRef}
      onMouseMove={handleMouseMove}
      className="fixed inset-0 z-50 bg-black flex items-center justify-center overflow-hidden select-none font-sans"
    >
      {/* Background Poster / Loading State */}
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
            <img src={poster} alt={title} className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm" />
            <div className="relative z-20 flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
              <p className="text-white/80 font-medium text-sm tracking-wider">Loading high-definition source...</p>
            </div>
          </div>
        </div>
      )}

      {/* Video Element */}
      <video
        ref={videoRef}
        src={streamUrl}
        poster={poster}
        className="w-full h-full object-contain cursor-pointer"
        onClick={togglePlay}
        playsInline
      />

      {/* Top Header Overlay */}
      <div className={`absolute top-0 inset-x-0 p-6 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-4">
          <h1 className="text-white text-lg font-semibold tracking-wide drop-shadow-md">{title}</h1>
        </div>
        <button 
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-black/40 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Bottom Netflix-Style Clean Controls */}
      <div className={`absolute bottom-0 inset-x-0 p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex flex-col gap-3 transition-opacity duration-300 z-30 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        
        {/* Timeline Scrubber */}
        <div className="relative group flex items-center">
          <input
            type="range"
            min="0"
            max="100"
            value={progress || 0}
            onChange={handleSeek}
            className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-red-600 hover:h-2 transition-all"
          />
        </div>

        {/* Control Buttons Bar */}
        <div className="flex items-center justify-between text-white">
          <div className="flex items-center gap-6">
            <button onClick={togglePlay} className="hover:text-red-500 transition-colors">
              {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
            </button>
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime -= 10; }} className="hover:text-red-500 transition-colors">
              <RotateCcw className="w-5 h-5" />
            </button>
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime += 10; }} className="hover:text-red-500 transition-colors">
              <RotateCw className="w-5 h-5" />
            </button>

            {/* Volume Control */}
            <div className="flex items-center gap-2 group">
              <button onClick={toggleMute} className="hover:text-red-500 transition-colors">
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
              />
            </div>

            {/* Timestamp */}
            <span className="text-xs font-medium text-white/80">
              {formatTime(videoRef.current?.currentTime || 0)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-5 relative">
            {/* Subtitles Button */}
            <div className="relative">
              <button 
                onClick={() => { setSubtitleMenuOpen(!subtitleMenuOpen); setQualityMenuOpen(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
              >
                <Subtitles className="w-4 h-4" />
                <span>{currentSubtitles}</span>
              </button>
              {subtitleMenuOpen && (
                <div className="absolute bottom-full right-0 mb-3 w-36 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-40">
                  {['Off', 'English', 'Spanish', 'French'].map((sub) => (
                    <button
                      key={sub}
                      onClick={() => { setCurrentSubtitles(sub); setSubtitleMenuOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentSubtitles === sub ? 'text-red-500 font-bold' : 'text-white'}`}
                    >
                      {sub}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quality Selector */}
            <div className="relative">
              <button 
                onClick={() => { setQualityMenuOpen(!qualityMenuOpen); setSubtitleMenuOpen(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
              >
                <Settings className="w-4 h-4" />
                <span>{currentQuality}</span>
              </button>
              {qualityMenuOpen && (
                <div className="absolute bottom-full right-0 mb-3 w-32 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-40">
                  {['1080p', '720p', '480p', 'Auto'].map((q) => (
                    <button
                      key={q}
                      onClick={() => { setCurrentQuality(q); setQualityMenuOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentQuality === q ? 'text-red-500 font-bold' : 'text-white'}`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button onClick={toggleFullscreen} className="hover:text-red-500 transition-colors">
              <Maximize className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};