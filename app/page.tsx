import Link from "next/link";
import { ContentGrid } from "@/components/ui/ContentGrid";
import { HeroBanner } from "@/components/ui/HeroBanner";
import { getPublicVodCatalog } from "@/lib/vod-catalog";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const titles = getPublicVodCatalog();
  const featured = titles.find(item => item.backdropUrl) ?? titles[0];
  return (
    <main className="min-h-screen bg-[#0b0b0b] text-white">
      <header className="absolute inset-x-0 top-0 z-30">
        <nav className="mx-auto flex h-20 max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="text-lg font-semibold tracking-[0.12em] text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            LENIUM<span className="text-cyan-200">.</span>
          </Link>
          <span className="text-xs font-medium uppercase tracking-[0.18em] text-white/55">
            Your screen, your stories
          </span>
        </nav>
      </header>
      {featured ? <HeroBanner title={featured} /> : (
        <section className="px-6 pb-20 pt-40">
          <h1 className="text-4xl font-semibold">Your library, on your terms.</h1>
          <p className="mt-4 max-w-xl text-white/60">
            Add authorized titles to your self-hosted catalog to begin browsing.
          </p>
        </section>
      )}
      <div id="catalog" className="relative z-10 -mt-4">
        <ContentGrid
          title="Films"
          items={titles.filter(item => item.kind === "movie")}
        />
        <ContentGrid
          title="Series"
          items={titles.filter(item => item.kind === "series")}
        />
      </div>
    </main>
  );
}
