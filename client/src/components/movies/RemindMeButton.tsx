import { useEffect, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { toast } from "sonner";
import type { Movie } from "@/components/movies/types";
import { cn } from "@/lib/utils";
import {
  formatReleaseShort,
  isReminded,
  subscribeReminders,
  toggleReminder,
} from "@/services/notifications";

interface RemindMeButtonProps {
  movie: Movie;
  className?: string;
}

/**
 * "Notify me" for a title that has not come out yet. The confirmed state is
 * read back from the store rather than held only in the component, so the
 * button and the nav bell can never disagree about whether a reminder is set.
 *
 * Renders nothing when the catalogue has no release date: there is no day to
 * be told about, and a button that promised one would be inventing it.
 */
export function RemindMeButton({ movie, className }: RemindMeButtonProps) {
  const key = String(movie.providerId ?? movie.id);
  const [set, setSet] = useState(() => isReminded(key));

  useEffect(() => {
    setSet(isReminded(key));
    return subscribeReminders(() => setSet(isReminded(key)));
  }, [key]);

  if (!movie.releaseDate) return null;
  const releaseDate = movie.releaseDate;

  const handleClick = () => {
    const nowSet = toggleReminder({
      id: movie.id,
      providerId: movie.providerId,
      title: movie.title,
      poster: movie.poster,
      releaseDate,
      mediaType: movie.mediaType,
    });
    setSet(nowSet);
    toast.success(
      nowSet
        ? `Reminder set — we'll mark it for ${formatReleaseShort(releaseDate)}`
        : "Reminder removed"
    );
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={set}
      className={cn(
        "inline-flex h-11 items-center gap-2.5 rounded-full border border-white/24 bg-white/[0.08] px-5 text-sm font-medium text-[#f1f3f8] transition hover:brightness-110",
        set && "border-white/40 bg-white/[0.16]",
        className
      )}
    >
      {set ? (
        <BellRing className="h-4 w-4" aria-hidden />
      ) : (
        <Bell className="h-4 w-4" aria-hidden />
      )}
      {set ? "Reminder set" : `Notify me on ${formatReleaseShort(releaseDate)}`}
    </button>
  );
}

export default RemindMeButton;
