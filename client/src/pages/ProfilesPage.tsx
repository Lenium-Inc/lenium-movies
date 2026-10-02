import { useState } from "react";
import { LogOut, PenLine, X } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import {
  AddProfileForm,
  AddProfileTile,
} from "@/components/profile/AddProfileForm";
import { EditProfileModal } from "@/components/profile/EditProfileModal";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";
import type { ProfileData } from "@/services/profiles";

/**
 * Post-login "Who's watching?" gate. Netflix-style profile cards for everyone
 * on the account; picking one activates it and lands on the home catalog.
 */
export default function ProfilesPage() {
  const { user, logout } = useAuth();
  const { profiles, activeProfile, selectProfile, deleteProfile } =
    useActiveProfile();
  const [, navigate] = useLocation();

  const [adding, setAdding] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ProfileData | null>(
    null
  );

  const handleSelect = (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile || profile.isLocked) return;
    selectProfile(profile);
    navigate("/");
  };

  const handleAdded = () => {
    // Only the very first profile has to route away: with none selected yet
    // there is nothing to watch behind the gate. Afterwards the viewer stays
    // here to keep setting up the household.
    if (!activeProfile) {
      navigate("/");
    } else {
      setAdding(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden text-white">
      {/* Ambient backdrop glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[54rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.22),transparent)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-72 w-72 rounded-full bg-[radial-gradient(closest-side,rgba(217,70,239,0.14),transparent)] blur-3xl"
      />

      {adding ? (
        <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="mb-6 inline-flex w-fit items-center gap-2 text-sm text-white/50 transition hover:text-white"
          >
            <X className="h-4 w-4" />
            Back
          </button>
          <AddProfileForm onDone={handleAdded} />
        </div>
      ) : (
        <div className="relative flex min-h-screen flex-col items-center justify-center px-6 py-16">
          <h1 className="text-2xl font-medium tracking-tight text-white/90 sm:text-4xl">
            Who&apos;s watching?
          </h1>

          <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
            {profiles.map(profile => (
              <div key={profile.id} className="group w-28 sm:w-32">
                <button
                  type="button"
                  onClick={() => handleSelect(profile.id)}
                  aria-label={`Switch to ${profile.name}`}
                  className="block w-full"
                >
                  <div className="relative mx-auto aspect-square w-full overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/10 transition group-hover:ring-white/60">
                    <ProfileAvatar
                      className="h-full w-full rounded-xl"
                      square
                      alt=""
                      profile={profile}
                    />
                    {profile.isKids && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-amber-500/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black">
                        Kids
                      </span>
                    )}
                  </div>
                </button>

                {/* Siblings of the tile button rather than children of it. A
                    button inside a button is invalid HTML and browsers reparent
                    it, which silently steals the tile's own click target. */}
                <div className="mt-1.5 flex items-center justify-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditingProfile(profile)}
                    aria-label={`Edit ${profile.name}`}
                    className="grid h-6 w-6 place-items-center rounded-full bg-white/5 text-white/50 transition hover:bg-white/15 hover:text-white"
                  >
                    <PenLine className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteProfile(profile.id)}
                    aria-label={`Delete ${profile.name}`}
                    className="grid h-6 w-6 place-items-center rounded-full bg-white/5 text-white/50 transition hover:bg-red-500 hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>

                <p className="truncate text-center text-sm text-white/60 transition group-hover:text-white">
                  {profile.name}
                </p>
              </div>
            ))}

            <AddProfileTile onClick={() => setAdding(true)} />
          </div>

          {profiles.length === 0 && (
            <p className="mt-8 max-w-sm text-center text-sm text-white/40">
              Create your first profile to start watching.
            </p>
          )}

          <div className="mt-12 flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex items-center gap-2 text-xs text-white/40 transition hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out of {user?.name ?? "Lenium"}
            </button>
          </div>
        </div>
      )}

      {editingProfile ? (
        <EditProfileModal
          profile={editingProfile}
          onClose={() => setEditingProfile(null)}
        />
      ) : null}
    </div>
  );
}
