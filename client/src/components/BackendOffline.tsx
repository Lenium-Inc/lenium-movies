import { useMemo } from "react";
import { MOVIE_API_BASE_URL } from "@/services/api";

function randomRayId(): string {
  const hex = "0123456789abcdef";
  return Array.from({ length: 17 }, () => hex[Math.floor(Math.random() * 16)]).join("");
}

function CloudGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 40" className={className} aria-hidden focusable="false">
      <path
        fill="#F6821F"
        d="M45.6 39H16.2C8.4 39 2 32.8 2 25.1c0-7.2 5.5-13.2 12.7-14C16.8 5.4 23.3 0 31.1 0c7.1 0 13.3 4.4 15.6 10.6C53.2 11.1 62 18 62 27.3 62 33.8 56.4 39 49.5 39h-3.9z"
      />
    </svg>
  );
}

export default function BackendOffline({ onRetry }: { onRetry: () => void }) {
  const rayId = useMemo(randomRayId, []);
  const host = useMemo(() => {
    try {
      return new URL(MOVIE_API_BASE_URL).host;
    } catch {
      return MOVIE_API_BASE_URL || "origin";
    }
  }, []);

  return (
    <div className="flex min-h-screen w-full flex-col items-center bg-[#f9f9f9] px-6 py-14 text-center text-[#313131]">
      <CloudGlyph className="h-10 w-16 shrink-0" />

      <h1 className="mt-10 text-3xl font-semibold tracking-tight">Bad gateway</h1>

      <p
        aria-hidden
        className="mt-4 text-[clamp(4rem,16vw,8rem)] leading-none font-bold tracking-tight text-[#d9d9d9] select-none"
      >
        Error 1033
      </p>

      <p className="mt-8 max-w-lg text-[0.95rem] leading-7 text-[#5c5c5c]">
        Cloudflare could not connect to the host&apos;s origin server, so this site can&apos;t
        load right now. Please try again in a few moments. If the issue persists, the site
        owner will need to bring the backend back online.
      </p>

      <dl className="mt-8 space-y-1 text-left text-[0.8rem] text-[#8b8b8b]">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-right">Host</dt>
          <dd className="font-mono text-[#5c5c5c]">{host}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-right">Ray ID</dt>
          <dd className="font-mono text-[#5c5c5c]">{rayId}</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onRetry}
        className="mt-10 rounded-md bg-[#f6821f] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#e07010] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6821f]"
      >
        Try again
      </button>
    </div>
  );
}
