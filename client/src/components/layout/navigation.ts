import {
  Compass,
  Film,
  Tv,
  Sparkles,
  Download,
  Bookmark,
  Home as HomeIcon,
  UserRound,
  Zap,
  Heart,
  Film as FilmIcon,
} from "lucide-react";

/**
 * Available catalog views.
 */
export type View =
  | "home"
  | "movies"
  | "tv"
  | "trending"
  | "downloads"
  | "my-list"
  | "profile"
  | "new"
  | "popular"
  | "genres"
  | "collections";

export interface NavItem {
  id: View;
  label: string;
  icon: typeof HomeIcon;
  /** Optional genre filter for this nav item */
  genre?: string;
  /** Accent color for the icon */
  color?: string;
}

export const genreFilterOptions = [
  "All",
  "Action",
  "Adventure",
  "Comedy",
  "Crime",
  "Drama",
  "Family",
  "Mystery",
  "Romance",
  "Sci-fi",
  "Thriller",
];

/** The primary destinations rendered in the navigation dock. */
export const navItems: NavItem[] = [
  { id: "home", label: "Home", icon: HomeIcon, color: "#d7d7d3" },
  { id: "movies", label: "Movies", icon: FilmIcon, color: "#ef4444" },
  { id: "tv", label: "TV Series", icon: Tv, color: "#7c3aed" },
  { id: "trending", label: "Trending", icon: Sparkles, color: "#f59e0b" },
  { id: "downloads", label: "Downloads", icon: Download, color: "#10b981" },
  { id: "my-list", label: "My Library", icon: Bookmark, color: "#ec4899" },
  { id: "profile", label: "Profile", icon: UserRound, color: "#06b6d4" },
];
