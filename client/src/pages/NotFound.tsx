import { ArrowLeft, Compass } from "lucide-react";
import { useLocation } from "wouter";

/**
 * Cinematic 404 page: a dark, theatrical zinc-950 canvas with a faint red
 * atmospheric glow, a glitching CRT television, and branded CTAs.
 */
export default function NotFound() {
  const [, setLocation] = useLocation();

  const goTo = (path: string) => {
    setLocation(path);
  };

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-zinc-950 text-white">
      {/* Atmospheric radial glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[38rem] w-[70rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(220,38,38,0.18),transparent)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-96 w-96 rounded-full bg-[radial-gradient(closest-side,rgba(217,70,239,0.10),transparent)] blur-3xl"
      />

      <div className="relative z-10 w-full max-w-2xl px-6 py-16 text-center">
        {/* Glitch TV */}
        <div className="mx-auto mb-8 w-full max-w-[15rem]">
          <svg
            viewBox="0 0 320 240"
            className="h-auto w-full"
            role="img"
            aria-label="A glitching television set"
          >
            <defs>
              <clipPath id="notfound-screen">
                <rect x="64" y="60" width="192" height="124" rx="6" />
              </clipPath>
              <linearGradient id="notfound-scan" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(239,68,68,0)" />
                <stop offset="0.5" stopColor="rgba(239,68,68,0.45)" />
                <stop offset="1" stopColor="rgba(239,68,68,0)" />
              </linearGradient>
            </defs>

            {/* legs */}
            <path
              d="M92 206 L72 226 M228 206 L248 226"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="4"
              strokeLinecap="round"
            />

            {/* TV body */}
            <rect
              x="48"
              y="44"
              width="224"
              height="156"
              rx="14"
              fill="#16161a"
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="2"
            />

            {/* screen bezel */}
            <rect
              x="64"
              y="60"
              width="192"
              height="124"
              rx="6"
              fill="#09090b"
              stroke="rgba(255,255,255,0.08)"
            />

            {/* glitch content */}
            <g clipPath="url(#notfound-screen)">
              <rect x="64" y="60" width="192" height="124" fill="#0b0b0f" />

              {/* faint figure silhouettes */}
              <circle cx="144" cy="118" r="26" fill="rgba(255,255,255,0.06)" />
              <rect x="118" y="148" width="52" height="36" fill="rgba(255,255,255,0.04)" />

              {/* static bars */}
              <g className="animate-pulse">
                <rect x="64" y="76" width="192" height="6" fill="rgba(239,68,68,0.35)" />
                <rect x="64" y="98" width="192" height="3" fill="rgba(255,255,255,0.18)" />
                <rect x="64" y="122" width="192" height="5" fill="rgba(239,68,68,0.22)" />
                <rect x="64" y="150" width="192" height="4" fill="rgba(255,255,255,0.14)" />
              </g>

              {/* travelling scanline */}
              <rect
                x="64"
                y="106"
                width="192"
                height="16"
                fill="url(#notfound-scan)"
                className="animate-pulse"
              />
            </g>

            {/* controls */}
            <circle cx="160" cy="214" r="5" fill="rgba(255,255,255,0.15)" />
          </svg>
        </div>

        {/* Glitch headline */}
        <p
          aria-hidden
          className="select-none text-7xl font-black leading-none tracking-tight text-white/20 md:text-9xl"
        >
          404
        </p>

        <h1 className="mt-4 text-2xl font-bold tracking-tight md:text-4xl">
          Director&apos;s Cut Not Found
        </h1>

        <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-zinc-400 md:text-base">
          This episode doesn&apos;t exist yet — or it aired somewhere else. Even
          the bonus features couldn&apos;t track it down.
        </p>

        {/* CTAs */}
        <div id="not-found-button-group" className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => goTo("/")}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Home
          </button>
          <button
            type="button"
            onClick={() => goTo("/")}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-white/20 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Compass className="h-4 w-4" />
            Explore Trending
          </button>
        </div>
      </div>
    </div>
  );
}