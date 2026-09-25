import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { fetchTrending, type StreamMovie } from "@/services/api";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

interface AuthPageProps {
  mode: "login" | "signup";
}

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

/**
 * Full-screen sign-in / sign-up. Renders a dimmed, blurred ambient backdrop
 * pulled from the live catalog, a frosted-glass auth card, and routes to the
 * "Who's watching?" gate on success.
 */
export default function AuthPage({ mode }: AuthPageProps) {
  const { login, signup } = useAuth();
  const [, navigate] = useLocation();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [backdrop, setBackdrop] = useState<string | null>(null);

  const isSignup = mode === "signup";

  useEffect(() => {
    let mounted = true;
    fetchTrending({ time_window: "week", media_type: "movie" })
      .then((items: StreamMovie[]) => {
        if (!mounted) return;
        const withArt = items.filter((i) => i.backdrop_url);
        const pick = withArt[Math.floor(Math.random() * withArt.length)];
        if (pick?.backdrop_url) {
          const url = pick.backdrop_url;
          setBackdrop(url.startsWith("http") ? url : `${TMDB_IMAGE_BASE_URL}/original${url}`);
        }
      })
      .catch(() => {
        /* keep the gradient fallback */
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (isSignup && name.trim().length === 0) {
      setError("Enter your name");
      return;
    }
    setSubmitting(true);
    try {
      if (isSignup) {
        await signup({ name: name.trim(), email, password });
      } else {
        await login({ email, password });
      }
      navigate("/profiles");
    } catch (err) {
      setError(normalizeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050505] text-white">
      {/* Ambient poster backdrop */}
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-110 object-cover object-center blur-2xl"
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_120%_100%_at_50%_-10%,rgba(99,102,241,0.35),transparent_60%),linear-gradient(160deg,#121218_0%,#0A0A0C_55%,#050505_100%)]"
        />
      )}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,transparent_0%,rgba(5,5,5,0.55)_70%,#050505_100%)]"
      />

      {/* Frosted glass card */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-white to-white/70 text-xl font-black text-black shadow-[0_12px_40px_rgba(255,255,255,0.25)]">
              S
            </div>
            <h1 className="mt-5 text-3xl font-bold tracking-tight">
              {isSignup ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-2 text-sm text-white/50">
              {isSignup
                ? "Join Stream Vy to stream movies and shows."
                : "Sign in to start watching."}
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-8 shadow-2xl backdrop-blur-2xl">
            <form onSubmit={handleSubmit} className="space-y-4">
              {isSignup && (
                <div>
                  <label htmlFor="auth-name" className="mb-2 block text-sm font-medium text-white/70">
                    Display Name
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="How should we address you?"
                    autoComplete="name"
                    autoFocus
                    maxLength={40}
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
                  />
                </div>
              )}
              <div>
                <label htmlFor="auth-email" className="mb-2 block text-sm font-medium text-white/70">
                  Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus={!isSignup}
                  maxLength={254}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
                />
              </div>
              <div>
                <label htmlFor="auth-password" className="mb-2 block text-sm font-medium text-white/70">
                  Password
                </label>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  maxLength={128}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30"
                />
              </div>

              {error && (
                <p className="rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-sm text-violet-300">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Please wait...
                  </>
                ) : isSignup ? (
                  "Create Account"
                ) : (
                  "Sign In"
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-white/50">
              {isSignup ? (
                <>
                  Already have an account?{" "}
                  <Link href="/login" className="font-semibold text-white hover:underline">
                    Sign in
                  </Link>
                </>
              ) : (
                <>
                  New to Stream Vy?{" "}
                  <Link href="/signup" className="font-semibold text-white hover:underline">
                    Sign up now
                  </Link>
                </>
              )}
            </p>
          </div>

          <Link
            href="/"
            className="mt-8 inline-flex w-fit items-center gap-1.5 text-xs text-white/40 transition hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to browsing
          </Link>
        </div>
      </div>
    </div>
  );
}