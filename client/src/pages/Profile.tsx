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
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useLocalSession } from "@/context/LocalSessionContext";
import {
  getSettings,
  setSettings,
  subscribeSettings,
  type QualityPref,
  type SubtitlePref,
  type ThemeMode,
} from "@/services/settings";
import {
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
import { getMovieKey, removeFromMyList } from "@/lib/localSession";

const RADIUS = 30;
const CIRC = 2 * Math.PI * RADIUS;

type TabId = "overview" | "preferences" | "data";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: Bookmark },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "data", label: "Data & Privacy", icon: Eye },
];

function useRevision(): void {
  const [, setRev] = useState(0);
  useEffect(() => {
    const unsubs: Array<() => void> = [
      subscribeSettings(() => setRev(r => r + 1)),
      subscribeList(() => setRev(r => r + 1)),
      subscribeRatings(() => setRev(r => r + 1)),
      subscribeStats(() => setRev(r => r + 1)),
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);
}

function formatRenewal(iso: string): string {
  const date = new Date(iso);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

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
          <p className="mt-0.5 text-xs leading-5 text-zinc-400">
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
          className={`rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-wider transition ${
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

function Poster({ src, title }: { src: string | null; title: string }) {
  return src ? (
    <img src={src} alt="" className="h-14 w-10 shrink-0 rounded object-cover" />
  ) : (
    <span className="grid h-14 w-10 shrink-0 place-items-center rounded bg-zinc-800 text-sm font-black text-zinc-500">
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
  const { user, isAuthenticated, signOut: logout, getMyList, getHistory } = useLocalSession();
  const settings = getSettings();
  const [tab, setTab] = useState<TabId>("overview");
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

  const displayName = user?.displayName ?? "Viewer";
  const email = user?.email ?? "viewer@freestream.app";

  const download = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings: getSettings(),
      hoursWatched: hoursWatched(),
      playsToday: (count as number),
      achievements: earnedAchievements().map(a => a.id),
      myList: getMyList().map(m => getMovieKey(m)),
      ratings: ratingLog(),
      historyEnabled: getSettings().historyEnabled,
    };
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

  const clearAllData = async () => {
    const ok = window.confirm(
      "Permanently delete your FreeStream profile, viewing history, ratings, and saved list on this device? This can't be undone."
    );
    if (!ok) return;
    clearHistory();
    localStorage.removeItem("freestream-list-v1");
    localStorage.removeItem("freestream-ratings-v1");
    localStorage.removeItem("freestream-stats-v1");
    localStorage.removeItem("freestream-prefs-v1");
    localStorage.removeItem("freestream-session-v1");
    window.dispatchEvent(new CustomEvent("freestream:data-wiped"));
    window.location.href = "/";
  };

  const myListCount = getMyList().length;
  const historyCount = getHistory().length;

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
      <span className="min-w-0">{t.label}</span>
    </button>
  );

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] text-zinc-200">
        <header className="border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6 lg:px-8">
            <div className="flex items-center gap-4">
              <div className="relative shrink-0">
                <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-xl font-black text-white ring-1 ring-inset ring-white/20">
                  V
                </span>
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-white">Profile</h1>
                <p className="mt-0.5 truncate text-sm text-zinc-500">Not signed in</p>
              </div>
            </div>
          </div>
        </header>
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          <Card className="max-w-md mx-auto">
            <CardHeader
              icon={UserRound}
              title="Sign in to continue"
              description="Access your saved list, watch history, and preferences."
            />
            <Body>
              <div className="text-center py-4">
                <p className="text-zinc-400 mb-4">
                  This is a local demo. Your data stays in this browser.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const { signInDemo } = useLocalSession();
                    signInDemo();
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500"
                >
                  Continue as Viewer
                </button>
              </div>
            </Body>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-zinc-200">
      <header className="border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
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
                  <span className="text-[9px] font-bold">Local demo profile</span>
                </span>
              </div>
              <p className="mt-0.5 truncate text-sm text-zinc-500">{email}</p>
            </div>
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

      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
          <nav className="hidden lg:block">
            <div className="sticky top-8 space-y-1">
              <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
                Settings
              </p>
              {TABS.map(t => navButton(t, tab === t.id))}
            </div>
          </nav>

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
                {t.label}
              </button>
            ))}
          </nav>

          <main className="min-w-0 space-y-6">
            {tab === "overview" && (
              <>
                <Card>
                  <CardHeader
                    icon={Bookmark}
                    title="My Library"
                    description="Saved titles and watch history summary."
                  />
                  <Body>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 p-4">
                        <p className="text-3xl font-bold text-white">{myListCount}</p>
                        <p className="text-sm text-zinc-400">Saved Titles</p>
                      </div>
                      <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 p-4">
                        <p className="text-3xl font-bold text-white">{historyCount}</p>
                        <p className="text-sm text-zinc-400">Watch History</p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setTab("preferences")}
                        className={outlineBtn}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        Preferences
                      </button>
                      <button
                        type="button"
                        onClick={() => setTab("data")}
                        className={outlineBtn}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Data & Privacy
                      </button>
                    </div>
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Clock3}
                    title="Total Immersion"
                    description="Time absorbed in the mindful cinema."
                  />
                  <Body>
                    <div className="flex items-center gap-5">
                      <svg
                        viewBox="0 0 100 100"
                        className="h-20 w-20 -rotate-90 shrink-0"
                      >
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
                          strokeDashoffset={
                            CIRC * (1 - (milestone?.fraction ?? 1))
                          }
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
                        <span className="ml-1 text-lg text-zinc-500">
                          / {limit}
                        </span>
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
                            title={
                              isEarned ? achievement.copy : achievement.hint
                            }
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

            {tab === "preferences" && (
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
                      onChange={value =>
                        setSettings({ autoplayPreviews: value })
                      }
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

                <Card>
                  <CardHeader
                    icon={Eye}
                    title="Record Watch History"
                    description="Control how FreeStream tracks your viewing."
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
              </>
            )}

            {tab === "data" && (
              <>
                <Card>
                  <CardHeader
                    icon={Download}
                    title="Export your data"
                    description="Download a JSON file with your preferences, list, ratings, and stats."
                  />
                  <Body>
                    <button
                      type="button"
                      onClick={download}
                      className={outlineBtn}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download my data
                    </button>
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Trash2}
                    title="Clear watch history"
                    description="Remove all Continue Watching entries and progress."
                  />
                  <Body>
                    <button
                      type="button"
                      onClick={() => {
                        clearHistory();
                        toast("Watch history cleared.");
                      }}
                      className={dangerBtn}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear watch history
                    </button>
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Bookmark}
                    title="Clear My List"
                    description="Remove all saved titles from your list."
                  />
                  <Body>
                    <button
                      type="button"
                      onClick={() => {
                        localStorage.removeItem("freestream-list-v1");
                        window.dispatchEvent(new CustomEvent("freestream:list"));
                        toast("My List cleared.");
                      }}
                      className={dangerBtn}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear My List
                    </button>
                  </Body>
                </Card>

                <Card>
                  <CardHeader
                    icon={Trash2}
                    title="Clear all local data"
                    description="Permanently delete your profile, list, history, ratings, and preferences from this browser."
                  />
                  <Body>
                    <button
                      type="button"
                      onClick={clearAllData}
                      className={dangerBtn}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete all local data
                    </button>
                    <p className="mt-2 text-[10px] text-zinc-600">
                      This action cannot be undone. Your data is stored only in this browser.
                    </p>
                  </Body>
                </Card>
              </>
            )}

            <footer className="flex items-center justify-between pt-2">
              <p className="text-[10px] text-zinc-600">
                FreeStream — a mindful, ad-free streaming demo. Local demo profile — data stored in this browser only.
              </p>
              <SlidersHorizontal className="h-3.5 w-3.5 text-zinc-700" />
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

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