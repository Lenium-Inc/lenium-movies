/**
 * Profiles are server rows, but the UI still works in `ProfileData`.
 *
 * The two shapes are kept apart on purpose: the server speaks snake_case and
 * knows about PIN hashes and sort order, while the render layer needs a
 * resolved avatar URL and camelCase. `toProfileData` is the one place that
 * translation happens, so a field added to the API shows up as a compile error
 * here instead of `undefined` at five render sites.
 */
import type { ApiProfile } from "@/services/auth";
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
export type ProfilePatch = Partial<
  Pick<ProfileData, "name" | "avatar" | "avatarId" | "isKids">
>;

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
 * This is applied to server rows too, not just stored ones: a profile written
 * by a build that stored a blank avatar, or one that predates the preset
 * library, has to degrade to a generated face rather than rendering
 * `<img src={undefined}>`.
 */
export function normalizeProfile(input: unknown): ProfileData | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;

  const id =
    typeof record.id === "string"
      ? record.id.trim()
      : typeof record.id === "number"
        ? String(record.id)
        : "";
  if (!id) return null;

  const name = typeof record.name === "string" ? record.name : "";
  const isKids = record.isKids === true || record.is_kids === true;
  const avatarId =
    typeof record.avatarId === "string"
      ? record.avatarId
      : typeof record.avatar_id === "string"
        ? record.avatar_id
        : null;

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
    isLocked: record.isLocked === true || record.is_locked === true,
  };
}

/** Server row -> render shape. */
export function toProfileData(api: ApiProfile): ProfileData {
  return (
    normalizeProfile(api) ?? {
      id: String(api.id),
      name: api.name,
      avatar: createAvatar(api.name, api.is_kids),
      avatarId: api.avatar_id,
      isKids: api.is_kids,
      isLocked: api.is_locked,
    }
  );
}
