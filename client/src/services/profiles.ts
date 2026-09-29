import { resolveAvatarUrl, type AvatarPreset } from "@/lib/avatars";

export interface ProfileData {
  id: string;
  name: string;
  /**
   * Resolved image URL, rendered directly as `<img src>`.
   *
   * Kept as the stored field rather than only an `avatarId` because it predates
   * the preset library, is a required `string`, and is consumed at five render
   * sites. Reading it through `resolveAvatarUrl` means a missing or malformed
   * value degrades to a generated avatar instead of a broken image.
   */
  avatar: string;
  /**
   * Preset the viewer chose, when they chose one.
   *
   * Null/absent means "generated from the name", which is how every profile
   * created before the picker existed should read. Storing the id separately is
   * what lets the picker show the current selection and lets a profile be reset
   * back to its generated face.
   */
  avatarId: string | null;
  isKids: boolean;
  isLocked: boolean;
}

/** A profile mid-edit: only the fields a caller is changing. */
export type ProfilePatch = Partial<Pick<ProfileData, "name" | "avatar" | "avatarId" | "isKids">>;

const PROFILES_KEY = (userId: string) => `lenium-profiles-${userId}`;
const ACTIVE_PROFILE_KEY = (userId: string) => `lenium-active-profile-${userId}`;

/** Storage key names are part of the on-disk contract; exposed for tests. */
export const PROFILE_STORAGE_KEYS = { profiles: PROFILES_KEY, active: ACTIVE_PROFILE_KEY };

/**
 * Build the avatar for a newly created profile.
 *
 * A chosen preset wins. Otherwise the avatar is generated from the name, which
 * is what profiles created before the picker existed got, so a profile still
 * lands on a sensible face if the viewer skips the picker.
 */
export function createAvatar(name: string, isKids = false, preset?: AvatarPreset | null): string {
  if (preset) return preset.url;
  return resolveAvatarUrl({ name, isKids });
}

/**
 * Drop anything that is not a usable profile and repair what can be repaired.
 *
 * This did not exist before, and its absence is why three render sites had no
 * avatar fallback: `getProfiles` only checked that the root was an array, so a
 * stored `null` entry or a record missing `avatar` flowed straight into
 * `<img src={profile.avatar}>` as `undefined`. Entries that survive are
 * re-normalised so callers never see a partially-shaped profile.
 */
export function normalizeProfile(input: unknown): ProfileData | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;

  const name = typeof record.name === "string" ? record.name : "";
  const isKids = record.isKids === true;
  const avatarId = typeof record.avatarId === "string" ? record.avatarId : null;

  // A stored avatar URL from any build is respected, including one that is not
  // in the current library. `resolveAvatarUrl` covers the missing/blank case
  // and guarantees a loadable string.
  const storedAvatar = typeof record.avatar === "string" ? record.avatar : "";
  const avatar = resolveAvatarUrl({
    avatarId,
    avatar: storedAvatar,
    name,
    isKids,
  });

  return {
    id,
    name,
    avatar,
    avatarId,
    isKids,
    isLocked: record.isLocked === true,
  };
}

export function getProfiles(userId: string): ProfileData[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeProfile)
      .filter((profile): profile is ProfileData => profile !== null);
  } catch {
    return [];
  }
}

export function saveProfiles(userId: string, profiles: ProfileData[]): void {
  localStorage.setItem(PROFILES_KEY(userId), JSON.stringify(profiles));
}

/**
 * Apply a patch to one profile in storage, leaving the rest untouched.
 *
 * Returns the updated profile, or `null` if the id is unknown. Going through
 * here rather than a read-modify-write in the context keeps the "repair on
 * read" normalisation applied to every profile, not just the one being edited.
 */
export function updateStoredProfile(
  userId: string,
  profileId: string,
  patch: ProfilePatch,
): ProfileData | null {
  const profiles = getProfiles(userId);
  const index = profiles.findIndex((p) => p.id === profileId);
  if (index === -1) return null;

  const current = profiles[index];

  /**
   * `avatarId` is the source of truth when set; `avatar` is a resolved cache of
   * it. When there is no chosen preset, `avatar` is instead *derived* from the
   * name, so anything that changes the name or the kids flag has to invalidate
   * it.
   *
   * Without this, setting `avatarId: null` alongside a new name left the old
   * preset's URL sitting in `avatar`, and `resolveAvatarUrl` -- which falls
   * back to a stored URL before generating one -- kept showing the preset face
   * after a "reset to auto".
   */
  const shouldRegenerate =
    patch.avatar === undefined &&
    (patch.avatarId === null ||
      ((patch.name !== undefined || patch.isKids !== undefined) &&
        current.avatarId === null));

  const next = normalizeProfile({
    ...current,
    ...patch,
    ...(shouldRegenerate ? { avatar: null } : {}),
  });
  if (!next) return null;

  profiles[index] = next;
  saveProfiles(userId, profiles);

  // Keep the active-profile snapshot in step, or the navbar keeps rendering the
  // pre-edit avatar until the next sign-in.
  const active = getActiveProfile(userId);
  if (active && active.id === profileId) {
    setActiveProfile(userId, next);
  }

  return next;
}

export function getActiveProfile(userId: string): ProfileData | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY(userId));
    if (!raw) return null;
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function setActiveProfile(
  userId: string,
  profile: ProfileData | null
): void {
  if (profile) {
    localStorage.setItem(ACTIVE_PROFILE_KEY(userId), JSON.stringify(profile));
  } else {
    localStorage.removeItem(ACTIVE_PROFILE_KEY(userId));
  }
}