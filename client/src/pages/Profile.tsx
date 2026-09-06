import { useEffect, useState, type ReactNode } from "react";
import {
  CirclePlay,
  Clock3,
  Download,
  KeyRound,
  ListVideo,
  LockKeyhole,
  LogOut,
  MonitorSmartphone,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  exportUserData,
  getAccount,
  setPlan,
  signOutSession,
  subscribeAccount,
  toggleTwoFactor,
  updatePassword,
  wipeLocalData,
  type DeviceSession,
  type PlanTier,
} from "@/services/account";
import {
  getSettings,
  setSettings,
  subscribeSettings,
  type QualityPref,
  type SubtitlePref,
  type ThemeMode,
} from "@/services/settings";
import {
  LIST_TAGS,
  removeFromList,
  setEntryTag,
  sortedEntries,
  subscribeList,
  type ListTag,
} from "@/services/lists";
import {
  ratingLog,
  removeRating,
  subscribeRatings,
  type RatingEntry,
} from "@/services/ratings";
import {
  clearHistory,
  continueWatching,
  removeFromHistory,
} from "@/services/history";
import {
  ACHIEVEMENTS,
  earnedAchievements,
  hoursWatched,
  nextMilestone,
  subscribeStats,
} from "@/services/stats";
import { capLimit, dayCount, dayLocked } from "@/services/capGate";

const RADIUS = 30;
const CIRC = 2 * Math.PI * RADIUS;

function useRevision(): void {
  const [, setRev] = useState(0);
  useEffect(() => {
    const unsubs: Array<() => void> = [
      subscribeAccount(() => setRev(r => r + 1)),
      subscribeSettings(() => setRev(r => r + 1)),
      subscribeList(() => setRev(r => r + 1)),
      subscribeRatings(() => setRev(r => r + 1)),
      subscribeStats(() => setRev(r => r + 1)),
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}

function Toggle({ checked, onChange, label, description }: ToggleProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--fs-text)]">{label}</p>
        {description && (
          <p className="mt-0.5 text-xs leading-5 text-[var(--fs-sub)]">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-white" : "bg-white/15"
        }`}
        aria-label={label}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-black transition-all ${
            checked ? "left-[calc(100%-1.25rem)]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
            option.value === value
              ? "bg-white text-black"
              : "border border-[var(--fs-line)] text-[var(--fs-text)] hover:bg-white/10"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface SectionProps {
  step: string;
  title: string;
  description?: string;
  icon: ReactNode;
  children: ReactNode;
}

function Section({ step, title, description, icon, children }: SectionProps) {
  return (
    <section className="rounded-xl border border-[var(--fs-line)] bg-[var(--fs-surface)]">
      <header className="flex items-center gap-3 border-b border-[var(--fs-line)] px-5 py-4">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-[var(--fs-text)]">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--fs-sub)]">
            {step}
          </p>
          <h2 className="text-sm font-bold text-[var(--fs-text)]">{title}</h2>
          {description && (
            <p className="text-[11px] leading-5 text-[var(--fs-sub)]">
              {description}
            </p>
          )}
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--fs-sub)]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-md border border-[var(--fs-line)] bg-[var(--fs-elev)] px-3 py-2 text-sm text-[var(--fs-text)] outline-none placeholder:text-[var(--fs-sub)] focus:border-white/40"
      />
    </label>
  );
}

function Stars({ value, size = "h-3.5 w-3.5" }: { value: number; size?: string }) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <Star
          key={star}
          className={`${size} ${
            star <= Math.round(value)
              ? "fill-[#d7d7d3] text-[#d7d7d3]"
              : "text-[var(--fs-sub)]"
          }`}
        />
      ))}
    </span>
  );
}

function Poster({ src, title }: { src: string | null; title: string }) {
  return src ? (
    <img src={src} alt="" className="h-14 w-10 shrink-0 rounded object-cover" />
  ) : (
    <span className="grid h-14 w-10 shrink-0 place-items-center rounded bg-[var(--fs-elev)] text-sm font-black text-[var(--fs-sub)]">
      {title.charAt(0).toUpperCase()}
    </span>
  );
}

const THEMES: { value: ThemeMode; label: string; swatch: string }[] = [
  { value: "void", label: "Void Black", swatch: "#050505" },
  { value: "charcoal", label: "Deep Charcoal", swatch: "#1f1f22" },
  { value: "high", label: "High Contrast", swatch: "#ffffff" },
];

const QUALITIES: { value: QualityPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "320p", label: "320p" },
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "4K", label: "4K" },
];

const SUBTITLE_OPTIONS: { value: SubtitlePref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export default function Profile() {
  useRevision();
  const { user, logout } = useAuth();
  const account = getAccount();
  const settings = getSettings();
  const [listFilter, setListFilter] = useState<ListTag | "all">("all");
  const list = sortedEntries(listFilter);
  const ratings = ratingLog();
  const queue = continueWatching();

  const hours = hoursWatched();
  const milestone = nextMilestone();
  const count = dayCount();
  const limit = capLimit();
  const locked = dayLocked();
  const earned = earnedAchievements();
  const earnedIds = new Set(earned.map(a => a.id));

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const submitPassword = async () => {
    if (newPassword !== confirmPassword) {
      toast.error("The two new-password fields don't match.");
      return;
    }
    setSavingPassword(true);
    const result = await updatePassword(currentPassword, newPassword);
    setSavingPassword(false);
    if (!result.ok) {
      toast.error(result.error ?? "Couldn't update your password.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    toast.success("Password updated.");
  };

  const toggle2FA = async () => {
    if (account.twoFactor) {
      await toggleTwoFactor(false, "");
      toast.success("Two-factor authentication disabled.");
      return;
    }
    const result = await toggleTwoFactor(true, twoFactorPassword);
    if (!result.ok) {
      toast.error(result.error ?? "Couldn't enable two-factor.");
      return;
    }
    setTwoFactorPassword("");
    toast.success("Two-factor authentication enabled.");
  };

  const download = () => {
    const payload = exportUserData();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `freestream-data-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Your data is downloading.");
  };

  const deleteAccount = async () => {
    const ok = window.confirm(
      "Permanently delete your FreeStream profile, viewing history, and ratings on this device? This can't be undone."
    );
    if (!ok) return;
    wipeLocalData();
    await logout();
    window.location.href = "/";
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:px-6">
      <header className="flex items-center gap-4">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-white text-xl font-black text-black">
          {(user?.name ?? account.displayName).charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--fs-text)]">
            {(user?.name ?? account.displayName) || "Viewer"}
          </h1>
          <p className="text-sm text-[var(--fs-sub)]">
            {user?.email ?? account.email}
          </p>
          <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-[var(--fs-line)] bg-white/[0.06] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--fs-text)]">
            <CirclePlay className="h-3 w-3" />
            {account.plan === "founder" ? "Founder Tier" : "Free Dev Access"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="flex items-center gap-2 rounded-full border border-[var(--fs-line)] px-3.5 py-2 text-xs font-semibold text-[var(--fs-text)] hover:bg-white/10"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </header>

      <div className="mt-8 space-y-6">
        {/* 01 · Account & Security */}
        <Section
          step="01"
          title="Account & Security"
          icon={<UserRound className="h-4 w-4" />}
        >
          <div className="border-b border-[var(--fs-line)] pb-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--fs-sub)]">
              Plan
            </p>
            <p className="mt-1 text-sm text-[var(--fs-text)]">
              {account.plan === "founder"
                ? "Founder Tier — renews " +
                  new Date(account.renewsAt).toLocaleDateString()
                : "Free Dev Access — upgrade for Founder benefits"}
            </p>
            <div className="mt-3">
              <Segmented<PlanTier>
                value={account.plan}
                onChange={setPlan}
                options={[
                  { value: "founder", label: "Founder Tier" },
                  { value: "dev", label: "Dev Access" },
                ]}
              />
            </div>
          </div>

          <div className="border-b border-[var(--fs-line)] py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-[var(--fs-text)]">
                  Two-factor authentication
                </p>
                <p className="mt-0.5 text-xs text-[var(--fs-sub)]">
                  {account.twoFactor
                    ? "Enabled — a code is requested at sign-in."
                    : "Add a second step to your local sign-in."}
                </p>
              </div>
              {!account.twoFactor && (
                <input
                  type="password"
                  value={twoFactorPassword}
                  onChange={event => setTwoFactorPassword(event.target.value)}
                  placeholder="Password"
                  className="w-36 rounded-md border border-[var(--fs-line)] bg-[var(--fs-elev)] px-3 py-2 text-xs text-[var(--fs-text)] outline-none placeholder:text-[var(--fs-sub)]"
                />
              )}
              <Toggle
                checked={account.twoFactor}
                onChange={value => void (value ? toggle2FA() : toggleTwoFactor(false, ""))}
                label=""
              />
            </div>
          </div>

          <div className="border-b border-[var(--fs-line)] py-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[var(--fs-sub)]" />
              <p className="text-sm font-semibold text-[var(--fs-text)]">
                Password
              </p>
              {!account.passwordHash && (
                <span className="text-[10px] text-[var(--fs-sub)]">
                  no password set yet
                </span>
              )}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={setCurrentPassword}
                placeholder={account.passwordHash ? "••••••••" : "—"}
              />
              <Field
                label="New password"
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                placeholder="8+ characters"
              />
              <Field
                label="Confirm new"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
            </div>
            <button
              type="button"
              onClick={() => void submitPassword()}
              disabled={savingPassword || !newPassword}
              className="mt-3 rounded-md bg-white px-4 py-2 text-xs font-bold text-black transition hover:bg-white/80 disabled:opacity-50"
            >
              {savingPassword ? "Saving…" : "Update password"}
            </button>
          </div>

          <div className="pt-4">
            <div className="flex items-center gap-2">
              <MonitorSmartphone className="h-4 w-4 text-[var(--fs-sub)]" />
              <p className="text-sm font-semibold text-[var(--fs-text)]">
                Active sessions
              </p>
            </div>
            <ul className="mt-3 space-y-2">
              {account.sessions.map(session => (
                <DeviceRow
                  key={session.id}
                  session={session}
                  onSignOut={() => {
                    signOutSession(session.id);
                    toast("Session signed out.");
                  }}
                />
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-4 text-[var(--fs-sub)]">
              Local demo — devices are stored on this machine, not a server.
            </p>
          </div>
        </Section>

        {/* 02 · Privacy & History */}
        <Section
          step="02"
          title="Viewing & Privacy"
          icon={<ShieldCheck className="h-4 w-4" />}
        >
          <div className="border-b border-[var(--fs-line)]">
            <Toggle
              checked={settings.historyEnabled}
              onChange={value => setSettings({ historyEnabled: value })}
              label="Record Watch History"
              description="Pause personalized tracking. Per-title progress and Continue Watching pause while the mindful counter keeps counting."
            />
          </div>

          <div className="py-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-[var(--fs-text)]">
                Continue Watching
              </p>
              {queue.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearHistory();
                    toast("Continue Watching cleared.");
                  }}
                  className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--fs-sub)] hover:text-[var(--fs-text)]"
                >
                  Clear all
                </button>
              )}
            </div>
            {queue.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--fs-sub)]">
                {settings.historyEnabled
                  ? "Nothing in progress yet — start a title and it lands here."
                  : "Watch history is paused, so this queue is empty."}
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {queue.map(item => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg border border-[var(--fs-line)] bg-[var(--fs-elev)] px-3 py-2"
                  >
                    <Poster src={item.poster} title={item.title} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--fs-text)]">
                        {item.title}
                      </p>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-white"
                          style={{ width: `${Math.min(100, item.fraction * 100)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[10px] tabular-nums text-[var(--fs-sub)]">
                        {Math.round(item.fraction * 100)}% watched
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromHistory(item.id)}
                      aria-label={`Remove ${item.title} from Continue Watching`}
                      className="grid h-7 w-7 place-items-center rounded-full text-[var(--fs-sub)] hover:bg-white/10 hover:text-[var(--fs-text)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-[var(--fs-line)] pt-4">
            <p className="text-sm font-semibold text-[var(--fs-text)]">
              Data & privacy
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={download}
                className="flex items-center gap-2 rounded-md border border-[var(--fs-line)] px-3.5 py-2 text-xs font-semibold text-[var(--fs-text)] hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" />
                Download my data
              </button>
              <button
                type="button"
                onClick={() => void deleteAccount()}
                className="flex items-center gap-2 rounded-md border border-white/20 px-3.5 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete account
              </button>
            </div>
          </div>
        </Section>

        {/* 03 · My Lists & Ratings */}
        <Section
          step="03"
          title="My Lists & Ratings"
          icon={<ListVideo className="h-4 w-4" />}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--fs-text)]">
              My List
            </p>
            <Segmented<ListTag | "all">
              value={listFilter}
              onChange={setListFilter}
              options={[
                { value: "all", label: "All" },
                ...LIST_TAGS.map(tag => ({ value: tag.value, label: tag.label })),
              ]}
            />
          </div>
          {list.length === 0 ? (
            <p className="mt-3 text-xs text-[var(--fs-sub)]">
              Save titles from the catalog to curate them here — each can carry a
              Plan to Watch, Favorites, or Watched tag.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {list.map(entry => (
                <li
                  key={entry.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--fs-line)] bg-[var(--fs-elev)] px-3 py-2"
                >
                  <Poster src={entry.poster} title={entry.title} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--fs-text)]">
                      {entry.title}
                      {entry.year ? (
                        <span className="ml-1.5 text-[var(--fs-sub)]">
                          {entry.year}
                        </span>
                      ) : null}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {LIST_TAGS.map(tag => (
                        <button
                          key={tag.value}
                          type="button"
                          onClick={() => setEntryTag(entry.id, tag.value)}
                          className={`rounded-full px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] transition ${
                            entry.tag === tag.value
                              ? "bg-white text-black"
                              : "border border-[var(--fs-line)] text-[var(--fs-sub)] hover:text-[var(--fs-text)]"
                          }`}
                        >
                          {tag.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFromList(entry.id)}
                    aria-label={`Remove ${entry.title} from My List`}
                    className="grid h-7 w-7 place-items-center rounded-full text-[var(--fs-sub)] hover:bg-white/10 hover:text-[var(--fs-text)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 border-t border-[var(--fs-line)] pt-4">
            <p className="text-sm font-semibold text-[var(--fs-text)]">
              Rating & review log
            </p>
            {ratings.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--fs-sub)]">
                Star a title from its details sheet and it appears here.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {ratings.map((rating: RatingEntry) => (
                  <li
                    key={rating.id}
                    className="flex items-center gap-3 rounded-lg border border-[var(--fs-line)] bg-[var(--fs-elev)] px-3 py-2"
                  >
                    <Poster src={rating.poster} title={rating.title} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--fs-text)]">
                        {rating.title}
                        {rating.year ? (
                          <span className="ml-1.5 text-[var(--fs-sub)]">
                            {rating.year}
                          </span>
                        ) : null}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <Stars value={rating.rating} />
                        <span className="text-[10px] tabular-nums text-[var(--fs-sub)]">
                          {new Date(rating.ratedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRating(rating.id)}
                      aria-label={`Remove rating for ${rating.title}`}
                      className="grid h-7 w-7 place-items-center rounded-full text-[var(--fs-sub)] hover:bg-white/10 hover:text-[var(--fs-text)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        {/* 04 · Activity & Gamification */}
        <Section
          step="04"
          title="Activity & Milestones"
          icon={<Clock3 className="h-4 w-4" />}
        >
          <div className="flex items-center gap-5">
            <svg viewBox="0 0 100 100" className="h-20 w-20 -rotate-90 shrink-0">
              <circle
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="7"
              />
              <circle
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC * (1 - (milestone?.fraction ?? 1))}
              />
            </svg>
            <div>
              <p className="text-3xl font-bold tabular-nums text-[var(--fs-text)]">
                {hours.toFixed(1)}
                <span className="ml-1 text-sm font-semibold text-[var(--fs-sub)]">
                  hours
                </span>
              </p>
              <p className="mt-0.5 text-xs text-[var(--fs-sub)]">
                {milestone
                  ? `To your next badge: ${(milestone.target / 3600).toFixed(0)}h`
                  : "All badges earned — truly immersed."}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--fs-sub)]">
              Today's cap
            </p>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-white transition-all"
                style={{ width: `${Math.min(100, (count / limit) * 100)}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-[var(--fs-text)]">
              {Math.min(count, limit)}/{limit}
            </span>
            {locked && <LockKeyhole className="h-3.5 w-3.5 text-[var(--fs-text)]" />}
          </div>

          <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--fs-sub)]">
            Achievements
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {ACHIEVEMENTS.map(achievement => {
              const isEarned = earnedIds.has(achievement.id);
              const Icon = achievement.icon;
              return (
                <div
                  key={achievement.id}
                  title={isEarned ? achievement.copy : achievement.hint}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 text-center ${
                    isEarned
                      ? "border-[var(--fs-line)] bg-white/[0.05]"
                      : "border-white/5 bg-black/20"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 place-items-center rounded-full ${
                      isEarned
                        ? "bg-white text-black"
                        : "bg-white/[0.06] text-white/30"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span
                    className={`text-[9px] leading-3 ${
                      isEarned ? "text-[var(--fs-text)]" : "text-white/30"
                    }`}
                  >
                    {achievement.title}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* 05 · Appearance & Playback */}
        <Section
          step="05"
          title="Appearance & Playback"
          icon={<Palette className="h-4 w-4" />}
        >
          <div className="border-b border-[var(--fs-line)] pb-4">
            <p className="text-sm font-semibold text-[var(--fs-text)]">
              Theme
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:max-w-md">
              {THEMES.map(theme => (
                <button
                  key={theme.value}
                  type="button"
                  onClick={() => setSettings({ theme: theme.value })}
                  aria-pressed={settings.theme === theme.value}
                  className={`rounded-lg border p-2.5 text-left transition ${
                    settings.theme === theme.value
                      ? "border-white/60 bg-white/[0.08]"
                      : "border-[var(--fs-line)] hover:bg-white/5"
                  }`}
                >
                  <span
                    className="block h-8 rounded border border-white/10"
                    style={{ background: theme.swatch }}
                  />
                  <span className="mt-2 block text-[10px] font-bold text-[var(--fs-text)]">
                    {theme.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="border-b border-[var(--fs-line)] py-4">
            <p className="text-sm font-semibold text-[var(--fs-text)]">
              Default playback quality
            </p>
            <p className="mt-0.5 text-xs text-[var(--fs-sub)]">
              The player starts at this tier when a title offers it.
            </p>
            <div className="mt-3">
              <Segmented<QualityPref>
                value={settings.quality}
                onChange={value => setSettings({ quality: value })}
                options={QUALITIES}
              />
            </div>
          </div>

          <div className="border-b border-[var(--fs-line)] py-4">
            <Toggle
              checked={settings.autoplayPreviews}
              onChange={value => setSettings({ autoplayPreviews: value })}
              label="Autoplay previews"
              description="Instantly plays a silent preview when a card is hovered."
            />
          </div>

          <div className="pt-4">
            <p className="text-sm font-semibold text-[var(--fs-text)]">
              Subtitle default
            </p>
            <div className="mt-3">
              <Segmented<SubtitlePref>
                value={settings.subtitles}
                onChange={value => setSettings({ subtitles: value })}
                options={SUBTITLE_OPTIONS}
              />
            </div>
          </div>
        </Section>
      </div>

      <footer className="mt-8 flex items-center justify-between">
        <p className="text-[10px] text-[var(--fs-sub)]">
          FreeStream — a mindful, ad-free streaming demo.
        </p>
        <SlidersHorizontal className="h-3.5 w-3.5 text-[var(--fs-sub)]" />
      </footer>
    </div>
  );
}

function DeviceRow({
  session,
  onSignOut,
}: {
  session: DeviceSession;
  onSignOut: () => void;
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border bg-[var(--fs-elev)] px-3 py-2.5 ${
        session.current ? "border-white/25" : "border-[var(--fs-line)]"
      }`}
    >
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-[var(--fs-text)]">
        <MonitorSmartphone className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--fs-text)]">
          {session.device}
          {session.current && (
            <span className="ml-2 rounded-full bg-white px-2 py-px text-[8px] font-bold uppercase tracking-[0.1em] text-black">
              This device
            </span>
          )}
        </p>
        <p className="text-[11px] text-[var(--fs-sub)]">
          {session.browser} · last active{" "}
          {new Date(session.lastActive).toLocaleDateString()}
        </p>
      </div>
      {!session.current && (
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-full border border-[var(--fs-line)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--fs-text)] hover:bg-white/10"
        >
          Sign out
        </button>
      )}
    </li>
  );
}