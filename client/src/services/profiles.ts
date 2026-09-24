export interface ProfileData {
  id: string;
  name: string;
  avatar: string;
  isKids: boolean;
  isLocked: boolean;
}

const PROFILES_KEY = (userId: string) => `lenium-profiles-${userId}`;
const ACTIVE_PROFILE_KEY = (userId: string) => `lenium-active-profile-${userId}`;

export function createAvatar(name: string): string {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.trim())}`;
}

export function getProfiles(userId: string): ProfileData[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveProfiles(userId: string, profiles: ProfileData[]): void {
  localStorage.setItem(PROFILES_KEY(userId), JSON.stringify(profiles));
}

export function getActiveProfile(userId: string): ProfileData | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY(userId));
    if (!raw) return null;
    return JSON.parse(raw);
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