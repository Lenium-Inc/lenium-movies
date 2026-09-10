import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import { Bookmark, Check, ChevronDown, ChevronUp, Play, Star, X, MessageSquare, Clock, Tv, Film, Loader2, AlertCircle, RefreshCw, WifiOff, Server, Monitor, Zap, Wifi, Settings, ChevronDown as ChevronDownIcon, ArrowLeft, Share2, Heart, Download, Volume2, Plus, User, MapPin, Globe, Calendar } from "lucide-react";
import { getRating, setRating, subscribeRatings } from "@/services/ratings";
import {
  fetchTrailer,
  getStreamSource,
  resolveStream,
  StreamNotFoundError,
  type ResolvedStream,
  type StreamMovie,
  type TrailerInfo,
} from "@/services/api";
import { VideoPlayer, type PlaybackError, type EmbedProvider, type StreamMirror, type QualityOption, QUALITY_ORDER } from "@/components/stream/VideoPlayer";
import { EpisodeMatrix } from "@/components/movies/EpisodeMatrix";
import {
  cancelInFlightPrefetch,
  prefetchForOpen,
} from "@/services/prefetch";
import { attemptPlay } from "@/services/capGate";
import {
  getProgress,
  progressForTitle,
  subscribeStats,
} from "@/services/stats";
import type { Movie } from "@/components/movies/types";
import { TrailerEmbed } from "@/components/movies/MediaCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

function getImageUrl(path: string, size: string): string {
  if (path?.startsWith("http")) return path;
  return path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : "";
}

const RATE_AFTER_SECONDS = 15 * 60;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const EMBED_LOAD_TIMEOUT_MS = 8000;

interface ProviderConfig {
  name: string;
  supportsQuality: boolean;
  qualityParam: string;
  supportsMirrors: boolean;
  defaultQuality: string;
  buildUrl: (tmdbId: string, mediaType: "movie" | "tv", season?: number, episode?: number) => string;
}

const PROVIDER_CONFIGS: Record<EmbedProvider, ProviderConfig> = {
  "vidsrc": { 
    name: "VidSrc", 
    supportsQuality: true, 
    qualityParam: "quality", 
    supportsMirrors: true, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://vidsrc.cc/v2/embed/movie/${tmdbId}`
        : `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "embed.su": { 
    name: "Embed.su", 
    supportsQuality: true, 
    qualityParam: "quality", 
    supportsMirrors: true, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://embed.su/embed/movie/${tmdbId}`
        : `https://embed.su/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "autoembed": { 
    name: "AutoEmbed", 
    supportsQuality: true, 
    qualityParam: "quality", 
    supportsMirrors: true, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://autoembed.cc/embed/movie/${tmdbId}`
        : `https://autoembed.cc/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "2embed": { 
    name: "2Embed", 
    supportsQuality: true, 
    qualityParam: "q", 
    supportsMirrors: false, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://2embed.cc/embed/movie/${tmdbId}`
        : `https://2embed.cc/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "multiembed": { 
    name: "MultiEmbed", 
    supportsQuality: true, 
    qualityParam: "qual", 
    supportsMirrors: false, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1`
        : `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1&s=${season || 1}&e=${episode || 1}`
  },
  "goojara": { 
    name: "Goojara", 
    supportsQuality: false, 
    qualityParam: "", 
    supportsMirrors: false, 
    defaultQuality: "auto",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://goojara.to/embed/movie/${tmdbId}`
        : `https://goojara.to/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "vidlink": { 
    name: "VidLink", 
    supportsQuality: true, 
    qualityParam: "quality", 
    supportsMirrors: true, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://vidlink.org/embed/movie/${tmdbId}`
        : `https://vidlink.org/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "vidstream": { 
    name: "VidStream", 
    supportsQuality: true, 
    qualityParam: "quality", 
    supportsMirrors: true, 
    defaultQuality: "480p",
    buildUrl: (tmdbId, mediaType, season, episode) => 
      mediaType === "movie" 
        ? `https://vidstream.pro/embed/movie/${tmdbId}`
        : `https://vidstream.pro/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
  },
  "unknown": { 
    name: "Unknown", 
    supportsQuality: false, 
    qualityParam: "", 
    supportsMirrors: false, 
    defaultQuality: "auto",
    buildUrl: () => ""
  },
};

const FALLBACK_PROVIDER_ORDER: EmbedProvider[] = ["vidsrc", "embed.su", "autoembed", "vidlink", "vidstream", "2embed", "multiembed"];

function detectEmbedProvider(url: string): EmbedProvider {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("vidsrc")) return "vidsrc";
    if (hostname.includes("embed.su")) return "embed.su";
    if (hostname.includes("autoembed")) return "autoembed";
    if (hostname.includes("2embed")) return "2embed";
    if (hostname.includes("multiembed")) return "multiembed";
    if (hostname.includes("goojara")) return "goojara";
    if (hostname.includes("vidlink")) return "vidlink";
    if (hostname.includes("vidstream")) return "vidstream";
  } catch {
    // Invalid URL
  }
  return "unknown";
}

function applyQualityToUrl(url: string, quality: string, provider: EmbedProvider): string {
  if (provider === "unknown" || !PROVIDER_CONFIGS[provider]?.supportsQuality) return url;
  try {
    const urlObj = new URL(url);
    const config = PROVIDER_CONFIGS[provider];
    urlObj.searchParams.set(config.qualityParam, quality);
    return urlObj.toString();
  } catch {
    return url;
  }
}

function buildFallbackUrls(tmdbId: string, mediaType: "movie" | "tv", season?: number, episode?: number): { provider: EmbedProvider; url: string }[] {
  return FALLBACK_PROVIDER_ORDER.map(provider => ({
    provider,
    url: PROVIDER_CONFIGS[provider].buildUrl(tmdbId, mediaType, season, episode)
  })).filter(item => item.url);
}

function classifyError(error: unknown, provider?: EmbedProvider): PlaybackError {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  
  if (error instanceof StreamNotFoundError) {
    return { type: "not_found", message: `"${error.message.replace('No playable stream found for "', '').replace('"', '')}" isn't available to stream yet.`, recoverable: false, provider, retryCount: 0 };
  }
  
  if (lowerMessage.includes("404") || lowerMessage.includes("not found")) {
    return { type: "not_found", message: "This title isn't available to stream.", recoverable: false, provider, retryCount: 0 };
  }
  
  if (lowerMessage.includes("403") || lowerMessage.includes("forbidden") || lowerMessage.includes("geo") || lowerMessage.includes("region")) {
    return { type: "geo_blocked", message: "This content is not available in your region.", recoverable: false, provider, retryCount: 0 };
  }
  
  if (lowerMessage.includes("429") || lowerMessage.includes("rate limit") || lowerMessage.includes("too many requests")) {
    return { type: "rate_limited", message: "Too many requests. Please wait a moment and try again.", recoverable: true, provider, retryCount: 0 };
  }
  
  if (lowerMessage.includes("network") || lowerMessage.includes("fetch") || lowerMessage.includes("connection") || lowerMessage.includes("timeout")) {
    return { type: "network", message: "Network error. Please check your connection and try again.", recoverable: true, provider, retryCount: 0 };
  }
  
  if (lowerMessage.includes("embed") || lowerMessage.includes("provider") || lowerMessage.includes("source")) {
    return { type: "provider_unavailable", message: "The streaming provider is currently unavailable. Trying alternative sources...", recoverable: true, provider, retryCount: 0 };
  }
  
  return { type: "unknown", message: "We couldn't load this stream. Please try again.", recoverable: true, provider, retryCount: 0 };
}

// Fetch full movie details from TMDB via backend resolve endpoint
async function fetchMovieDetails(tmdbId: string): Promise<Movie | null> {
  try {
    // Use resolve endpoint with the TMDB ID as title to get full metadata
    const response = await fetch(`/api/movies/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tmdbId }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.movie) return null;
    
    const m = data.movie;
    const mediaType = m.media_type === "tv" ? "tv" : "movie";
    const year = m.year ? parseInt(m.year) : null;
    
    return {
      id: parseInt(m.id),
      providerId: m.id,
      title: m.title,
      year,
      runtime: "",
      rating: "Rating unavailable",
      score: m.vote_average ?? null,
      genre: m.genres?.length ? m.genres : [mediaType === "tv" ? "Series" : "Movie"],
      poster: m.poster_url,
      backdrop: m.backdrop_url || m.poster_url,
      synopsis: m.overview || "Loading...",
      director: null,
      source: "tmdb",
      mediaType,
    };
  } catch {
    return null;
  }
}

export function WatchPage() {
  const [location, navigate] = useLocation();
  const params = useParams();
  
  // Extract media info from URL: /watch/:id?season=1&episode=1&type=tv
  const tmdbId = params.id;
  const searchParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const urlSeason = parseInt(searchParams.get("season") || "1", 10);
  const urlEpisode = parseInt(searchParams.get("episode") || "1", 10);
  const urlType = searchParams.get("type") || "movie";
  
  const [movie, setMovie] = useState<Movie | null>(null);
  const [movieLoading, setMovieLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [resolving, setResolving] = useState(false);
  const [playError, setPlayError] = useState<PlaybackError | null>(null);
  const [season, setSeason] = useState(urlSeason);
  const [episode, setEpisode] = useState(urlEpisode);
  const [myRating, setMyRating] = useState<number>(0);
  const [watchedSeconds, setWatchedSeconds] = useState(0);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [showSeasonSelector, setShowSeasonSelector] = useState(false);
  const [showEpisodeDetails, setShowEpisodeDetails] = useState(false);
  const [episodeDetails, setEpisodeDetails] = useState<any>(null);
  const [currentEpisodeTitle, setCurrentEpisodeTitle] = useState("");
  
  // Multi-provider embed state
  const [currentProvider, setCurrentProvider] = useState<EmbedProvider>("vidsrc");
  const [availableMirrors, setAvailableMirrors] = useState<StreamMirror[]>([]);
  const [currentMirrorIndex, setCurrentMirrorIndex] = useState(0);
  const [selectedQuality, setSelectedQuality] = useState<QualityOption>("480p");
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  
  // Fallback provider system
  const [fallbackProviders, setFallbackProviders] = useState<{ provider: EmbedProvider; url: string }[]>([]);
  const [currentFallbackIndex, setCurrentFallbackIndex] = useState(0);
  const [embedLoadFailed, setEmbedLoadFailed] = useState(false);
  const [showProviderSelector, setShowProviderSelector] = useState(false);
  
  // Refs for retry logic
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const embedLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeLoadRef = useRef<boolean>(false);

  // Fetch movie details on mount
  useEffect(() => {
    if (!tmdbId) return;
    setMovieLoading(true);
    fetchMovieDetails(tmdbId).then(m => {
      if (m) {
        setMovie(m);
        // Initialize rating from localStorage
        setMyRating(getRating(m.id) ?? 0);
      }
      setMovieLoading(false);
    });
  }, [tmdbId]);

  // Subscribe to rating changes
  useEffect(() => {
    if (!movie) return;
    return subscribeRatings(() => {
      setMyRating(getRating(movie.id) ?? 0);
    });
  }, [movie?.id]);

  // Subscribe to watch progress
  useEffect(() => {
    if (!movie) return;
    const refresh = () =>
      setWatchedSeconds(
        Math.max(
          getProgress(String(movie.id)),
          resolved ? getProgress(resolved.stream.id) : 0,
          progressForTitle(movie.title)
        )
      );
    refresh();
    return subscribeStats(refresh);
  }, [movie?.id, movie?.title, resolved]);

  const canRate = watchedSeconds >= RATE_AFTER_SECONDS;

  // Fetch trailer
  useEffect(() => {
    if (!movie) return;
    let active = true;
    setTrailer(null);
    void fetchTrailer(movie.title, movie.year)
      .then(info => {
        if (active) setTrailer(info);
      })
      .catch(() => {
        if (active) setTrailer(null);
      });
    return () => {
      active = false;
    };
  }, [movie?.title, movie?.year]);

  // Fetch episode details when season/episode changes
  const fetchEpisodeInfo = useCallback(async (s: number, e: number) => {
    if (!resolved?.stream.id || !/^\d+$/.test(resolved.stream.id)) return;
    try {
      const details = await fetch(`/api/episodes?tmdb_id=${resolved.stream.id}&season=${s}&episode=${e}`);
      if (details.ok) {
        const data = await details.json();
        if (data.success) {
          setEpisodeDetails(data.episode);
          setCurrentEpisodeTitle(data.episode.title || `S${s} E${e}`);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch episode details:", err);
    }
  }, [resolved]);

  useEffect(() => {
    if (movie?.mediaType === "tv" && resolved?.stream.id) {
      fetchEpisodeInfo(season, episode);
    } else {
      setEpisodeDetails(null);
      setCurrentEpisodeTitle(movie?.title || "");
    }
  }, [season, episode, movie?.mediaType, resolved, fetchEpisodeInfo]);

  // Helper to resolve stream with retry logic
  const resolveWithRetry = useCallback(
    async (
      title: string,
      year?: number | null,
      options?: { season?: number; episode?: number },
      attempt = 1
    ): Promise<ResolvedStream> => {
      try {
        const stream = await resolveStream(title, year, options);
        return stream;
      } catch (error) {
        const playbackError = classifyError(error, currentProvider);
        
        // Don't retry non-recoverable errors
        if (!playbackError.recoverable || attempt >= MAX_RETRY_ATTEMPTS) {
          throw error;
        }
        
        // Wait before retry with exponential backoff
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Retry
        return resolveWithRetry(title, year, options, attempt + 1);
      }
    },
    [currentProvider]
  );

  const resolveAndPlay = useCallback(
    async (targetSeason: number, targetEpisode: number) => {
      if (resolving || !movie) return;
      if (!attemptPlay()) return;
      setResolving(true);
      setPlayError(null);
      setRetryCount(0);
      setIsRetrying(false);
      
      // Cancel any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }

      try {
        let base = resolved?.stream ?? null;
        if (!base) {
          const stream = await resolveWithRetry(movie.title, movie.year);
          setResolved(stream);
          base = stream.stream;
        }
        setSeason(targetSeason);
        setEpisode(targetEpisode);

        let playable: StreamMovie = base;
        const mediaType: "movie" | "tv" | null =
          base.media_type === "movie" || base.media_type === "tv"
            ? base.media_type
            : null;
        
        // Initialize fallback providers if we have a valid TMDB ID
        if (mediaType && /^\d+$/.test(base.id)) {
          initializeFallbackProviders(base.id, mediaType, 
            mediaType === "tv" ? targetSeason : undefined,
            mediaType === "tv" ? targetEpisode : undefined
          );
          
          // Use the first fallback provider as the primary stream URL
          // This ensures we always have a working embed URL even if the resolved stream fails
          if (fallbackProviders.length > 0) {
            const primaryFallback = fallbackProviders[0];
            setCurrentProvider(primaryFallback.provider);
            playable = {
              ...base,
              stream_url: primaryFallback.url,
              mirrors: [
                { name: `${PROVIDER_CONFIGS[primaryFallback.provider]?.name || primaryFallback.provider} Server`, url: primaryFallback.url },
                ...(base.mirrors || [])
              ],
              season: targetSeason,
              episode: targetEpisode,
            };
            setAvailableMirrors(playable.mirrors || []);
            setCurrentMirrorIndex(0);
            
            const config = PROVIDER_CONFIGS[primaryFallback.provider];
            if (config?.supportsQuality) {
              setSelectedQuality(config.defaultQuality as QualityOption);
            }
          }
        } else {
          // Detect provider from stream URL for non-TMDB content
          const provider = detectEmbedProvider(base.stream_url);
          setCurrentProvider(provider);
          
          // Collect all mirrors
          const allMirrors: StreamMirror[] = [
            { name: `${PROVIDER_CONFIGS[provider]?.name || "Primary"} Server`, url: base.stream_url },
            ...(base.mirrors || []),
          ];
          setAvailableMirrors(allMirrors);
          setCurrentMirrorIndex(0);
          
          // Set default quality based on provider
          const config = PROVIDER_CONFIGS[provider];
          if (config?.supportsQuality) {
            setSelectedQuality(config.defaultQuality as QualityOption);
          }
        }

        // Try to get stream source from backend as enhancement
        if (mediaType && /^\d+$/.test(base.id)) {
          try {
            const source = await getStreamSource({
              tmdbId: base.id,
              mediaType,
              season: mediaType === "tv" ? targetSeason : undefined,
              episode: mediaType === "tv" ? targetEpisode : undefined,
            });
            
            // Update provider detection with the actual stream URL
            const actualProvider = detectEmbedProvider(source.url);
            setCurrentProvider(actualProvider);
            
            const updatedMirrors: StreamMirror[] = [
              { name: `${PROVIDER_CONFIGS[actualProvider]?.name || "Primary"} Server`, url: source.url },
              ...(source.mirrors || []),
            ];
            setAvailableMirrors(updatedMirrors);
            setCurrentMirrorIndex(0);
            
            const actualConfig = PROVIDER_CONFIGS[actualProvider];
            if (actualConfig?.supportsQuality) {
              setSelectedQuality(actualConfig.defaultQuality as QualityOption);
            }
            
            playable = {
              ...base,
              stream_url: source.url,
              mirrors: source.mirrors,
              season: targetSeason,
              episode: targetEpisode,
            };
            
            // Re-initialize fallbacks with the actual provider as first option
            if (fallbackProviders.length > 0) {
              const reorderedFallbacks = [
                { provider: actualProvider, url: source.url },
                ...fallbackProviders.filter(f => f.provider !== actualProvider)
              ];
              setFallbackProviders(reorderedFallbacks);
              setCurrentFallbackIndex(0);
            }
          } catch (error) {
            console.warn(
              `[WatchPage] get-stream failed for "${base.title}" (S${targetSeason}E${targetEpisode}), using fallback embed`,
              error
            );
            // Fallback providers are already initialized above
          }
        }

        // Start the 8-second embed load timeout
        iframeLoadRef.current = false;
        if (embedLoadTimeoutRef.current) {
          clearTimeout(embedLoadTimeoutRef.current);
        }
        embedLoadTimeoutRef.current = setTimeout(() => {
          if (!iframeLoadRef.current && !embedLoadFailed) {
            setEmbedLoadFailed(true);
            switchToNextFallback();
          }
        }, EMBED_LOAD_TIMEOUT_MS);

        setResolved({ stream: playable, exact: true });
        prefetchForOpen(playable);
        
        // Update URL without navigation
        const isSeries = playable.media_type === "tv";
        const newUrl = `/watch/${movie.providerId}${isSeries ? `?season=${targetSeason}&episode=${targetEpisode}&type=tv` : ""}`;
        navigate(newUrl, { replace: true });
      } catch (error) {
        const playbackError = classifyError(error, currentProvider);
        console.error(
          `[WatchPage] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
          error
        );
        setPlayError({ ...playbackError, retryCount });
        
        // Auto-retry for recoverable errors
        if (playbackError.recoverable && retryCount < MAX_RETRY_ATTEMPTS) {
          setIsRetrying(true);
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);
          retryTimeoutRef.current = setTimeout(() => {
            setRetryCount(prev => prev + 1);
            resolveAndPlay(targetSeason, targetEpisode);
          }, delay);
        }
      } finally {
        setResolving(false);
      }
    },
    [movie, resolved, resolving, navigate, resolveWithRetry, currentProvider, retryCount]
  );

  const play = useCallback(async () => {
    if (resolving || !movie) return;
    if (!attemptPlay()) return;
    if (resolved) {
      const isSeries = resolved.stream.media_type === "tv";
      await resolveAndPlay(isSeries ? season : 1, isSeries ? episode : 1);
      return;
    }
    await resolveAndPlay(1, 1);
  }, [resolving, resolved, season, episode, resolveAndPlay, movie]);

  const playEpisode = useCallback(
    (targetSeason: number, targetEpisode: number) => {
      void resolveAndPlay(targetSeason, targetEpisode);
    },
    [resolveAndPlay]
  );

  // Retry handler for playback errors
  const handleRetry = useCallback(() => {
    if (playError?.recoverable) {
      setRetryCount(0);
      setPlayError(null);
      if (resolved?.stream.media_type === "tv") {
        resolveAndPlay(season, episode);
      } else {
        resolveAndPlay(1, 1);
      }
    }
  }, [playError, resolved, season, episode, resolveAndPlay]);

  // Switch to next fallback provider
  const switchToNextFallback = useCallback(() => {
    if (currentFallbackIndex >= fallbackProviders.length - 1) return;
    const nextIndex = currentFallbackIndex + 1;
    const nextProvider = fallbackProviders[nextIndex];
    setCurrentFallbackIndex(nextIndex);
    setCurrentProvider(nextProvider.provider);
    setEmbedLoadFailed(false);
    iframeLoadRef.current = false;
    
    // Update the resolved stream with the new fallback URL
    if (resolved) {
      setResolved({
        ...resolved,
        stream: {
          ...resolved.stream,
          stream_url: nextProvider.url,
          mirrors: [
            { name: `${PROVIDER_CONFIGS[nextProvider.provider]?.name || nextProvider.provider} Server`, url: nextProvider.url },
            ...(resolved.stream.mirrors || [])
          ]
        }
      });
    }
    
    // Reset the 8-second timeout for the new provider
    if (embedLoadTimeoutRef.current) {
      clearTimeout(embedLoadTimeoutRef.current);
    }
    embedLoadTimeoutRef.current = setTimeout(() => {
      if (!iframeLoadRef.current && !embedLoadFailed) {
        setEmbedLoadFailed(true);
        switchToNextFallback();
      }
    }, EMBED_LOAD_TIMEOUT_MS);
  }, [currentFallbackIndex, fallbackProviders, resolved, embedLoadFailed]);

  // Handle iframe load success
  const handleIframeLoad = useCallback(() => {
    iframeLoadRef.current = true;
    setEmbedLoadFailed(false);
    if (embedLoadTimeoutRef.current) {
      clearTimeout(embedLoadTimeoutRef.current);
    }
  }, []);

  // Initialize fallback providers for a given TMDB ID and media type
  const initializeFallbackProviders = useCallback((tmdbId: string, mediaType: "movie" | "tv", season?: number, episode?: number) => {
    const fallbacks = buildFallbackUrls(tmdbId, mediaType, season, episode);
    setFallbackProviders(fallbacks);
    setCurrentFallbackIndex(0);
    if (fallbacks.length > 0) {
      setCurrentProvider(fallbacks[0].provider);
    }
  }, []);

  // Switch mirror/server
  const switchMirror = useCallback((index: number) => {
    if (index === currentMirrorIndex || index >= availableMirrors.length) return;
    setCurrentMirrorIndex(index);
    setPlayError(null);
  }, [currentMirrorIndex, availableMirrors.length]);

  // Change quality
  const changeQuality = useCallback((quality: QualityOption) => {
    if (quality === selectedQuality) return;
    setSelectedQuality(quality);
    setPlayError(null);
  }, [selectedQuality]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (embedLoadTimeoutRef.current) {
        clearTimeout(embedLoadTimeoutRef.current);
      }
    };
  }, []);

  // Initial warm resolve
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !movie) return;
    opened.current = true;
    let disposed = false;

    const loadTimer = setTimeout(() => {
      if (!disposed) setDetailsLoaded(true);
    }, 100);

    void (async () => {
      try {
        const stream = await resolveStream(movie.title, movie.year, 
          movie.mediaType === "tv" ? { season, episode } : undefined
        );
        if (disposed) return;
        setResolved(stream);
        prefetchForOpen(stream.stream);
      } catch (error) {
        console.warn(
          `[WatchPage] warm resolve skipped for "${movie.title}"`,
          error
        );
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(loadTimer);
    };
  }, [movie?.id, movie?.title, movie?.year, movie?.mediaType, season, episode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate("/");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate]);

  const handleClose = () => {
    cancelInFlightPrefetch();
    navigate("/");
  };

  // Determine what to show as episode title
  const displayTitle = movie?.mediaType === "tv" && episodeDetails?.title 
    ? `${movie.title} — ${episodeDetails.title}` 
    : movie?.mediaType === "tv" 
      ? `${movie.title} — S${season} E${episode}`
      : movie?.title || "Loading...";

// Show loading state with skeleton
  if (movieLoading) {
    return (
      <div className="min-h-screen bg-[#050505] text-white">
        {/* Top Bar Skeleton */}
        <div className="fixed top-0 left-0 right-0 z-40 h-16 bg-black/90 backdrop-blur-md border-b border-white/10 flex items-center justify-between px-4 sm:px-6">
          <div className="w-10 h-10 rounded-full bg-white/5 animate-pulse" />
          <div className="flex-1 flex items-center justify-center">
            <div className="h-5 w-48 bg-white/10 rounded animate-pulse" />
          </div>
          <div className="w-10" />
        </div>

        <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            {/* Video Player Skeleton - Theater Mode */}
            <div className="relative w-full h-[70vh] sm:h-[75vh] max-h-[800px] rounded-2xl overflow-hidden bg-black animate-pulse">
              <div className="absolute inset-0 bg-gradient-to-r from-white/5 via-white/10 to-white/5 bg-[length:200%_100%] animate-shimmer" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative z-20 flex flex-col items-center gap-4">
                  <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
                  <p className="text-white/80 font-medium text-sm tracking-wider">Loading movie details...</p>
                </div>
              </div>
            </div>

            {/* Title Skeleton */}
            <div className="mt-6 text-center animate-pulse">
              <div className="h-8 w-64 bg-white/10 rounded mx-auto" />
            </div>

            {/* Stream Provider Skeleton */}
            <div className="mt-4 flex items-center justify-center gap-3 animate-pulse">
              <div className="w-48 md:w-64 h-10 bg-white/10 rounded" />
            </div>

            {/* About Section Skeleton */}
            <div className="mt-8 space-y-4 text-center max-w-3xl mx-auto animate-pulse">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <div className="h-4 w-20 bg-white/10 rounded" />
                <div className="h-4 w-4 bg-white/10 rounded" />
                <div className="h-4 w-32 bg-white/10 rounded" />
              </div>
              <div className="h-4 w-full bg-white/10 rounded" />
              <div className="h-4 w-3/4 bg-white/10 rounded" />
              <div className="h-4 w-1/2 bg-white/10 rounded" />
            </div>

            {/* Action Buttons Skeleton */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 animate-pulse">
              <div className="flex-1 sm:flex-none h-12 bg-white/10 rounded-md" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!movie) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/60">Movie not found</p>
          <button onClick={() => navigate("/")} className="mt-4 text-white underline">Go Home</button>
        </div>
      </div>
    );
  }

  // Handle back navigation to details page
  const handleBackToDetails = () => {
    navigate(`/details/${movie.providerId}`);
  };

  // Handle share link
  const handleShare = async () => {
    const shareUrl = `${window.location.origin}/watch/${movie.providerId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      prompt("Copy link:", shareUrl);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1400px]">
          {/* Split Layout: Player (2/3) | Sidebar (1/3) */}
          <div className="grid lg:grid-cols-[2fr_1fr] gap-6">
            {/* LEFT PANEL: Video Player - Theater Mode */}
            <div className="relative">
              <div className="relative w-full aspect-video sm:aspect-[16/9] rounded-2xl overflow-hidden bg-black shadow-2xl">
                {resolved && (
                  <>
                    {/* Top-left overlay: Back button */}
                    <div className="absolute top-4 left-4 z-20">
                      <button
                        onClick={handleBackToDetails}
                        aria-label="Back to details"
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-black/60 hover:bg-white/10 border border-white/10 backdrop-blur-md text-white transition-colors"
                      >
                        <ArrowLeft className="h-5 w-5" />
                      </button>
                    </div>

                    {/* Top-right overlay: Share button */}
                    <div className="absolute top-4 right-4 z-20">
                      <button
                        onClick={handleShare}
                        aria-label="Share link"
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-black/60 hover:bg-white/10 border border-white/10 backdrop-blur-md text-white transition-colors"
                      >
                        <Share2 className="h-5 w-5" />
                      </button>
                    </div>

                    <VideoPlayer
                      title={displayTitle}
                      movie={resolved.stream}
                      onClose={handleClose}
                      streamUrl={resolved.stream.stream_url}
                      poster={movie.backdrop ? getImageUrl(movie.backdrop, "original") : movie.poster ? getImageUrl(movie.poster, "w780") : ""}
                      mirrors={resolved.stream.mirrors}
                      season={resolved.stream.season}
                      episode={resolved.stream.episode}
                      mediaType={resolved.stream.media_type}
                      onPlayEpisode={playEpisode}
                      // Multi-provider support
                      currentProvider={currentProvider}
                      availableMirrors={availableMirrors}
                      currentMirrorIndex={currentMirrorIndex}
                      onMirrorChange={switchMirror}
                      selectedQuality={selectedQuality}
                      onQualityChange={changeQuality}
                      availableQualities={PROVIDER_CONFIGS[currentProvider]?.supportsQuality ? QUALITY_ORDER : undefined}
                      isLoading={resolving}
                      playbackError={playError}
                      onRetry={handleRetry}
                      onIframeLoad={handleIframeLoad}
                    />
                  </>
                )}
                {!resolved && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                      <img
                        src={movie.backdrop ? getImageUrl(movie.backdrop, "original") : movie.poster ? getImageUrl(movie.poster, "w780") : ""}
                        alt={movie.title}
                        className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm"
                      />
                      <div className="relative z-20 flex flex-col items-center gap-4">
                        <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
                        <p className="text-white/80 font-medium text-sm tracking-wider">Preparing stream...</p>
                        {resolving && (
                          <p className="text-xs text-white/50 flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Resolving playback sources...
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT PANEL: Episode List / Details Sidebar */}
            <aside className="lg:sticky lg:top-24 space-y-6 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">
              {/* Show/Movie Title & Metadata */}
              <div className="space-y-4">
                <h1 className="text-xl sm:text-2xl font-bold text-white truncate">{movie.title}</h1>
                
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#aaa9ae]">
                  {movie.year && <span className="px-2 py-1 bg-white/5 border border-white/10 rounded">{movie.year}</span>}
                  {movie.runtime && (
                    <>
                      <span>·</span>
                      <span className="px-2 py-1 bg-white/5 border border-white/10 rounded">{movie.runtime}</span>
                    </>
                  )}
                  <span>·</span>
                  <span className="px-2 py-1 bg-white/5 border border-white/10 rounded">{movie.genre.slice(0, 3).join(" · ")}</span>
                  {movie.score !== null && (
                    <span className="flex items-center gap-1 px-2 py-1 bg-amber-500/20 border border-amber-500/30 rounded text-amber-400">
                      <Star className="h-3.5 w-3.5 fill-current" />
                      {movie.score}
                    </span>
                  )}
                  {movie.mediaType === "tv" && resolved && (
                    <span className="px-2 py-1 bg-blue-500/20 border border-blue-500/30 rounded text-blue-400 flex items-center gap-1">
                      <Tv className="h-3.5 w-3.5" />
                      {resolved.stream.seasons || "?"} Seasons
                    </span>
                  )}
                </div>

                {/* Synopsis */}
                <p className="text-sm leading-6 text-[#c5c5c1] line-clamp-4">{movie.synopsis}</p>

                {/* Action Buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 px-4 py-3"
                    onClick={() => { /* Add to library */ }}
                  >
                    <Plus className="h-5 w-5" />
                    <span className="hidden sm:inline">My Library</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 px-4 py-3"
                  >
                    <Download className="h-5 w-5" />
                    <span className="hidden sm:inline">Download</span>
                  </Button>
                </div>
              </div>

              {/* Divider */}
              <Separator className="border-white/10" />

              {/* TV Shows: Season Selector + Episode List */}
              {movie.mediaType === "tv" && resolved ? (
                <div className="space-y-4">
                  {/* Season Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">Season</h2>
                      <Select
                        value={season.toString()}
                        onValueChange={(value) => {
                          const newSeason = parseInt(value, 10);
                          if (newSeason !== season) {
                            setSeason(newSeason);
                            setEpisode(1);
                            playEpisode(newSeason, 1);
                          }
                        }}
                      >
                        <SelectTrigger className="w-[140px] bg-white/5 border border-white/10 text-white/80 text-xs">
                          <SelectValue placeholder="Select season" />
                        </SelectTrigger>
                        <SelectContent className="bg-zinc-900 border border-white/10 text-white">
                          {Array.from({ length: resolved.stream.seasons || 1 }, (_, i) => i + 1).map((s) => (
                            <SelectItem key={s} value={s.toString()}>
                              Season {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    {/* Episode List */}
                    <div className="space-y-1 max-h-[50vh] overflow-y-auto">
                      {resolved.stream.episodes
                        ?.filter((ep: any) => ep.season === season)
                        .map((ep: any) => (
                          <button
                            key={`${ep.season}-${ep.number}`}
                            onClick={() => playEpisode(ep.season, ep.number)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                              ep.season === season && ep.number === episode
                                ? "bg-white/10 text-white border border-white/20"
                                : "text-white/80 hover:bg-white/5 hover:text-white hover:border-white/10 border border-transparent"
                            }`}
                          >
                            <span className="flex-shrink-0 w-8 text-center text-xs font-mono font-semibold text-white/50">
                              E{String(ep.number).padStart(2, "0")}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{ep.title || `Episode ${ep.number}`}</p>
                              <p className="text-xs text-white/50 flex items-center gap-2">
                                {ep.runtime && `${ep.runtime}m`}
                                {ep.air_date && ep.air_date}
                                {ep.vote_average && (
                                  <span className="flex items-center gap-1 text-amber-400">
                                    <Star className="h-3 w-3 fill-current" />
                                    {ep.vote_average.toFixed(1)}
                                  </span>
                                )}
                              </p>
                            </div>
                            {ep.season === season && ep.number === episode && (
                              <span className="text-xs text-green-400 font-medium">Playing</span>
                            )}
                          </button>
                        ))}
                    </div>
                  </div>
                </div>
              ) : (
                // Movie: Show details in sidebar
                <div className="space-y-6">
                  {/* Details & Unavailable Info */}
                  <div className="space-y-4">
                    <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">Details</h2>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-white/50">Director</p>
                        <p className="text-white font-medium flex items-center gap-1">
                          {movie.director || (
                            <>
                              <span className="text-white/40">Unknown</span>
                              <User className="h-3 w-3 text-white/30" />
                            </>
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-white/50">Cast</p>
                        <p className="text-white font-medium line-clamp-1 flex items-center gap-1">
                          {movie.cast && movie.cast.length > 0 ? (
                            movie.cast.slice(0, 3).join(", ")
                          ) : (
                            <>
                              <span className="text-white/40">Unavailable</span>
                              <User className="h-3 w-3 text-white/30" />
                            </>
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-white/50">Country</p>
                        <p className="text-white font-medium flex items-center gap-1">
                          {movie.country || (
                            <>
                              <span className="text-white/40">Unknown</span>
                              <MapPin className="h-3 w-3 text-white/30" />
                            </>
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-white/50">Language</p>
                        <p className="text-white font-medium flex items-center gap-1">
                          {movie.language || (
                            <>
                              <span className="text-white/40">Unknown</span>
                              <Globe className="h-3 w-3 text-white/30" />
                            </>
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-white/50">Release Date</p>
                        <p className="text-white font-medium flex items-center gap-1">
                          {movie.releaseDate ? (
                            movie.releaseDate
                          ) : (
                            <>
                              <span className="text-white/40">Unknown</span>
                              <Calendar className="h-3 w-3 text-white/30" />
                            </>
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-white/50">Runtime</p>
                        <p className="text-white font-medium flex items-center gap-1">
                          {movie.runtime ? (
                            `${movie.runtime}m`
                          ) : (
                            <>
                              <span className="text-white/40">Unknown</span>
                              <Calendar className="h-3 w-3 text-white/30" />
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Stream Provider Selector */}
                  {resolved && fallbackProviders.length > 1 && (
                    <div className="space-y-2">
                      <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">Stream Source</h2>
                      <Select
                        value={fallbackProviders[currentFallbackIndex]?.provider || currentProvider}
                        onValueChange={(value: string) => {
                          const providerValue = value as EmbedProvider;
                          const index = fallbackProviders.findIndex(f => f.provider === providerValue);
                          if (index !== -1 && index !== currentFallbackIndex) {
                            setCurrentFallbackIndex(index);
                            setCurrentProvider(providerValue);
                            setEmbedLoadFailed(false);
                            iframeLoadRef.current = false;
                            if (resolved) {
                              const nextProvider = fallbackProviders[index];
                              setResolved({
                                ...resolved,
                                stream: {
                                  ...resolved.stream,
                                  stream_url: nextProvider.url,
                                  mirrors: [
                                    { name: `${PROVIDER_CONFIGS[nextProvider.provider]?.name || nextProvider.provider} Server`, url: nextProvider.url },
                                    ...(resolved.stream.mirrors || [])
                                  ]
                                }
                              });
                            }
                            if (embedLoadTimeoutRef.current) {
                              clearTimeout(embedLoadTimeoutRef.current);
                            }
                            embedLoadTimeoutRef.current = setTimeout(() => {
                              if (!iframeLoadRef.current && !embedLoadFailed) {
                                setEmbedLoadFailed(true);
                                switchToNextFallback();
                              }
                            }, EMBED_LOAD_TIMEOUT_MS);
                          }
                        }}
                      >
                        <SelectTrigger className="w-full bg-white/5 border border-white/10 text-white/80 text-xs">
                          <SelectValue placeholder="Select provider" />
                        </SelectTrigger>
                        <SelectContent className="bg-zinc-900 border border-white/10 text-white">
                          {fallbackProviders.map((fp, idx) => (
                            <SelectItem key={fp.provider} value={fp.provider} className="flex items-center justify-between">
                              <span className="capitalize">{PROVIDER_CONFIGS[fp.provider]?.name || fp.provider}</span>
                              {idx === currentFallbackIndex && (
                                <span className="text-green-400 text-xs font-medium">Active</span>
                              )}
                              {embedLoadFailed && idx === currentFallbackIndex && (
                                <span className="text-amber-400 text-xs font-medium">Loading failed</span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {embedLoadFailed && currentFallbackIndex < fallbackProviders.length - 1 && (
                        <p className="text-xs text-amber-400 flex items-center gap-1 animate-pulse">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Auto-switching to next provider...
                        </p>
                      )}
                    </div>
                  )}

                  {/* Rating */}
                  {canRate && detailsLoaded && (
                    <div className="space-y-2">
                      <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">Your Rating</h2>
                      <div className="flex items-center justify-center gap-1">
                        {[1, 2, 3, 4, 5].map(star => (
                          <button
                            key={star}
                            type="button"
                            aria-label={`Rate ${star} out of 5`}
                            disabled={!canRate}
                            onClick={() => {
                              setRating(movie, star === myRating ? 0 : star);
                              setMyRating(star === myRating ? 0 : star);
                            }}
                            className="p-1 text-white transition hover:scale-110"
                          >
                            <Star
                              className={`h-5 w-5 ${
                                star <= myRating ? "fill-[#d7d7d3] text-[#d7d7d3]" : "text-white/30"
                              }`}
                            />
                          </button>
                        ))}
                      </div>
                      {myRating > 0 && (
                        <p className="text-xs text-center text-white/50">{myRating}/5</p>
                      )}
                    </div>
                  )}

                  {/* Error Messages */}
                  {playError && detailsLoaded && (
                    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-3">
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 mt-0.5">
                          {playError.type === "not_found" && <AlertCircle className="w-5 h-5 text-amber-400" />}
                          {playError.type === "geo_blocked" && <WifiOff className="w-5 h-5 text-red-400" />}
                          {playError.type === "network" && <Wifi className="w-5 h-5 text-blue-400" />}
                          {playError.type === "rate_limited" && <Zap className="w-5 h-5 text-amber-400" />}
                          {playError.type === "provider_unavailable" && <Server className="w-5 h-5 text-orange-400" />}
                          {playError.type === "unknown" && <AlertCircle className="w-5 h-5 text-white/60" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm leading-5 text-[#c5c5c1]">{playError.message}</p>
                          {playError.provider && playError.provider !== "unknown" && (
                            <p className="mt-1 text-xs text-white/50">
                              Provider: {PROVIDER_CONFIGS[playError.provider]?.name || playError.provider}
                            </p>
                          )}
                          {playError.recoverable && (
                            <button
                              onClick={handleRetry}
                              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white/80 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded transition-colors"
                            >
                              <RefreshCw className="w-3 h-3" />
                              {isRetrying ? "Retrying..." : `Retry (attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
