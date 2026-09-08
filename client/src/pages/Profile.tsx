import { useEffect, useState, type ReactNode } from "react";
import {
  Award,
  Bookmark,
  Clock3,
  Download,
  Eye,
  Gauge,
  KeyRound,
  LockKeyhole,
  LogOut,
  MonitorSmartphone,
  Play,
  Ribbon,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Subtitles,
  Trash2,
  X,
  type LucideIcon,
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

type TabId = "account" | "privacy" | "lists" | "activity" | "appearance";

const TABS: { id: TabId; step: string; label: string; icon: LucideIcon }[] = [
  { id: "account", step: "01", label: "Account & Security", icon: Shield },
  { id: "privacy", step: "02", label: "Viewing & Privacy", icon: Eye },
  { id: "lists", step: "03", label: "My Lists & Ratings", icon: Bookmark },
  { id: "activity", step: "04", label: "Activity & Milestones", icon: Award },
  {
    id: "appearance",
    step: "05",
    label: "Appearance & Playback",
    icon: SlidersHorizontal,
  },
];

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

/** dd/mm/yyyy — shown in the subscription card. */
function formatRenewal(iso: string): string {
  const date = new Date(iso);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/* ---------------------------------- atoms --------------------------------- */

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-sm ${className}`}
    >
      {children}
    </section>
  );
}

function CardHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const Icon = icon;
  return (
    <header className="flex items-start justify-between gap-3 border-b border-zinc-800/70 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-zinc-700/60 bg-zinc-950/60 text-indigo-400">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-zinc-100">{title}</h2>
          {description && (
            <p className="mt-0.5 text-[11px] leading-5 text-zinc-400">
              {description}
            </p>
          )}
        </div>
      </div>
      {action}
    </header>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-zinc-100">{label}</p>
        {description && (
          <p className="mt-0.5 text-xs leading-5 text-zinc-400">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-indigo-600" : "bg-zinc-700/60"
        }`}
        aria-label={label}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[calc(100%-1.25rem)]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
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
              ? "bg-indigo-600 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.12)]"
              : "border border-zinc-700/60 text-zinc-300 hover:border-zinc-500 hover:bg-white/5"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
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
      <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
        {label}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-md border border-zinc-700/60 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-600/30"
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
              ? "fill-indigo-400 text-indigo-400"
              : "text-zinc-700"
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
    <span className="grid h-14 w-10 shrink-0 place-items-center rounded bg-zinc-800 text-sm font-black text-zinc-500">
      {title.charAt(0).toUpperCase()}
    </span>
  );
}

/* --------------------------------- options -------------------------------- */

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

/* ---------------------------------- page ---------------------------------- */

export default function Profile() {
  useRevision();
  const { user, logout } = useAuth();
  const account = getAccount();
  const settings = getSettings();
  const [tab, setTab] = useState<TabId>("account");
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

  const displayName = (user?.name ?? account.displayName) || "Viewer";
  const email = user?.email ?? account.email;

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

  const primaryBtn =
    "inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50";
  const outlineBtn =
    "inline-flex items-center gap-2 rounded-lg border border-zinc-700/60 px-3.5 py-2 text-xs font-semibold text-zinc-200 transition hover:border-zinc-500 hover:bg-white/5";
  const dangerBtn =
    "inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3.5 py-2 text-xs font-semibold text-red-300 transition hover:border-red-500/60 hover:bg-red-500/10";

  const navButton = (t: (typeof TABS)[number], active: boolean) => (
    <button
      key={t.id}
      type="button"
      onClick={() => setTab(t.id)}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-semibold transition ${
        active
          ? "bg-indigo-600/15 text-white ring-1 ring-inset ring-indigo-500/40"
          : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
      }`}
    >
      <span
        className={`grid h-7 w-7 place-items-center rounded-md ${
          active ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-500"
        }`}
      >
        <t.icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="mr-1 text-[9px] font-bold tracking-[0.15em] text-zinc-500">
          {t.step}
        </span>
        {t.label}
      </span>
    </button>
  );

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-zinc-200">
      {/* ---------- banner ---------- */}
      <header className="border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-6 sm:px-6 lg:px-8">
          <div className="relative shrink-0">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-xl font-black text-white ring-1 ring-inset ring-white/20">
              {displayName.charAt(0).toUpperCase()}
            </span>
            <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border-2 border-zinc-950 bg-emerald-500">
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-white">
                {displayName}
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-600/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-indigo-300">
                <Ribbon className="h-3 w-3" />
                {account.plan === "founder"
                  ? "Founder Tier — Dev Access"
                  : "Dev Access"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-sm text-zinc-500">{email}</p>
          </div>

          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700/70 px-3.5 py-2 text-xs font-semibold text-zinc-300 transition hover:border-zinc-500 hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign Out
          </button>
        </div>
      </header>

      {/* ---------- body ---------- */}
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
          {/* sidebar — desktop */}
          <nav className="hidden lg:block">
            <div className="sticky top-8 space-y-1">
              <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
                Settings
              </p>
              {TABS.map(t => navButton(t, tab === t.id))}
            </div>
          </nav>

          {/* tabs — mobile */}
          <nav className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                  tab === t.id
                    ? "bg-indigo-600 text-white"
                    : "border border-zinc-800 bg-zinc-900/70 text-zinc-400"
                }`}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.step} {t.label}
              </button>
            ))}
          </nav>

          {/* main content */}
          <main className="min-w-0 space-y-6">
            {tab === "account" && (
              <>
                {/* subscription status */}
                <Card>
                  <CardHeader
                    icon={Ribbon}
                    title="Subscription"
                    description="Your founder access and renewal status."
                  />
                  <Body>
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-lg font-bold text-white">
                          {account.plan === "founder"
                            ? "Founder Tier"
                            : "Dev Access"}
                        </p>
                        <p className="mt-0.5 text-sm text-zinc-400">
                          Renews {formatRenewal(account.renewsAt)}
                        </p>
                        {account.plan === "founder" && (
                          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-indigo-600/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-indigo-300 ring-1 ring-inset ring-indigo-500/30">
                            <ShieldCheck className="h-3 w-3" />
                            Active
                          </span>
                        )}
                      </div>
                      <div>
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                          Plan tier
                        </p>
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
                  </Body>
                </Card>

                {/* two-factor */}
                <Card>
                  <CardHeader
                    icon={ShieldCheck}
                    title="Two-factor authentication"
                    description="Add a second step at sign-in to protect your account."
                    action={
                      <button
                        type="button"
                        onClick={() => void toggle2FA()}
                        disabled={!account.twoFactor && !account.passwordHash && !twoFactorPassword}
                        className={
                          account.twoFactor
                            ? outlineBtn
                            : `${primaryBtn} disabled:opacity-40`
                        }
                      >
                        {account.twoFactor ? "Disable 2FA" : "Enable 2FA"}
                      </button>
                    }
                  />
                  <Body>
                    <p className="text-sm text-zinc-300">
                      {account.twoFactor
                        ? "Enabled — a code is requested at every sign-in."
                        : "Not enabled yet. Set a password below, then confirm it to turn 2FA on."}
                    </p>
                    {!account.twoFactor && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <input
                          type="password"
                          value={twoFactorPassword}
                          onChange={event => setTwoFactorPassword(event.target.value)}
                          placeholder="Confirm password"
                          className="w-44 rounded-md border border-zinc-700/60 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-600/30"
                        />
                        <span className="text-[10px] text-zinc-600">
                          Required to enable.
                        </span>
                      </div>
                    )}
                  </Body>
                </Card>

                {/* password */}
                <Card>
                  <CardHeader
                    icon={KeyRound}
                    title="Password"
                    description="Choose a strong passphrase you won't reuse elsewhere."
                    action={
                      !account.passwordHash ? (
                        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400">
                          Not set
                        </span>
                      ) : undefined
                    }
                  />
                  <Body>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field
                        label="Current"
                        type="password"
                        value={currentPassword}
                        onChange={setCurrentPassword}
                        placeholder={account.passwordHash ? "••••••••" : "—"}
                      />
                      <Field
                        label="New"
                        type="password"
                        value={newPassword}
                        onChange={setNewPassword}
                        placeholder="8+ characters"
                      />
                      <Field
                        label="Confirm"
                        type="password"
                        value={confirmPassword}
                        onChange={setConfirmPassword}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void submitPassword()}
                      disabled={savingPassword || !newPassword}
                      className={`${primaryBtn} mt-4`}
                    >
                      {savingPassword ? "Saving…" : "Update password"}
                    </button>
                  </Body>
                </Card>

                {/* active sessions */}
                <Card>
                  <CardHeader
                    icon={MonitorSmartphone}
                    title="Active sessions"
                    description="Devices currently signed in to FreeStream."
                  />
                  <Body>
                    <ul className="space-y-2">
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
                    <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                      Local demo — devices are stored on this machine, not a server.
                    </p>
                  </Body>
                </Card>
              </>
            )}

            {tab === "privacy" && (
              <>
                <Card>
                  <CardHeader
                    icon={Eye}
                    title="Record Watch History"
                    description="Control how FreeStream tracks your viewing."
                    action={
                      <SettingsPill
                        on={settings.historyEnabled}
                        onLabel="Recording"
                        offLabel="Paused"
                      />
                    }
                  />
                  <Body>
                    <Toggle
                      checked={settings.historyEnabled}
                      onChange={value => setSettings({ historyEnabled: value })}
                      label="Record Watch History"
                      description="Pause personalized tracking. Per-title progress and Continue Watching pause while the mindful counter keeps counting."
                    />
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Play}
                    title="Continue Watching"
                    description="Jump back into titles you've started."
                    action={
                      queue.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            clearHistory();
                            toast("Continue Watching cleared.");
                          }}
                          className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500 transition hover:text-zinc-200"
                        >
                          Clear all
                        </button>
                      ) : undefined
                    }
                  />
                  <Body>
                    {queue.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-10 text-center">
                        <span className="grid h-12 w-12 place-items-center rounded-full bg-zinc-800/70 text-zinc-600">
                          <Eye className="h-5 w-5" />
                        </span>
                        <p className="mt-3 text-sm font-semibold text-zinc-300">
                          Nothing in progress
                        </p>
                        <p className="mt-1 max-w-xs text-xs leading-5 text-zinc-500">
                          {settings.historyEnabled
                            ? "Start a title and it lands here so you can pick up where you left off."
                            : "Watch history is paused, so this queue stays empty."}
                        </p>
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {queue.map(item => (
                          <li
                            key={item.id}
                            className="flex items-center gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-2"
                          >
                            <Poster src={item.poster} title={item.title} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-100">
                                {item.title}
                              </p>
                              <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
                                <div
                                  className="h-full rounded-full bg-indigo-500"
                                  style={{
                                    width: `${Math.min(100, item.fraction * 100)}%`,
                                  }}
                                />
                              </div>
                              <p className="mt-1 text-[10px] tabular-nums text-zinc-500">
                                {Math.round(item.fraction * 100)}% watched
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeFromHistory(item.id)}
                              aria-label={`Remove ${item.title} from Continue Watching`}
                              className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Download}
                    title="Data & privacy"
                    description="Take your data with you, or remove it entirely."
                  />
                  <Body>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={download} className={outlineBtn}>
                        <Download className="h-3.5 w-3.5" />
                        Download my data
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteAccount()}
                        className={dangerBtn}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete account
                      </button>
                    </div>
                  </Body>
                </Card>
              </>
            )}

            {tab === "lists" && (
              <>
                <Card>
                  <CardHeader
                    icon={Bookmark}
                    title="My Lists & Ratings"
                    description="Curate your watchlist and see what you've rated."
                    action={
                      <Segmented<ListTag | "all">
                        value={listFilter}
                        onChange={setListFilter}
                        options={[
                          { value: "all", label: "All" },
                          ...LIST_TAGS.map(tag => ({
                            value: tag.value,
                            label: tag.label,
                          })),
                        ]}
                      />
                    }
                  />
                  <Body>
                    {list.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-8 text-center">
                        <p className="text-sm font-semibold text-zinc-300">
                          No saved titles yet
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Save titles from the catalog — each can carry a Plan to
                          Watch, Favorites, or Watched tag.
                        </p>
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {list.map(entry => (
                          <li
                            key={entry.id}
                            className="flex items-center gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-2"
                          >
                            <Poster src={entry.poster} title={entry.title} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-100">
                                {entry.title}
                                {entry.year ? (
                                  <span className="ml-1.5 text-zinc-500">
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
                                        ? "bg-indigo-600 text-white"
                                        : "border border-zinc-800 text-zinc-500 hover:text-zinc-200"
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
                              className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Star}
                    title="Rating & review log"
                    description="Stars you've given titles from their details sheet."
                  />
                  <Body>
                    {ratings.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-8 text-center">
                        <p className="text-sm font-semibold text-zinc-300">
                          No ratings yet
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Star a title after watching 15 minutes and it shows up here.
                        </p>
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {ratings.map((rating: RatingEntry) => (
                          <li
                            key={rating.id}
                            className="flex items-center gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-2"
                          >
                            <Poster src={rating.poster} title={rating.title} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-100">
                                {rating.title}
                                {rating.year ? (
                                  <span className="ml-1.5 text-zinc-500">
                                    {rating.year}
                                  </span>
                                ) : null}
                              </p>
                              <div className="mt-1 flex items-center gap-2">
                                <Stars value={rating.rating} />
                                <span className="text-[10px] tabular-nums text-zinc-500">
                                  {new Date(rating.ratedAt).toLocaleDateString()}
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeRating(rating.id)}
                              aria-label={`Remove rating for ${rating.title}`}
                              className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Body>
                </Card>
              </>
            )}

            {tab === "activity" && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Card>
                    <CardHeader
                      icon={Clock3}
                      title="Total Immersion"
                      description="Time absorbed in the mindful cinema."
                    />
                    <Body>
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
                            stroke="#6366f1"
                            strokeWidth="7"
                            strokeLinecap="round"
                            strokeDasharray={CIRC}
                            strokeDashoffset={CIRC * (1 - (milestone?.fraction ?? 1))}
                          />
                        </svg>
                        <div>
                          <p className="text-3xl font-bold tabular-nums text-white">
                            {hours.toFixed(1)}
                            <span className="ml-1 text-sm font-semibold text-zinc-500">
                              hours
                            </span>
                          </p>
                          <p className="mt-0.5 text-xs text-zinc-500">
                            {milestone
                              ? `To your next badge: ${(milestone.target / 3600).toFixed(0)}h`
                              : "All badges earned — truly immersed."}
                          </p>
                        </div>
                      </div>
                    </Body>
                  </Card>

                  <Card>
                    <CardHeader
                      icon={Gauge}
                      title="Today's Cap"
                      description="Plays toward your mindful daily limit."
                    />
                    <Body>
                      <div className="flex items-baseline gap-2">
                        <p className="text-3xl font-bold tabular-nums text-white">
                          {Math.min(count, limit)}
                          <span className="ml-1 text-lg text-zinc-500">/ {limit}</span>
                        </p>
                        {locked && (
                          <LockKeyhole className="h-4 w-4 text-red-400" />
                        )}
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className={`h-full rounded-full transition-all ${
                            locked ? "bg-red-500" : "bg-indigo-500"
                          }`}
                          style={{
                            width: `${Math.min(100, (count / limit) * 100)}%`,
                          }}
                        />
                      </div>
                      <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                        {locked
                          ? "Limit reached — see you tomorrow"
                          : `${limit - count} plays remaining today`}
                      </p>
                    </Body>
                  </Card>
                </div>

                <Card>
                  <CardHeader
                    icon={Award}
                    title="Achievements"
                    description="Milestones earned by watching with intention."
                  />
                  <Body>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                      {ACHIEVEMENTS.map(achievement => {
                        const isEarned = earnedIds.has(achievement.id);
                        const Icon = achievement.icon;
                        return (
                          <div
                            key={achievement.id}
                            title={isEarned ? achievement.copy : achievement.hint}
                            className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 text-center transition ${
                              isEarned
                                ? "border-indigo-500/30 bg-indigo-600/10"
                                : "border-zinc-800/70 bg-zinc-950/40"
                            }`}
                          >
                            <span
                              className={`grid h-9 w-9 place-items-center rounded-full ${
                                isEarned
                                  ? "bg-indigo-600 text-white"
                                  : "bg-zinc-800/80 text-zinc-600"
                              }`}
                            >
                              <Icon className="h-4 w-4" />
                            </span>
                            <span
                              className={`text-[9px] leading-3 ${
                                isEarned ? "text-zinc-200" : "text-zinc-600"
                              }`}
                            >
                              {achievement.title}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </Body>
                </Card>
              </>
            )}

            {tab === "appearance" && (
              <>
                <Card>
                  <CardHeader
                    icon={SlidersHorizontal}
                    title="Theme"
                    description="The palette painted across the whole app shell."
                  />
                  <Body>
                    <div className="grid grid-cols-3 gap-2 sm:max-w-md">
                      {THEMES.map(theme => (
                        <button
                          key={theme.value}
                          type="button"
                          onClick={() => setSettings({ theme: theme.value })}
                          aria-pressed={settings.theme === theme.value}
                          className={`rounded-lg border p-2.5 text-left transition ${
                            settings.theme === theme.value
                              ? "border-indigo-500/60 bg-indigo-600/10 ring-1 ring-inset ring-indigo-500/40"
                              : "border-zinc-800/70 hover:bg-white/5"
                          }`}
                        >
                          <span
                            className="block h-8 rounded border border-white/10"
                            style={{ background: theme.swatch }}
                          />
                          <span className="mt-2 block text-[10px] font-bold text-zinc-200">
                            {theme.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Gauge}
                    title="Default playback quality"
                    description="The player starts at this tier when a title offers it."
                  />
                  <Body>
                    <Segmented<QualityPref>
                      value={settings.quality}
                      onChange={value => setSettings({ quality: value })}
                      options={QUALITIES}
                    />
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Play}
                    title="Previews"
                    description="Motion on the shelves."
                  />
                  <Body>
                    <Toggle
                      checked={settings.autoplayPreviews}
                      onChange={value => setSettings({ autoplayPreviews: value })}
                      label="Autoplay previews"
                      description="Instantly plays a silent preview when a card is hovered."
                    />
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Subtitles}
                    title="Subtitle default"
                    description="How captions behave for new titles."
                  />
                  <Body>
                    <Segmented<SubtitlePref>
                      value={settings.subtitles}
                      onChange={value => setSettings({ subtitles: value })}
                      options={SUBTITLE_OPTIONS}
                    />
                  </Body>
                </Card>
              </>
            )}

            <footer className="flex items-center justify-between pt-2">
              <p className="text-[10px] text-zinc-600">
                FreeStream — a mindful, ad-free streaming demo.
              </p>
              <SlidersHorizontal className="h-3.5 w-3.5 text-zinc-700" />
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ sub-components ---------------------------- */

function SettingsPill({
  on,
  onLabel,
  offLabel,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ring-1 ring-inset ${
        on
          ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/30"
          : "bg-zinc-800 text-zinc-500 ring-zinc-700/50"
      }`}
    >
      {on ? onLabel : offLabel}
    </span>
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
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
        session.current
          ? "border-indigo-500/40 bg-indigo-600/[0.06]"
          : "border-zinc-800/70 bg-zinc-950/50"
      }`}
    >
      <span
        className={`grid h-8 w-8 place-items-center rounded-full ${
          session.current
            ? "bg-indigo-600 text-white"
            : "bg-zinc-800 text-zinc-400"
        }`}
      >
        <MonitorSmartphone className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-zinc-100">
          {session.device}
          {session.current && (
            <span className="ml-2 rounded-full bg-indigo-600 px-2 py-px text-[8px] font-bold uppercase tracking-[0.1em] text-white">
              This device
            </span>
          )}
        </p>
        <p className="text-[11px] text-zinc-500">
          {session.browser} · last active{" "}
          {new Date(session.lastActive).toLocaleDateString()}
        </p>
      </div>
      {!session.current && (
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-full border border-zinc-700/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-300 transition hover:border-zinc-500 hover:bg-white/5"
        >
          Sign out
        </button>
      )}
    </li>
  );
}