import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useAuth } from "@/context/AuthContext";
import { useProfiles } from "@/hooks/useProfiles";
import { createAvatar, toProfileData, type ProfileData, type ProfilePatch } from "@/services/profiles";
import type { AvatarPreset } from "@/lib/avatars";

/**
 * Active-profile state, backed by server rows.
 *
 * This used to be a localStorage array of profiles with `crypto.randomUUID()`
 * ids. That was fine while history, My List and the daily allowance were all
 * keyed on the account, but it meant two problems once profiles became real
 * rows: the ids the UI held were unknown to the server, and the same key
 * (`lenium-active-profile-<userId>`) was written in two incompatible formats,
 * so selecting a profile in the picker silently left the watch page on a
 * different one.
 *
 * Now there is exactly one source of truth -- `useProfiles` -- and this context
 * exists only to adapt the snake_case server row to the `ProfileData` shape the
 * render layer already uses. It is deliberately a thin wrapper: every
 * mutator is async because the server is, and callers that assumed a
 * synchronous result have been updated.
 */
export interface ActiveProfileContextType {
  profiles: ProfileData[];
  activeProfile: ProfileData | null;
  selectProfile: (profile: ProfileData) => void;
  /**
   * `preset` is the chosen avatar when the picker was used. Omitting it keeps
   * the old behaviour of generating a face from the name, so every existing
   * caller stays valid.
   *
   * Async because the row is created on the server. Resolves to the new
   * profile, or `null` if the account is already at its profile limit.
   */
  addProfile: (
    name: string,
    isKids?: boolean,
    preset?: AvatarPreset | null,
  ) => Promise<ProfileData | null>;
  /** Patch name/avatar/kids in place. Resolves to the updated profile. */
  updateProfile: (
    profileId: string,
    patch: ProfilePatch,
  ) => Promise<ProfileData | null>;
  deleteProfile: (profileId: string) => Promise<void>;
  refreshProfiles: () => Promise<void>;
  /** Set when a profile mutation failed, e.g. the 4-profile limit. */
  error: string | null;
  loading: boolean;
  /** Server-enforced profile ceiling for this account. */
  max: number;
}

const ActiveProfileContext = createContext<
  ActiveProfileContextType | undefined
>(undefined);

export function ActiveProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { profiles, activeProfile, selectProfile: selectServerProfile, createProfile, updateProfile: updateServerProfile, deleteProfile: deleteServerProfile, refresh, max, loading, error } =
    useProfiles();

  // Signed out: the hook already clears, this just avoids rendering a stale
  // profile from the previous account for a frame during sign-out.
  const accountId = user ? String(user.id) : null;

  const mapped = useMemo(
    () => (accountId ? profiles.map(toProfileData) : []),
    [accountId, profiles]
  );

  const active = useMemo(() => {
    if (!accountId) return null;
    return mapped.find((p) => p.id === String(activeProfile?.id)) ?? null;
  }, [accountId, mapped, activeProfile]);

  const selectProfile = useCallback(
    (profile: ProfileData) => {
      selectServerProfile(profile.id);
    },
    [selectServerProfile]
  );

  const addProfile: ActiveProfileContextType["addProfile"] = useCallback(
    async (name, isKids = false, preset = null) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const created = await createProfile({
        name: trimmed,
        // The server has no avatar library, so the generated URL is sent as a
        // plain string alongside the preset id. That keeps the resolved image
        // identical on every device, which is the point of a server row.
        avatar: createAvatar(trimmed, isKids, preset),
        avatar_id: preset?.id ?? null,
        is_kids: isKids,
      });
      return created ? toProfileData(created) : null;
    },
    [createProfile]
  );

  const updateProfile: ActiveProfileContextType["updateProfile"] = useCallback(
    async (profileId, patch) => {
      const input: {
        name?: string;
        avatar?: string;
        avatar_id?: string | null;
        is_kids?: boolean;
      } = {};
      if (patch.name !== undefined) input.name = patch.name;
      if (patch.avatar !== undefined) input.avatar = patch.avatar;
      if (patch.avatarId !== undefined) input.avatar_id = patch.avatarId;
      if (patch.isKids !== undefined) input.is_kids = patch.isKids;
      const updated = await updateServerProfile(profileId, input);
      return toProfileData(updated);
    },
    [updateServerProfile]
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      await deleteServerProfile(profileId);
    },
    [deleteServerProfile]
  );

  const value = useMemo(
    () => ({
      profiles: mapped,
      activeProfile: active,
      selectProfile,
      addProfile,
      updateProfile,
      deleteProfile,
      refreshProfiles: refresh,
      error,
      loading,
      max,
    }),
    [mapped, active, selectProfile, addProfile, updateProfile, deleteProfile, refresh, error, loading, max]
  );

  return (
    <ActiveProfileContext.Provider value={value}>
      {children}
    </ActiveProfileContext.Provider>
  );
}

export function useActiveProfile(): ActiveProfileContextType {
  const context = useContext(ActiveProfileContext);
  if (!context) {
    throw new Error(
      "useActiveProfile must be used within an ActiveProfileProvider"
    );
  }
  return context;
}
