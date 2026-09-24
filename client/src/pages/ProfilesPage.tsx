import { useState } from "react";
import { PenLine, Plus, X, LogOut } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";

/**
 * Post-login "Who's watching?" gate. Netflix-style profile cards for everyone
 * on the account; picking one activates it and lands on the home catalog.
 */
export default function ProfilesPage() {
  const { user, logout } = useAuth();
  const { profiles, activeProfile, selectProfile, addProfile, deleteProfile } =
    useActiveProfile();
  const [, navigate] = useLocation();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [kids, setKids] = useState(false);

  const handleSelect = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile || profile.isLocked) return;
    selectProfile(profile);
    navigate("/");
  };

  const handleAdd = () => {
    if (!name.trim()) return;
    const profile = addProfile(name, kids);
    setName("");
    setKids(false);
    if (!activeProfile) {
      selectProfile(profile);
      navigate("/");
    } else {
      setEditing(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050505] text-white">
      {/* Ambient backdrop glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[54rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.22),transparent)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-72 w-72 rounded-full bg-[radial-gradient(closest-side,rgba(217,70,239,0.14),transparent)] blur-3xl"
      />

      {editing ? (
        <div className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="mb-6 inline-flex w-fit items-center gap-2 text-sm text-white/50 transition hover:text-white"
          >
            <X className="h-4 w-4" />
            Back
          </button>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl backdrop-blur-xl">
            <h1 className="text-2xl font-bold">Add Profile</h1>
            <p className="mt-1 text-sm text-white/50">
              Now who's watching? Add a profile so everyone has their own space.
            </p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Profile name"
              maxLength={20}
              autoFocus
              className="mt-6 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-red-500/60 focus:ring-1 focus:ring-red-500/30"
            />
            <label className="mt-4 flex cursor-pointer items-center gap-3 text-sm text-white/70">
              <input
                type="checkbox"
                checked={kids}
                onChange={(e) => setKids(e.target.checked)}
                className="h-4 w-4 rounded border-white/30 bg-black/20 accent-indigo-500"
              />
              Kids profile (restricted titles)
            </label>
            <button
              type="button"
              disabled={!name.trim()}
              onClick={handleAdd}
              className="mt-6 w-full rounded-xl bg-white py-3 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-screen flex-col items-center justify-center px-6 py-16">
          <h1 className="text-2xl font-medium tracking-tight text-white/90 sm:text-4xl">
            Who&apos;s watching?
          </h1>

          <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => handleSelect(profile.id)}
                className="group w-28 sm:w-32"
              >
                <div className="relative mx-auto aspect-square w-full overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/10 transition group-hover:ring-white/60">
                  <img
                    src={profile.avatar}
                    alt={profile.name}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  />
                  {profile.isKids && (
                    <span className="absolute left-1.5 top-1.5 rounded bg-amber-500/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black">
                      Kids
                    </span>
                  )}
                  {editing && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteProfile(profile.id);
                      }}
                      aria-label={`Delete ${profile.name}`}
                      className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white/80 transition hover:bg-red-500 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-2 truncate text-center text-sm text-white/60 transition group-hover:text-white">
                  {profile.name}
                </p>
              </button>
            ))}

            <button
              type="button"
              onClick={() => setEditing(true)}
              className="group w-28 sm:w-32"
            >
              <div className="mx-auto grid aspect-square w-full place-items-center rounded-xl border border-dashed border-white/15 text-white/40 transition group-hover:border-white/40 group-hover:text-white">
                <Plus className="h-8 w-8" />
              </div>
              <p className="mt-2 text-center text-sm text-white/40 transition group-hover:text-white">
                Add Profile
              </p>
            </button>
          </div>

          {profiles.length === 0 && (
            <p className="mt-8 max-w-sm text-center text-sm text-white/40">
              Create your first profile to start watching.
            </p>
          )}

          <div className="mt-12 flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-5 py-2.5 text-sm font-semibold text-white/80 transition hover:border-white/50 hover:text-white"
            >
              <PenLine className="h-4 w-4" />
              Manage Profiles
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex items-center gap-2 text-xs text-white/40 transition hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out of {user?.name ?? "Stream Vy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}