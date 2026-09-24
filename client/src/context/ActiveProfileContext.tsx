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
import {
  createAvatar,
  getActiveProfile,
  getProfiles,
  saveProfiles as persistProfiles,
  setActiveProfile as persistActive,
  type ProfileData,
} from "@/services/profiles";

export interface ActiveProfileContextType {
  profiles: ProfileData[];
  activeProfile: ProfileData | null;
  selectProfile: (profile: ProfileData) => void;
  addProfile: (name: string, isKids?: boolean) => ProfileData;
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
    (name: string, isKids = false) => {
      const userIdNotNull = userId;
      if (!userIdNotNull) {
        throw new Error("Cannot add a profile while signed out");
      }
      const profile: ProfileData = {
        id: crypto.randomUUID(),
        name: name.trim(),
        avatar: createAvatar(name),
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
      deleteProfile,
      refreshProfiles,
    }),
    [profiles, activeProfile, selectProfile, addProfile, deleteProfile, refreshProfiles]
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