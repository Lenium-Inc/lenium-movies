import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { WatchExperience } from "@/components/player/WatchExperience";
import { getPublicVodCatalog } from "@/lib/vod-catalog";

export const dynamic = "force-dynamic";

export default async function WatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const title = getPublicVodCatalog().find(item => item.titleId === id);
  if (!title) notFound();

  return (
    <main className="min-h-screen bg-[#0b0b0b] text-white">
      <header className="mx-auto flex max-w-[1440px] items-center px-5 py-6 sm:px-8 lg:px-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-white/65 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to browse
        </Link>
      </header>
      <section className="mx-auto max-w-[1440px] px-5 pb-20 sm:px-8 lg:px-12">
        <WatchExperience
          titleId={title.titleId}
          title={title}
          initialEpisode={title.episodes[0]}
        />
      </section>
    </main>
  );
}
