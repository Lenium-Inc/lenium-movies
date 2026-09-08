import { Film, Home as HomeIcon, List, UserRound, ChevronDown, ChevronUp } from "lucide-react";

/**
 * Available catalog views. `home` maps to the landing page and every other
 * value maps to a filtered shelf view.
 */
export type View =
  | "home"
  | "movies"
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

/** The only primary destinations rendered in the sidebar. */
export const navItems: NavItem[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "movies", label: "Movies", icon: Film },
  { id: "my-list", label: "My List", icon: List },
  { id: "profile", label: "Profile", icon: UserRound },
];
