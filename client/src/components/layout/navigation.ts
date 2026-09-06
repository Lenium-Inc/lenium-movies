import {
  Clapperboard,
  Compass,
  Film,
  Home as HomeIcon,
  Library,
  List,
  Sparkles,
} from "lucide-react";

/**
 * Available catalog views. `home` maps to the landing page and every other
 * value maps to a filtered shelf view.
 */
export type View =
  "home" | "movies" | "new" | "popular" | "genres" | "collections" | "my-list";

export interface NavItem {
  id: View;
  label: string;
  icon: typeof HomeIcon;
}

/** Primary browse destinations rendered in the sidebar and mobile nav. */
export const navItems: NavItem[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "movies", label: "Movies", icon: Film },
  { id: "new", label: "New", icon: Clapperboard },
  { id: "popular", label: "Popular", icon: Sparkles },
  { id: "genres", label: "Genres", icon: Compass },
  { id: "collections", label: "Collections", icon: Library },
  { id: "my-list", label: "My List", icon: List },
];
