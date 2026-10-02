export type MediaKind = "movie" | "series";
export type StreamQuality = "1080p" | "720p" | "480p";
export type PlayerStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "recovering"
  | "error";

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  url: string;
}

export interface QualityOption {
  id: string;
  label: string;
  height: number;
  bandwidth: number;
  url: string;
}

export interface EpisodeSummary {
  season: number;
  episode: number;
  title: string;
  synopsis?: string;
  durationSeconds?: number;
  playlistUrl?: string;
  downloads?: Partial<Record<StreamQuality, string>>;
}

export interface StreamPayload {
  titleId: string;
  title: string;
  kind: MediaKind;
  masterUrl: string;
  fallbackMasterUrls: string[];
  subtitles: SubtitleTrack[];
  qualities: QualityOption[];
  episodes: EpisodeSummary[];
  downloadableQualities: StreamQuality[];
  selectedEpisode?: Pick<EpisodeSummary, "season" | "episode" | "title">;
}

export interface VodTitle {
  titleId: string;
  title: string;
  synopsis: string;
  kind: MediaKind;
  year: number | null;
  rating: string | null;
  genres: string[];
  cast?: string[];
  posterUrl: string;
  backdropUrl: string;
  masterPlaylist: string;
  fallbackPlaylists?: string[];
  distribution: "owned_or_licensed";
  rightsVerified: true;
  episodes?: EpisodeSummary[];
  downloads?: Partial<Record<StreamQuality, string>>;
}

export interface PlayerState {
  status: PlayerStatus;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  selectedQuality: string;
  selectedSubtitle: string;
  fullscreen: boolean;
}
