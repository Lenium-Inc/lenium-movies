import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { fetchTrending, type StreamMovie } from "@/services/api";
import { DEFAULT_POST_AUTH_PATH, nextPathFromSearch } from "@/lib/safeRedirect";
import { tmdbImage } from "@/lib/tmdbImages";
import { cn } from "@/lib/utils";

interface AuthPageProps {
  mode: "login" | "signup";
}

type FieldErrors = { name?: string; email?: string; password?: string };

function normalizeAuthError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    if (
      /failed to fetch|networkerror|network request failed|load failed/i.test(
        message
      )
    ) {
      return "We couldn't reach our servers. Check your connection and try again.";
    }
    return message;
  }
  return "Something went wrong. Try again.";
}

function validateField(
  field: keyof FieldErrors,
  value: { name: string; email: string; password: string }
): string | undefined {
  if (field === "name") {
    return value.name.trim().length === 0 ? "Enter your name" : undefined;
  }
  if (field === "email") {
    if (value.email.length === 0) return "Enter your email address";
    if (!/^\S+@\S+\.\S+$/.test(value.email)) {
      return "That email address doesn't look right";
    }
    return undefined;
  }
  if (value.password.length === 0) return "Enter your password";
  if (value.password.length < 8) {
    return "Passwords need at least 8 characters";
  }
  return undefined;
}

/** Frames of elapsed time at 24fps, written the way a projector counts them. */
function timecode(elapsedMs: number): string {
  const totalFrames = Math.floor((elapsedMs / 1000) * 24);
  const frames = totalFrames % 24;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * Sign-in and sign-up, set in the projection booth: the back of house where a
 * single warm lamp burns behind the gate. The auditorium (the rest of the app)
 * is cool and violet-lit; this is the one warm room, which is why the accent
 * here is a lamp rather than the app's violet.
 *
 * The form sits inside a gate frame — a hairline with registration marks, the
 * way a frame is aligned before a shot. Submitting runs an exposure: a band of
 * shadow crosses the lit button while a timecode runs and a rail fills, instead
 * of a spinner that says nothing about what is happening.
 */
export default function AuthPage({ mode }: AuthPageProps) {
  const { login, signup } = useAuth();
  const [location, navigate] = useLocation();

  // A share invite links here with `?next=/list/share/<token>` so the invite
  // survives the sign-in detour. The value is untrusted, so it is validated in
  // `safeRedirect` before it can influence where we navigate.
  const nextPath = useMemo(
    () => nextPathFromSearch(location.split("?")[1] ?? ""),
    [location]
  );
  const hasNext = nextPath !== DEFAULT_POST_AUTH_PATH;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const [code, setCode] = useState("00:00:00:00");

  const isSignup = mode === "signup";
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    let mounted = true;
    fetchTrending({ time_window: "week", media_type: "movie" })
      .then((items: StreamMovie[]) => {
        if (!mounted) return;
        const withArt = items.filter(i => i.backdrop_url);
        const pick = withArt[Math.floor(Math.random() * withArt.length)];
        if (pick?.backdrop_url) {
          // Re-point the size segment rather than trusting the stored url; the
          // backend bakes w1280 in, and the old `startsWith("http")` bail-out
          // meant the ambient backdrop was never actually requested at
          // `original`.
          setBackdrop(tmdbImage(pick.backdrop_url, "original"));
        }
      })
      .catch(() => {
        /* keep the lamp */
      });
    return () => {
      mounted = false;
    };
  }, []);

  // The timecode counts how long the reel has been running. It is the one
  // ambient element, and it is real information rather than ornament: it tells
  // you the page is alive and, on a slow connection, that time is passing.
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const id = window.setInterval(() => {
      setCode(timecode(Date.now() - startedAt.current));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate every field at once on submit — this is the net for anything the
    // per-field checks on blur have not caught yet.
    const nextErrors: FieldErrors = {};
    for (const field of (isSignup
      ? (["name", "email", "password"] as const)
      : (["email", "password"] as const))) {
      const message = validateField(field, { name, email, password });
      if (message) nextErrors[field] = message;
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Send focus to the first thing that needs attention.
      const first = (["name", "email", "password"] as const).find(
        f => nextErrors[f]
      );
      document.getElementById(`auth-${first}`)?.focus();
      return;
    }

    setSubmitting(true);
    try {
      if (isSignup) {
        await signup({ name: name.trim(), email, password });
      } else {
        await login({ email, password });
      }
      setDone(true);
      // Let the gate read as exposed before we cut away to the app.
      window.setTimeout(() => navigate(nextPath), 420);
    } catch (err) {
      setError(normalizeAuthError(err));
      setSubmitting(false);
    }
  };

  const checkField = (field: keyof FieldErrors) => {
    // Only correct a field that already complained, or that the user has
    // finished with — nagging at an untouched field is noise.
    const next = validateField(field, { name, email, password });
    setFieldErrors(prev => {
      const had = Boolean(prev[field]);
      if (!next && !had) return prev;
      if (next === prev[field]) return prev;
      return { ...prev, [field]: next };
    });
  };

  const swapHref = `${isSignup ? "/login" : "/signup"}${
    hasNext ? `?next=${encodeURIComponent(nextPath)}` : ""
  }`;

  // One definition for the field wrapper, so the padding, the type size and the
  // `ln-field` focus/invalid behaviour are stated once instead of three times.
  const fieldWrap = (delay?: string) =>
    cn(
      "ln-field ln-set px-3.5 py-2.5 text-[15px] text-white",
      "placeholder:text-white/35",
      delay
    );

  const submitLabel = submitting
    ? isSignup
      ? "Creating your account…"
      : "Signing you in…"
    : isSignup
      ? "Create account"
      : "Sign in";

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--booth-void)] text-white">
      {/* The film on the wall behind the booth, held well back so it reads as
          atmosphere and never competes with the form. */}
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-110 object-cover object-center opacity-[0.22] blur-2xl"
        />
      ) : null}
      {/* The lamp. A cold room with one warm source in it. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 62% 48% at 50% 4%, rgba(255,174,92,0.20), transparent 62%), radial-gradient(ellipse 90% 70% at 50% 106%, rgba(255,231,194,0.07), transparent 60%), linear-gradient(180deg, #0d0d10 0%, #08080a 46%, #08080a 100%)",
        }}
      />

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-5 py-14">
        <div className="w-full max-w-[25.5rem]">
          {/* Reel position: the technical voice, and the only small type here. */}
          <div className="mb-5 flex items-center justify-between font-tech text-[10px] tracking-[0.2em] text-[var(--booth-dust)] uppercase">
            <span>{isSignup ? "Enrol" : "Return"}</span>
            <span aria-hidden>{code}</span>
          </div>

          <header className="mb-7">
            <h1 className="font-display text-[2.05rem] leading-[1.12] tracking-[-0.015em] text-white">
              {isSignup ? (
                <>
                  Create your <em className="italic text-[var(--lamp)]">account</em>
                </>
              ) : (
                <>
                  Welcome <em className="italic text-[var(--lamp)]">back</em>
                </>
              )}
            </h1>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-[var(--booth-dust)]">
              {isSignup
                ? "One account for your list, your history and your downloads."
                : "Sign in to pick up where you left off."}
            </p>
          </header>

          <div className="ln-gate relative rounded-2xl border border-white/[0.07] bg-[var(--booth-carbon)]/80 p-6 shadow-[0_28px_80px_-28px_rgba(0,0,0,0.9)] backdrop-blur-xl sm:p-7">
            <form onSubmit={handleSubmit} noValidate>
              {/*
                Honeypot: a real label tied to a real input, moved off-screen
                rather than hidden with CSS, so it stays in the accessibility
                tree's shadow but is unreachable by keyboard, pointer and
                autofill. Naive bots fill every field they find; people cannot
                see or complete it. Server-side it only ever adds a small,
                decaying amount of evidence.
              */}
              <div
                className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
                aria-hidden="true"
              >
                <label htmlFor="sv-website">Website</label>
                <input
                  id="sv-website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  defaultValue=""
                />
              </div>

              <div className="space-y-4">
                {isSignup && (
                  <Field
                    id="auth-name"
                    label="Display name"
                    error={fieldErrors.name}
                    className={fieldWrap()}
                  >
                    <input
                      id="auth-name"
                      name="name"
                      type="text"
                      value={name}
                      onChange={e => {
                        setName(e.target.value);
                        if (fieldErrors.name) checkField("name");
                      }}
                      onBlur={() => checkField("name")}
                      placeholder="What should we call you?"
                      autoComplete="name"
                      autoFocus
                      maxLength={40}
                      aria-invalid={Boolean(fieldErrors.name)}
                      aria-describedby={
                        fieldErrors.name ? "auth-name-err" : undefined
                      }
                      className="w-full bg-transparent outline-none"
                    />
                  </Field>
                )}

                <Field
                  id="auth-email"
                  label="Email"
                  error={fieldErrors.email}
                  className={fieldWrap(isSignup ? "animation-delay-[60ms]" : undefined)}
                >
                  <input
                    id="auth-email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={e => {
                      setEmail(e.target.value);
                      if (fieldErrors.email) checkField("email");
                    }}
                    onBlur={() => checkField("email")}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus={!isSignup}
                    maxLength={254}
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={
                      fieldErrors.email ? "auth-email-err" : undefined
                    }
                    className="w-full bg-transparent outline-none"
                  />
                </Field>

                <Field
                  id="auth-password"
                  label="Password"
                  hint={isSignup ? "8 characters or more" : undefined}
                  error={fieldErrors.password}
                  className={fieldWrap(
                    isSignup
                      ? "animation-delay-[120ms]"
                      : "animation-delay-[60ms]"
                  )}
                >
                  <input
                    id="auth-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={e => {
                      setPassword(e.target.value);
                      if (fieldErrors.password) checkField("password");
                    }}
                    onBlur={() => checkField("password")}
                    placeholder={isSignup ? "8 characters or more" : "Your password"}
                    autoComplete={isSignup ? "new-password" : "current-password"}
                    maxLength={128}
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={
                      fieldErrors.password ? "auth-password-err" : undefined
                    }
                    className="w-full bg-transparent pr-10 outline-none"
                  />
                  {/* People mistype passwords; making them verify by eye is the
                      difference between a form that works and one that doesn't. */}
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1.5 text-white/35 transition-colors hover:text-[var(--lamp)] focus-visible:outline-2 focus-visible:outline-[var(--lamp)] focus-visible:outline-offset-1"
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" aria-hidden />
                    ) : (
                      <Eye className="size-4" aria-hidden />
                    )}
                  </button>
                </Field>
              </div>

              {error && (
                <p
                  role="alert"
                  className="mt-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[13px] leading-snug text-rose-200"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                data-state={submitting ? "running" : "idle"}
                className={cn(
                  "ln-expose relative mt-5 w-full overflow-hidden rounded-lg px-4 py-3",
                  "text-[14px] font-semibold transition-colors duration-200",
                  "disabled:cursor-progress",
                  done
                    ? "bg-[var(--signal)] text-[#04120c]"
                    : submitting
                      ? "bg-[var(--lamp)] text-[#1a1206]"
                      : "border border-[var(--lamp)]/45 bg-transparent text-[var(--lamp)] hover:border-[var(--lamp)] hover:bg-[var(--lamp)]/10"
                )}
              >
                <span className="relative z-10">{done ? "You're in" : submitLabel}</span>
              </button>

              {/* The rail fills for as long as the request takes. */}
              <div
                aria-hidden
                className={cn(
                  "mt-2.5 h-px w-full overflow-hidden bg-white/8",
                  (submitting || done) && "visible"
                )}
              >
                <div
                  className={cn(
                    "h-full w-full bg-[var(--lamp)]",
                    (submitting || done) && "ln-rail"
                  )}
                />
              </div>
            </form>

            <p className="mt-6 text-center text-[13.5px] text-[var(--booth-dust)]">
              {isSignup ? "Already have an account?" : "New to Stream Vy?"}{" "}
              <Link
                href={swapHref}
                className="font-semibold text-[var(--lamp)] underline-offset-4 transition hover:underline"
              >
                {isSignup ? "Sign in" : "Create an account"}
              </Link>
            </p>
          </div>

          <Link
            href="/"
            className="mt-7 inline-flex items-center gap-1.5 font-tech text-[10.5px] tracking-[0.16em] text-white/50 uppercase transition-colors hover:text-white/85"
          >
            <ArrowLeft className="size-3" aria-hidden />
            Browse instead
          </Link>
        </div>
      </div>
    </div>
  );
}

/** A label, the control it names, and that control's error — one job each. */
function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: "auth-name" | "auth-email" | "auth-password";
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[12.5px] font-medium text-white/72">
          {label}
        </label>
        {hint && (
          <span className="font-tech text-[10px] tracking-wider text-white/50 uppercase">
            {hint}
          </span>
        )}
      </div>
      {/* The box is the label, not just the text above it, so the whole 45px
          target focuses the input instead of only the 23px of bare input. */}
      <label
        htmlFor={id}
        className={cn("block cursor-text", className)}
        data-invalid={Boolean(error) || undefined}
      >
        {children}
      </label>
      {/* Each message sits with the field it belongs to, and is reached from
          that field via aria-describedby, so it needs no live region of its
          own. The words say what to do, not what went wrong internally. */}
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-[12.5px] leading-snug text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
