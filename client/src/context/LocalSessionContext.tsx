import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  initializeSession,
  signInDemo,
  signOut,
  getSession,
  isInMyList,
  addToMyList,
  removeFromMyList,
  toggleMyList,
  getMyList,
  addToHistory,
  removeFromHistory,
  clearHistory,
  getHistory,
  subscribe,
  type SessionState,
  type LocalUser,
  type MovieSummary,
  type WatchHistoryItem,
} from "@/lib/localSession";

export type LocalSessionContextValue = {
  user: LocalUser | null;
  isAuthenticated: boolean;
  hydrated: boolean;
  signInDemo: () => void;
  signOut: () => void;
  isInMyList: (movieId: string | number) => boolean;
  addToMyList: (movie: MovieSummary) => void;
  removeFromMyList: (movieId: string | number) => void;
  toggleMyList: (movie: MovieSummary) => boolean;
  getMyList: () => MovieSummary[];
  addToHistory: (item: WatchHistoryItem) => void;
  removeFromHistory: (movieId: string | number) => void;
  clearHistory: () => void;
  getHistory: () => WatchHistoryItem[];
};

const LocalSessionContext = createContext<LocalSessionContextValue | null>(null);

interface LocalSessionProviderProps {
  children: ReactNode;
}

export function LocalSessionProvider({ children }: LocalSessionProviderProps) {
  const [session, setSession] = useState<SessionState>({
    user: null,
    isAuthenticated: false,
    hydrated: false,
  });

  useEffect(() => {
    const initial = initializeSession();
    setSession(initial);

    const unsubscribe = subscribe(() => {
      setSession(getSession());
    });

    return unsubscribe;
  }, []);

  const value: LocalSessionContextValue = {
    user: session.user,
    isAuthenticated: session.isAuthenticated,
    hydrated: session.hydrated,
    signInDemo,
    signOut,
    isInMyList,
    addToMyList,
    removeFromMyList,
    toggleMyList,
    getMyList,
    addToHistory,
    removeFromHistory,
    clearHistory,
    getHistory,
  };

  return (
    <LocalSessionContext.Provider value={value}>
      {children}
    </LocalSessionContext.Provider>
  );
}

export function useLocalSession(): LocalSessionContextValue {
  const context = useContext(LocalSessionContext);
  if (!context) {
    throw new Error("useLocalSession must be used within a LocalSessionProvider");
  }
  return context;
}