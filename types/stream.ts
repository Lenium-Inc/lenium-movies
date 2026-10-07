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

/**
 * One audio rendition declared by the master playlist.
 *
 * `url` is always a proxied sub-playlist rather than a segment URI: an alternate
 * audio rendition is itself a media playlist, and handing HLS.js the raw
 * rendition URL would put an un-authorized origin back on the critical path.
 */
export interface AudioTrack {
  id: string;
  /** Human name from the manifest, e.g. "English" or "Korean 5.1". */
  label: string;
  /** BCP-47 language tag as declared, defaulting to "und". */
  language: string;
  /** The `NAME` the packager chose, which is what the viewer actually reads. */
  name: string;
  /** The `GROUP-ID` of the variant this rendition belongs to. */
  groupId: string;
  /** Proxied rendition playlist. */
  url: string;
  /** The rendition carries the audio the variant plays by default. */
  isDefault: boolean;
  /**
   * True for an English rendition on a title whose original language is not
   * English -- a dub, as opposed to the original English audio of an English
   * film. The distinction decides which track the player preselects, so it is
   * resolved server-side where the title's original language is known rather
   * than guessed in the browser from the track name.
   */
  isDub: boolean;
  /** Channel count when declared, e.g. 6 for 5.1. */
  channels?: number;
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
  audio: AudioTrack[];
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
  /**
   * BCP-47 tag for the language the title was made in.
   *
   * Optional because the catalog predates it. When absent, nothing is assumed:
   * in particular an English audio rendition is not labelled a dub, because
   * "is this a dub?" has no answer without knowing the original language.
   */
  originalLanguage?: string;
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
