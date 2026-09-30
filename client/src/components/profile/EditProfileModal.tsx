import { useState } from "react";
import { Check, X } from "lucide-react";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { AvatarPicker } from "@/components/profile/AvatarPicker";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";
import {
  defaultAvatarId,
  defaultAvatarUrl,
  presetById,
  type AvatarPreset,
} from "@/lib/avatars";
import type { ProfileData } from "@/services/profiles";

/**
 * Edit an existing profile's name and avatar.
 *
 * There was no edit surface at all before this: a profile's name and kids flag
 * were fixed at creation, and the only mutators were `selectProfile` and
 * `deleteProfile`. The avatar picker is most useful *after* creation, since that
 * is when a viewer can see the face next to the name in context, so it needs a
 * home of its own rather than only appearing in the create form.
 */
export function EditProfileModal({
  profile,
  onClose,
}: {
  profile: ProfileData;
  onClose: () => void;
}) {
  const { updateProfile } = useActiveProfile();
  const [name, setName] = useState(profile.name);
  const [preset, setPreset] = useState<AvatarPreset | null>(() =>
    presetById(profile.avatarId),
  );
  // The save is a server round trip now. Closing the dialog optimistically used
  // to be fine because the write was local; with a server write a failure would
  // leave the viewer looking at the old name having been told it saved.
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();

  const handleSave = async () => {
    if (!trimmed || busy) return;
    // `avatarId: null` alongside a generated url is the "reset to the face
    // derived from this name" state, which is distinct from a chosen preset.
    const patch: Parameters<typeof updateProfile>[1] = {};
    if (trimmed !== profile.name) patch.name = trimmed;
    if (preset) {
      patch.avatarId = preset.id;
      patch.avatar = preset.url;
    } else if (profile.avatarId) {
      patch.avatarId = null;
      patch.avatar = defaultAvatarUrl(trimmed, profile.isKids);
    }
    setBusy(true);
    try {
      await updateProfile(profile.id, patch);
      onClose();
    } catch {
      // Keep the dialog open so the edit is not lost.
    } finally {
      setBusy(false);
    }
  };

  const handleResetAvatar = () => {
    setPreset(null);
    void updateProfile(profile.id, {
      avatarId: null,
      avatar: defaultAvatarUrl(trimmed || profile.name, profile.isKids),
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${profile.name}`}
      onClick={onClose}
    >
      <div
        onClick={event => event.stopPropagation()}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-white/10 bg-[#121214] shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center gap-4 border-b border-white/10 p-6">
          <ProfileAvatar
            className="h-14 w-14 shrink-0"
            square
            alt=""
            profile={{
              name: trimmed || profile.name,
              avatarId: preset?.id ?? null,
              isKids: profile.isKids,
            }}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-white">Edit Profile</h2>
            <p className="mt-0.5 text-sm text-white/50">
              Change the name or pick a different avatar.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-white/70 transition hover:bg-white/20 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6">
          <label
            htmlFor={`edit-profile-name-${profile.id}`}
            className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40"
          >
            Name
          </label>
          <input
            id={`edit-profile-name-${profile.id}`}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={20}
            className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
          />

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                Avatar
              </h3>
              {profile.avatarId ? (
                <button
                  type="button"
                  onClick={handleResetAvatar}
                  className="text-[11px] text-white/40 transition hover:text-white"
                >
                  Use auto-generated
                </button>
              ) : null}
            </div>
            <div className="mt-2.5">
              <AvatarPicker
                value={preset?.id ?? null}
                onChange={setPreset}
                label={`Avatar for ${profile.name}`}
              />
            </div>
          </div>
        </div>

        <div className="flex gap-3 border-t border-white/10 p-6">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/60 transition hover:border-white/40 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!trimmed || busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Re-exported so callers can offer "auto" as an explicit choice. */
export { defaultAvatarId };
