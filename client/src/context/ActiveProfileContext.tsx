import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/context/AuthContext";
import type { AvatarPreset } from "@/lib/avatars";
import {
  createAvatar,
  getActiveProfile,
  getProfiles,
  saveProfiles as persistProfiles,
  setActiveProfile as persistActive,
  updateStoredProfile,
  type ProfileData,
  type ProfilePatch,
} from "@/services/profiles";

export interface ActiveProfileContextType {
  profiles: ProfileData[];
  activeProfile: ProfileData | null;
  selectProfile: (profile: ProfileData) => void;
  /**
   * `preset` is the chosen avatar when the picker was used. Omitting it keeps
   * the old behaviour of generating a face from the name, so every existing
   * caller stays valid.
   */
  addProfile: (
    name: string,
    isKids?: boolean,
    preset?: AvatarPreset | null,
  ) => ProfileData;
  /** Patch name/avatar/kids in place. Returns the updated profile. */
  updateProfile: (profileId: string, patch: ProfilePatch) => ProfileData | null;
  deleteProfile: (profileId: string) => void;
  refreshProfiles: () => void;
}

const ActiveProfileContext = createContext<
  ActiveProfileContextType | undefined
>(undefined);

export function ActiveProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user ? String(user.id) : null;

  const [profiles, setProfiles] = useState<ProfileData[]>([]);
  const [activeProfile, setActiveProfile] = useState<ProfileData | null>(null);

  // Reload profile state whenever the signed-in account changes.
  useEffect(() => {
    if (!userId) {
      setProfiles([]);
      setActiveProfile(null);
      return;
    }
    setProfiles(getProfiles(userId));
    setActiveProfile(getActiveProfile(userId));
  }, [userId]);

  const selectProfile = useCallback(
    (profile: ProfileData) => {
      setActiveProfile(profile);
      if (userId) persistActive(userId, profile);
    },
    [userId]
  );

  const addProfile = useCallback(
    (name: string, isKids = false, preset: AvatarPreset | null = null) => {
      const userIdNotNull = userId;
      if (!userIdNotNull) {
        throw new Error("Cannot add a profile while signed out");
      }
      const profile: ProfileData = {
        id: crypto.randomUUID(),
        name: name.trim(),
        avatar: createAvatar(name, isKids, preset),
        // Only a preset the viewer actually chose is recorded as chosen; a
        // generated avatar must stay distinguishable from a picked one or the
        // picker would highlight a face the viewer never picked.
        avatarId: preset?.id ?? null,
        isKids,
        isLocked: false,
      };
      const updated = [...profiles, profile];
      setProfiles(updated);
      persistProfiles(userIdNotNull, updated);
      return profile;
    },
    [userId, profiles]
  );

  const updateProfile = useCallback(
    (profileId: string, patch: ProfilePatch) => {
      const userIdNotNull = userId;
      if (!userIdNotNull) return null;
      const updated = updateStoredProfile(userIdNotNull, profileId, patch);
      if (!updated) return null;
      // Re-read rather than splicing locally: `updateStoredProfile` normalises,
      // and a patch that clears `avatar` gets its generated url back here.
      setProfiles(getProfiles(userIdNotNull));
      setActiveProfile(getActiveProfile(userIdNotNull));
      return updated;
    },
    [userId]
  );

  const deleteProfile = useCallback(
    (profileId: string) => {
      const userIdNotNull = userId;
      if (!userIdNotNull) return;
      const updated = profiles.filter((p) => p.id !== profileId);
      setProfiles(updated);
      persistProfiles(userIdNotNull, updated);
      if (activeProfile?.id === profileId) {
        setActiveProfile(null);
        persistActive(userIdNotNull, null);
      }
    },
    [userId, profiles, activeProfile]
  );

  const refreshProfiles = useCallback(() => {
    if (!userId) return;
    setProfiles(getProfiles(userId));
    setActiveProfile(getActiveProfile(userId));
  }, [userId]);

  const value = useMemo(
    () => ({
      profiles,
      activeProfile,
      selectProfile,
      addProfile,
      updateProfile,
      deleteProfile,
      refreshProfiles,
    }),
    [profiles, activeProfile, selectProfile, addProfile, updateProfile, deleteProfile, refreshProfiles]
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