import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { Link, useLocation } from "wouter";
import { BrandLockup } from "@/components/brand/Brand";
import { Button } from "@/components/ui/button";
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
 * HIERARCHY — the form is the subject, the brand supports it.
 *
 * The page is one narrow column (26rem) on a wide dark field, read top to
 * bottom in four beats: the lockup, the technical slate, the heading, the gate.
 * Nothing sits beside the form, so nothing competes with it; the dark space
 * around the column is the composition, not a leftover. The lockup is the
 * largest brand object anywhere in the product, but it is set in a 20px
 * weight under a 33px heading, so the eye still lands on the form first.
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

  // A referral code arrives as `?ref=LMXXXXXXXX` on a shared signup link. The
  // pattern is the same one the backend accepts, so a hand-typed nonsense
  // value is dropped here instead of being sent and rejected.
  const referralCode = useMemo(() => {
    const query = location.split("?")[1] ?? "";
    const match = /[?&]ref=([^&]+)/.exec(query);
    const value = match?.[1] ? decodeURIComponent(match[1]).trim().toUpperCase() : "";
    return /^LM[A-Z0-9]{8}$/.test(value) ? value : null;
  }, [location]);

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
  // One value feeds both the rendered hint and the password's `aria-describedby`,
  // so the two can never disagree about whether a hint exists.
  const PASSWORD_HINT = isSignup ? "8 characters or more" : undefined;
  // Set at the moment the request leaves, so the timecode counts the request
  // rather than the time the tab has been open.
  const startedAt = useRef<number>(0);
  // Only the box click-forwarding needs these; focus is otherwise reached by
  // tab order and by the submit handler's jump to the first invalid field.
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

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

  // The timecode is parked at 00:00:00:00 until there is something to count,
  // and runs only for the length of the request. It used to tick ten times a
  // second from mount, which re-rendered every controlled input on the page
  // forever while it did nothing but look busy.
  useEffect(() => {
    if (!submitting || done) return;
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
  }, [submitting, done]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate every field at once on submit — this is the net for anything the
    // per-field checks on blur have not caught yet.
    const nextErrors: FieldErrors = {};
    for (const field of isSignup
      ? (["name", "email", "password"] as const)
      : (["email", "password"] as const)) {
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
    startedAt.current = Date.now();
    setCode("00:00:00:00");
    try {
      if (isSignup) {
        await signup({ name: name.trim(), email, password });
        // A `?ref=` code in the invite link is redeemed after the account
        // exists, because a referral can only be recorded against a real
        // user id. Failing here must not block the sign-up itself, so the code
        // is dropped if it is already used, malformed or self-referral.
        if (referralCode) {
          const { apiReferralApply } = await import("@/services/auth");
          await apiReferralApply(referralCode).catch(() => {});
        }
      } else {
        await login({ email, password });
      }
      setDone(true);
      // Let the gate read as exposed before we cut away to the app.
      window.setTimeout(() => navigate(nextPath), 420);
    } catch (err) {
      setError(normalizeAuthError(err));
      setSubmitting(false);
      setCode("00:00:00:00");
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
  //
  // The placeholder is /50, not /35. Measured against the field's own painted
  // background (void 8,8,10 -> carbon/80 -> black/45, i.e. rgb(9,9,11)) with
  // real source-over compositing: /35 = 3.13:1 and /45 = 4.49:1, and AA for
  // body text is 4.5:1 — so /45 is a miss, not a pass. /50 = 5.33:1 clears it
  // while staying the faintest thing in the field, which is what a placeholder
  // is supposed to be, and staying well under the 19.9:1 of the value you
  // actually type.
  const fieldWrap = (delay?: string) =>
    cn("px-3.5 py-2.5 text-[15px] text-white placeholder:text-white/50", delay);

  const submitLabel = submitting
    ? isSignup
      ? "Creating your account…"
      : "Signing you in…"
    : isSignup
      ? "Create account"
      : "Sign in";

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[var(--booth-void)] text-white">
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

      {/*
        `dvh`, not `vh`: on a phone, `100vh` is measured with the browser
        chrome collapsed, so a `min-h-screen` wrapper is taller than the screen
        and a page that would otherwise fit still scrolls by the height of the
        URL bar. `dvh` tracks the real viewport as the chrome moves.

        `my-auto` on the column rather than centring it outright: auto margins
        centre the column when there is room for it and collapse to the padding
        edge when there is not, which is the behaviour a three-field form needs
        on a landscape phone. It is robustness rather than a repair — the
        previous fixed-centre wrapper grew to fit its content and did not clip —
        but it is the arrangement that stays correct as this page gets taller.
      */}
      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col justify-center px-5 py-12 sm:px-8 sm:py-16">
        <div className="my-auto w-full">
          {/* Beat 1 — the brand, the way every product signs its own account
              pages. Non-interactive: the way back out is already the one link
              at the foot of the page, and two ways home is one too many. */}
          <div className="mb-9 sm:mb-11">
            <BrandLockup size="lg" className="text-white" label="Lenium" />
          </div>

          {/* Reel position: the technical voice, and the only small type here.
              It sits under the lockup as a caption on it, which is the one job
              it can do without arguing with the form for attention. */}
          <div className="mb-3 flex items-center justify-between font-tech text-[10px] tracking-[0.2em] text-[var(--booth-dust)] uppercase">
            <span>{isSignup ? "Enrol" : "Return"}</span>
            <span aria-hidden>{code}</span>
          </div>

          <header className="mb-8">
            <h1 className="font-display text-[2.05rem] leading-[1.12] tracking-[-0.015em] text-white">
              {isSignup ? (
                <>
                  Create your{" "}
                  <em className="italic text-[var(--lamp)]">account</em>
                </>
              ) : (
                <>
                  Welcome <em className="italic text-[var(--lamp)]">back</em>
                </>
              )}
            </h1>
            <p className="mt-3 max-w-[26rem] text-[13.5px] leading-relaxed text-[var(--booth-dust)]">
              {isSignup
                ? "One account for your list, your history and your downloads."
                : "Sign in to pick up where you left off."}
            </p>
          </header>

          {/*
            The gate panel. Depth comes from three stacked layers — the lamp
            behind, the blurred backdrop film, then a translucent carbon sheet —
            so the heavy drop shadow it used to carry is replaced by a hairline
            lit along the top edge, which is the cue that actually reads on a
            surface this dark. The blur keeps the backdrop artwork out of the
            type.
          */}
          <div className="ln-gate relative rounded-2xl border border-white/[0.08] bg-[var(--booth-carbon)]/80 p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05),0_28px_70px_-38px_rgba(0,0,0,0.95)] backdrop-blur-xl sm:p-8">
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

              <div className="space-y-5">
                {isSignup && (
                  <Field
                    id="auth-name"
                    label="Display name"
                    error={fieldErrors.name}
                    inputRef={nameRef}
                    className={fieldWrap()}
                  >
                    <input
                      ref={nameRef}
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
                      aria-describedby={describedBy(
                        "auth-name",
                        fieldErrors.name
                      )}
                      className="w-full bg-transparent outline-none"
                    />
                  </Field>
                )}

                <Field
                  id="auth-email"
                  label="Email"
                  error={fieldErrors.email}
                  inputRef={emailRef}
                  className={fieldWrap(
                    isSignup ? "animation-delay-[60ms]" : undefined
                  )}
                >
                  <input
                    ref={emailRef}
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
                    aria-describedby={describedBy(
                      "auth-email",
                      fieldErrors.email
                    )}
                    className="w-full bg-transparent outline-none"
                  />
                </Field>

                <Field
                  id="auth-password"
                  label="Password"
                  hint={PASSWORD_HINT}
                  error={fieldErrors.password}
                  inputRef={passwordRef}
                  className={fieldWrap(
                    isSignup
                      ? "animation-delay-[120ms]"
                      : "animation-delay-[60ms]"
                  )}
                >
                  <input
                    ref={passwordRef}
                    id="auth-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={e => {
                      setPassword(e.target.value);
                      if (fieldErrors.password) checkField("password");
                    }}
                    onBlur={() => checkField("password")}
                    placeholder={
                      isSignup ? "8 characters or more" : "Your password"
                    }
                    autoComplete={
                      isSignup ? "new-password" : "current-password"
                    }
                    maxLength={128}
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={describedBy(
                      "auth-password",
                      fieldErrors.password,
                      PASSWORD_HINT
                    )}
                    className="w-full bg-transparent pr-10 outline-none"
                  />
                  {/* People mistype passwords; making them verify by eye is the
                      difference between a form that works and one that doesn't. */}
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                    className="ln-focus-lamp-tight absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1.5 text-white/40 transition-colors hover:text-[var(--lamp)]"
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
                  className="mt-5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2.5 text-[13px] leading-snug text-rose-200"
                >
                  {error}
                </p>
              )}

              {/*
                The one solid, filled thing on the page. It was previously a
                hairline outline, which is what an outline is for: to shout
                without filling. As the primary action on a form that is
                already the subject, a filled lamp is quieter AND louder — one
                unambiguous target, and nothing to compete with. `Button` brings
                the focus ring, the disabled contract and the icon sizing with
                it; the three states are all solid so the control only ever
                changes colour, never shape.

                NOTE: the type is set on the inner span, not on the button.
                `index.css` declares `button, input { font: inherit }`
                unlayered, and unlayered declarations outrank every Tailwind
                utility, so `text-[14px] font-bold` on the element itself is
                silently discarded and the button inherits 16px/400 from the
                body. That is why `Button` has rendered at the wrong size
                everywhere in this app. The span is not matched by that rule, so
                the type lands. The real fix is to wrap that rule in
                `@layer base`; that is an app-wide retypeset and is out of scope
                for this page.
              */}
              <Button
                type="submit"
                size="lg"
                disabled={submitting}
                aria-busy={submitting}
                data-state={submitting ? "running" : "idle"}
                className={cn(
                  "ln-focus-lamp ln-expose relative mt-6 w-full overflow-hidden rounded-lg",
                  "disabled:cursor-progress disabled:opacity-100",
                  done
                    ? "bg-[var(--signal)] text-[var(--signal-ink)] hover:bg-[var(--signal)]"
                    : submitting
                      ? "bg-[var(--lamp-core)] text-[var(--lamp-ink)] hover:bg-[var(--lamp-core)]"
                      : "bg-[var(--lamp)] text-[var(--lamp-ink)] hover:bg-[var(--lamp-core)]"
                )}
              >
                <span className="relative z-10 text-[14px] font-bold tracking-[0.01em]">
                  {done ? "You're in" : submitLabel}
                </span>
              </Button>

              {/* The rail fills for as long as the request takes. */}
              <div
                aria-hidden
                className={cn(
                  "mt-3 h-px w-full overflow-hidden bg-white/8",
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

            {/* The way across is separated from the form by a hairline rather
                than by more air: it is a peer of the form, not a footnote to
                it, and the rule is cheaper than another 24px of space. */}
            <div className="mt-7 border-t border-white/[0.07] pt-6">
              <p className="text-center text-[13.5px] text-[var(--booth-dust)]">
                {isSignup ? "Already have an account?" : "New to Lenium?"}{" "}
                <Link
                  href={swapHref}
                  className="ln-focus-lamp rounded-sm font-semibold text-[var(--lamp)] underline-offset-4 transition hover:underline"
                >
                  {isSignup ? "Sign in" : "Create an account"}
                </Link>
              </p>
            </div>
          </div>

          <Link
            href="/"
            className="ln-focus-lamp mt-8 inline-flex items-center gap-1.5 rounded-sm font-tech text-[10.5px] tracking-[0.16em] text-white/50 uppercase transition-colors hover:text-white/85"
          >
            <ArrowLeft className="size-3" aria-hidden />
            Browse instead
          </Link>
        </div>
      </div>
    </div>
  );
}

type FieldId = "auth-name" | "auth-email" | "auth-password";

/**
 * The ids a control points at, in the order a screen reader should read them:
 * the standing hint first, then the error. Kept in one function so the
 * `aria-describedby` on each input and the `id` on each rendered message can
 * never drift apart.
 *
 * The hint is passed in rather than inferred from the field id, because whether
 * a hint exists is a property of the mode, not of the field: signup shows the
 * password hint and login does not. Inferring it from the id made every login
 * render point at an `auth-password-hint` that was never in the DOM — a
 * dangling IDREF, which screen readers resolve to nothing and validators flag.
 */
function describedBy(
  id: FieldId,
  error?: string,
  hint?: string
): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-err` : null];
  return ids.filter(Boolean).join(" ") || undefined;
}

/** A label, the control it names, and that control's error — one job each. */
function Field({
  id,
  label,
  hint,
  error,
  className,
  inputRef,
  children,
}: {
  id: FieldId;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[12.5px] font-medium text-white/75">
          {label}
        </label>
        {hint && (
          <span
            id={`${id}-hint`}
            className="font-tech text-[10px] tracking-wider text-[var(--booth-dust)] uppercase"
          >
            {hint}
          </span>
        )}
      </div>
      {/*
        The box is a div that forwards the click, not a second <label>. A
        control with two labels is two associations to keep in sync, and the
        wrapper one contributed an empty name; this keeps the same full-height
        target with exactly one label in the tree. The forward is a
        convenience only — the label above and the input itself are what a
        keyboard reaches, so nothing here is operable by click alone.
      */}
      <div
        className={cn("ln-field ln-set cursor-text", className)}
        data-invalid={Boolean(error) || undefined}
        onClick={() => inputRef.current?.focus()}
      >
        {children}
      </div>
      {/* Each message sits with the field it belongs to, and is reached from
          that field via aria-describedby, so it needs no live region of its
          own. The words say what to do, not what went wrong internally. */}
      {error && (
        <p
          id={`${id}-err`}
          className="mt-2 text-[12.5px] leading-snug text-rose-300"
        >
          {error}
        </p>
      )}
    </div>
  );
}
