import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  apiLogin,
  apiLogout,
  apiMe,
  apiSignup,
  clearSession,
  getStoredUser,
  type ApiUser,
} from "@/services/auth";

export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
}

export interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (credentials: { email: string; password: string }) => Promise<void>;
  signup: (input: { name: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

function toUser(api: ApiUser): User {
  return {
    id: String(api.id),
    name: api.name,
    email: api.email,
    avatar_url: undefined,
  };
}

export function AuthProvider({ children }: AuthProviderProps) {
  // Rehydrate synchronously from localStorage so protected chrome (e.g. the
  // "Sign In" button vs the profile menu) never flashes while `apiMe`
  // validates the stored session in the background.
  const [user, setUser] = useState<User | null>(() => {
    const cached = getStoredUser();
    return cached ? toUser(cached) : null;
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const cached = getStoredUser();
    if (cached) {
      setUser(toUser(cached));
    }
    void apiMe()
      .then((fresh) => {
        if (!mounted) return;
        if (fresh) {
          setUser(toUser(fresh));
        } else {
          setUser(null);
        }
      })
      .catch(() => {
        /* keep cached session on network failure */
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const login = async (credentials: {
    email: string;
    password: string;
  }): Promise<void> => {
    setIsLoading(true);
    try {
      const payload = await apiLogin(credentials);
      setUser(toUser(payload.user));
    } finally {
      setIsLoading(false);
    }
  };

  const signup = async (input: {
    name: string;
    email: string;
    password: string;
  }): Promise<void> => {
    setIsLoading(true);
    try {
      const payload = await apiSignup(input);
      setUser(toUser(payload.user));
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    await apiLogout();
    setUser(null);
    clearSession();
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, signup, logout }}>
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