import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { resolveAvatarUrl } from "@/lib/avatars";
import { cn } from "@/lib/utils";

interface ProfileAvatarProps {
  profile: {
    name: string;
    avatar?: string | null;
    avatarId?: string | null;
    isKids?: boolean;
  };
  className?: string;
  /** Square rather than circular, to match profile card tiles. */
  square?: boolean;
  /**
   * Decorative by default. A profile card already names the profile in text
   * beside the image, so repeating the name for screen readers is noise; the
   * nav trigger that has no visible label passes a real one.
   */
  alt?: string;
}

/**
 * The single place a profile avatar is drawn.
 *
 * Five call sites previously each hand-rolled `<img src={profile.avatar}>` with
 * an inline initials fallback, and three of them had no fallback at all -- so a
 * profile written by an older build, or one whose remote image failed, rendered
 * a broken-image glyph in the profile switcher. Radix's `Avatar` handles the
 * image-error -> fallback transition for free, and routing every site through
 * here means that behaviour is uniform.
 *
 * The url is resolved through `resolveAvatarUrl`, so a missing `avatar` becomes
 * a generated face rather than an empty `src`.
 */
export function ProfileAvatar({
  profile,
  className,
  square = false,
  alt,
}: ProfileAvatarProps) {
  const src = resolveAvatarUrl({
    avatarId: profile.avatarId,
    avatar: profile.avatar,
    name: profile.name,
    isKids: profile.isKids,
  });

  return (
    <Avatar className={cn(square ? "rounded-xl" : "rounded-full", className)}>
      <AvatarImage src={src} alt={alt ?? ""} />
      <AvatarFallback
        className={cn(
          "bg-white text-black",
          square ? "rounded-xl text-base" : "text-base",
          "font-black",
        )}
      >
        {(profile.name.trim().charAt(0) || "?").toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
