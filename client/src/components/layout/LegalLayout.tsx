import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

interface LegalLayoutProps {
  title: string;
  intro: string;
  children: ReactNode;
}

/**
 * Shared shell for the `/terms` and `/dmca` pages: same dark violet canvas and
 * glass panels as the rest of the app, with a readable measure for body copy.
 */
export function LegalLayout({ title, intro, children }: LegalLayoutProps) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-zinc-950 text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[64rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(124,58,237,0.16),transparent)] blur-3xl"
      />

      <div className="relative z-10 mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        <a
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to browsing
        </a>

        <h1 className="mt-8 text-3xl font-black tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-4 text-base leading-7 text-zinc-400">{intro}</p>

        <div className="mt-10 space-y-8">{children}</div>
      </div>
    </div>
  );
}

export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
      <h2 className="text-lg font-bold tracking-tight text-white">{heading}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-zinc-300">
        {children}
      </div>
    </section>
  );
}

export function LegalList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
