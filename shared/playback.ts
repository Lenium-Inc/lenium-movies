export const PLAYBACK_UNAVAILABLE_MESSAGE =
  "Playback unavailable: no authorized video provider is configured.";

export function getPlaybackUnavailableState() {
  return {
    available: false as const,
    reason: "provider_not_configured" as const,
    message: PLAYBACK_UNAVAILABLE_MESSAGE,
  };
}
