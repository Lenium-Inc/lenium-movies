import { ArrowLeft, Library } from "lucide-react";
import { useLocation } from "wouter";

/**
 * 404 page, told in the same language as the auth gate: the projector is
 * pointed at an empty frame. The lamp is on, but there is no reel behind it.
 * This replaces a violet CRT-and-glitch treatment that read as a different
 * product, and whose two buttons both went to the same place.
 */
export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-[var(--booth-void)] px-5 py-16 text-white">
      {/* The lamp, turned down. Same source as the auth booth, holding less. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 58% 42% at 50% 0%, rgba(255,174,92,0.13), transparent 60%), linear-gradient(180deg, #0c0c0f 0%, #08080a 55%, #08080a 100%)",
        }}
      />

      <div className="relative z-10 w-full max-w-lg">
        {/* The empty frame. Same gate as the sign-in screen, holding nothing. */}
        <div className="ln-gate ln-set relative overflow-hidden rounded-2xl border border-white/10 bg-[rgba(0,0,0,0.55)] px-6 py-9 text-center sm:px-10">
          <p className="font-tech text-[10px] tracking-[0.22em] text-white/50 uppercase">
            No reel loaded
          </p>

          <p
            aria-hidden
            className="mt-4 font-tech text-[3.25rem] leading-none font-bold tracking-tight text-white/18 select-none sm:text-[4rem]"
          >
            404
          </p>

          {/* The one decorative flourish: a light path that starts and stops,
              because that is all the projector has left to do. */}
          <div aria-hidden className="mx-auto mt-6 w-40">
            <div className="h-px w-full bg-white/10" />
            <div className="ln-stall h-px w-1/3 bg-[var(--lamp-core)] opacity-70" />
          </div>

          <h1 className="mt-7 font-display text-[1.6rem] leading-tight font-semibold sm:text-4xl">
            This one isn&apos;t in the vault
          </h1>

          <p className="mx-auto mt-3 max-w-sm text-[0.95rem] leading-6 text-white/60">
            The link may be mistyped, or the title may have left the library.
          </p>

          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => setLocation("/")}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[rgba(255,231,194,0.4)] px-5 py-3 text-sm font-medium text-[var(--lamp)] transition-colors hover:border-[var(--lamp)] hover:bg-[rgba(255,231,194,0.06)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lamp)]"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to browse
            </button>
            <button
              type="button"
              onClick={() => setLocation("/my-list")}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-5 py-3 text-sm font-medium text-white/85 transition-colors hover:border-white/30 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Library className="h-4 w-4" />
              Open my list
            </button>
          </div>
        </div>

        <p className="mt-6 text-center font-tech text-[10px] tracking-[0.18em] text-white/40 uppercase">
          End of reel
        </p>
      </div>
    </div>
  );
}
