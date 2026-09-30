/**
 * Server-backed watch profiles.
 *
 * Profiles used to live only in localStorage, which meant switching profiles
 * changed nothing on the server: history, My List and progress were all keyed
 * on the account, so two profiles in one home shared one set of rows. These
 * profiles are real rows, so the same ids are used everywhere and the same
 * profile is seen on every device.
 *
 * The local `services/profiles.ts` store is still the source of truth for the
 * *viewer's choice* of active profile (a local preference, not shared data),
 * but every record it names now refers to a server profile.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  apiClaimAllowance,
  apiProfileCreate,
  apiProfileDelete,
  apiProfiles,
  apiProfileUnlock,
  apiProfileUpdate,
  apiReferralStatus,
  type ApiProfile,
  type DailyAllowance,
  type ReferralStatus,
} from "@/services/auth";

const ACTIVE_PROFILE_KEY = (userId: string) => `lenium-active-profile-${userId}`;

/** The viewer's chosen profile, kept per account and shared across tabs. */
export function getStoredActiveProfileId(userId: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY(userId));
  } catch {
    return null;
  }
}

export function setStoredActiveProfileId(userId: string, profileId: string | null): void {
  try {
    if (profileId) localStorage.setItem(ACTIVE_PROFILE_KEY(userId), profileId);
    else localStorage.removeItem(ACTIVE_PROFILE_KEY(userId));
  } catch {
    /* storage unavailable */
  }
}

export interface ProfilesState {
  profiles: ApiProfile[];
  activeProfile: ApiProfile | null;
  max: number;
  loading: boolean;
  error: string | null;
  selectProfile: (profileId: string) => void;
  createProfile: (input: {
    name: string;
    avatar?: string;
    avatar_id?: string | null;
    is_kids?: boolean;
    pin?: string;
  }) => Promise<ApiProfile | null>;
  updateProfile: (
    profileId: string,
    input: { name?: string; avatar?: string; avatar_id?: string | null; is_kids?: boolean; pin?: string }
  ) => Promise<ApiProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
  unlockProfile: (profileId: string, pin: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useProfiles(): ProfilesState {
  const { user } = useAuth();
  const userId = user ? String(user.id) : null;
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [max, setMax] = useState(4);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setProfiles([]);
      setActiveId(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiProfiles();
      setProfiles(data.profiles);
      setMax(data.max);
      // Prefer the stored choice, but fall back to the first profile: a stored
      // id can be stale after the profile is deleted on another device.
      const stored = getStoredActiveProfileId(userId);
      const stillThere = data.profiles.some((p) => String(p.id) === stored);
      const next = stillThere ? stored : data.profiles[0]?.id ?? null;
      setActiveId(next);
      setStoredActiveProfileId(userId, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load profiles.");
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectProfile = useCallback(
    (profileId: string) => {
      setActiveId(profileId);
      if (userId) setStoredActiveProfileId(userId, profileId);
    },
    [userId]
  );

  const createProfile: ProfilesState["createProfile"] = useCallback(
    async (input) => {
      try {
        const created = await apiProfileCreate(input);
        setProfiles((current) => [...current, created]);
        if (!userId) return created;
        const next = getStoredActiveProfileId(userId) ?? created.id;
        setActiveId(next);
        setStoredActiveProfileId(userId, next);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create the profile.");
        return null;
      }
    },
    [userId]
  );

  const updateProfile: ProfilesState["updateProfile"] = useCallback(
    async (profileId, input) => {
      const updated = await apiProfileUpdate(profileId, input);
      setProfiles((current) => current.map((p) => (String(p.id) === String(updated.id) ? updated : p)));
      return updated;
    },
    []
  );

  const deleteProfile: ProfilesState["deleteProfile"] = useCallback(
    async (profileId) => {
      await apiProfileDelete(profileId);
      setProfiles((current) => {
        const next = current.filter((p) => String(p.id) !== String(profileId));
        if (userId && getStoredActiveProfileId(userId) === String(profileId)) {
          const fallback = next[0]?.id ?? null;
          setActiveId(fallback);
          setStoredActiveProfileId(userId, fallback);
        }
        return next;
      });
    },
    [userId]
  );

  const unlockProfile: ProfilesState["unlockProfile"] = useCallback(async (profileId, pin) => {
    try {
      await apiProfileUnlock(profileId, pin);
      return true;
    } catch {
      return false;
    }
  }, []);

  const activeProfile = useMemo(
    () => profiles.find((p) => String(p.id) === String(activeId)) ?? null,
    [profiles, activeId]
  );

  return {
    profiles,
    activeProfile,
    max,
    loading,
    error,
    selectProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    unlockProfile,
    refresh,
  };
}

// ---------------------------------------------------------------------------
// daily allowance & referrals
// ---------------------------------------------------------------------------

export interface AllowanceState {
  allowance: DailyAllowance | null;
  loading: boolean;
  /**
   * Set when the last attempt was refused because the profile is out of
   * allowance. Cleared by `claim` on success.
   */
  limited: { message: string; resetsAt: string } | null;
  claim: (movieKey: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useAllowance(profileId: string | null): AllowanceState {
  const { user } = useAuth();
  const [allowance, setAllowance] = useState<DailyAllowance | null>(null);
  const [loading, setLoading] = useState(false);
  const [limited, setLimited] = useState<{ message: string; resetsAt: string } | null>(null);

  const load = useCallback(async () => {
    if (!user || !profileId) {
      setAllowance(null);
      return;
    }
    setLoading(true);
    try {
      const { apiAllowance } = await import("@/services/auth");
      const data = await apiAllowance(profileId);
      setAllowance(data.allowance);
    } catch {
      // A failure here must not block playback: the server re-checks on claim.
      setAllowance(null);
    } finally {
      setLoading(false);
    }
  }, [user, profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = useCallback(
    async (movieKey: string) => {
      if (!user || !profileId) return true;
      try {
        const result = await apiClaimAllowance(profileId, movieKey);
        setAllowance(result.allowance);
        setLimited(null);
        return true;
      } catch (err) {
        const anyErr = err as {
          status?: number;
          message?: string;
          body?: { resets_at?: string; allowance?: { resets_at?: string } };
        };
        if (anyErr?.status === 429) {
          // The reset time lives on the allowance object the 429 carries. It was
          // read from `body.resets_at`, which is never set, so the notice always
          // rendered an empty reset time even though the server had sent it.
          const resetsAt =
            anyErr.body?.allowance?.resets_at ?? anyErr.body?.resets_at ?? "";
          setLimited({
            message: anyErr.message || "You have used today's free titles.",
            resetsAt,
          });
          void load();
          return false;
        }
        // Any other failure (network, signed out, no profile) is not a
        // refusal, so playback continues rather than falsely claiming a limit.
        return true;
      }
    },
    [user, profileId, load]
  );

  return { allowance, loading, limited, claim, refresh: load };
}

export function useReferral() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ReferralStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      setStatus(await apiReferralStatus());
      setError(null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(async (code: string) => {
    const { apiReferralApply } = await import("@/services/auth");
    const next = await apiReferralApply(code);
    setStatus(next);
    setError(null);
    return next;
  }, []);

  return { status, loading, error, apply, refresh };
}
