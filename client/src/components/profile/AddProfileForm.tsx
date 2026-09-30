import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { AvatarPicker } from "@/components/profile/AvatarPicker";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";
import { defaultAvatarId, type AvatarPreset } from "@/lib/avatars";

/**
 * Add-profile form shared by the profiles gate and the account page.
 *
 * This exists because the two surfaces were near-identical copies with no
 * avatar selection in either. Any future change to profile creation would have
 * had to be made twice, which is how the two drifted.
 */
export function AddProfileForm({
  onDone,
}: {
  /** Called with the created profile when the form is submitted. */
  onDone?: (profileId: string) => void;
}) {
  const { addProfile, profiles, max, error } = useActiveProfile();
  const [name, setName] = useState("");
  const [kids, setKids] = useState(false);
  // `null` means "no preset chosen yet", which previews the avatar that will be
  // generated from the name. A profile is still created if the viewer ignores
  // the picker, so this needs to be a valid starting state rather than a
  // required choice.
  const [preset, setPreset] = useState<AvatarPreset | null>(null);
  // Creating a profile is a server round trip now, and the account is capped
  // at four, so the button has to be able to show that it is working and stay
  // disabled until the row comes back -- otherwise a double click can spend two
  // of the four slots and the form looks like it did nothing.
  const [busy, setBusy] = useState(false);
  // A 4-digit lock, for a kids profile or a shared TV. Optional: leaving it
  // blank creates an unlocked profile, which is the common case.
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  // The account is capped server-side. The form used to ignore `profiles.length`
  // and just fail on the 409, so the button looked broken at the limit instead of
  // explaining it.
  const atLimit = profiles.length >= max;

  const handleAdd = async () => {
    if (!name.trim() || busy) return;
    const digits = pin.replace(/\D/g, "");
    if (pin && digits.length !== 4) {
      setPinError("A profile PIN is exactly 4 digits.");
      return;
    }
    setPinError(null);
    setBusy(true);
    try {
      const profile = await addProfile(name, kids, preset, digits || undefined);
      if (!profile) return;
      setName("");
      setKids(false);
      setPreset(null);
      setPin("");
      onDone?.(profile.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
      <div className="flex items-center gap-4">
        <ProfileAvatar
          className="h-16 w-16 shrink-0"
          square
          alt=""
          profile={{
            name: name.trim() || "New profile",
            avatarId: preset?.id ?? defaultAvatarId(kids),
            isKids: kids,
          }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-white">Add Profile</h3>
          <p className="mt-0.5 text-sm text-white/50">
            Pick a face and a name for this profile.
          </p>
        </div>
      </div>

      <label htmlFor="add-profile-name" className="sr-only">
        Profile name
      </label>
      <input
        id="add-profile-name"
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Profile name"
        maxLength={20}
        className="mt-6 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
      />

      <label
        htmlFor="add-profile-kids"
        className="mt-4 flex cursor-pointer items-center gap-3 text-sm text-white/70"
      >
        <input
          id="add-profile-kids"
          type="checkbox"
          checked={kids}
          onChange={e => {
            setKids(e.target.checked);
            // A kids profile should not keep a preset chosen while the box was
            // unchecked; the preview would otherwise show an adult face for a
            // restricted profile.
            if (e.target.checked) setPreset(null);
          }}
          className="h-4 w-4 rounded border-white/30 bg-black/20 accent-indigo-500"
        />
        Kids profile (restricted titles)
      </label>

      <div className="mt-6">
        <AvatarPicker value={preset?.id ?? null} onChange={setPreset} />
      </div>

      <div className="mt-5">
        <label htmlFor="add-profile-pin" className="text-sm text-white/70">
          PIN <span className="text-white/40">(optional)</span>
        </label>
        <input
          id="add-profile-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={4}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="4 digits"
          aria-describedby={pinError ? "add-profile-pin-error" : undefined}
          className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
        />
        {pinError && (
          <p id="add-profile-pin-error" className="mt-2 text-xs text-red-300">
            {pinError}
          </p>
        )}
      </div>

      {atLimit && (
        <p className="mt-5 rounded-lg bg-white/5 p-3 text-sm text-amber-200">
          This account already has {profiles.length} profiles, which is the limit
          of {max}. Delete one to make room.
        </p>
      )}
      {error && !atLimit && (
        <p className="mt-5 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!name.trim() || busy || atLimit}
        onClick={handleAdd}
        className="mt-6 w-full rounded-xl bg-white py-3 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Creating…" : atLimit ? "Profile limit reached" : "Continue"}
      </button>
    </div>
  );
}

/** Small "add profile" tile used in profile grids. */
export function AddProfileTile({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group w-28 sm:w-32">
      <div className="mx-auto grid aspect-square w-full place-items-center rounded-xl border border-dashed border-white/15 text-white/40 transition group-hover:border-white/40 group-hover:text-white">
        <Plus className="h-8 w-8" />
      </div>
      <p className="mt-2 text-center text-sm text-white/40 transition group-hover:text-white">
        Add Profile
      </p>
    </button>
  );
}
