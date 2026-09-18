import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type StreamQuality = "4K" | "1080p" | "720p" | "480p" | "320p";

export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
}

export interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (credentials?: Record<string, unknown>) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

const STORAGE_KEY = "freestream_user";

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.name === "string" &&
          typeof parsed.email === "string"
        ) {
          setUser(parsed);
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const login = async (
    credentials?: Record<string, unknown>
  ): Promise<void> => {
    setIsLoading(true);
    try {
      if (credentials?.email && credentials?.name) {
        const newUser: User = {
          id: (credentials.id as string) || crypto.randomUUID(),
          name: credentials.name as string,
          email: credentials.email as string,
          avatar_url: credentials.avatar_url as string | undefined,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newUser));
        setUser(newUser);
      } else {
        const mockUser: User = {
          id: crypto.randomUUID(),
          name: "Demo User",
          email: "demo@freestream.app",
          avatar_url: undefined,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(mockUser));
        setUser(mockUser);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const logout = (): void => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
