import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

export type PreferredLanguage = 
  | "en-US"  // English (US)
  | "en-GB"  // English (UK)
  | "es-ES"  // Spanish
  | "fr-FR"  // French
  | "de-DE"  // German
  | "it-IT"  // Italian
  | "pt-BR"  // Portuguese (Brazil)
  | "ja-JP"  // Japanese
  | "ko-KR"  // Korean
  | "zh-CN"  // Chinese (Simplified)
  | "hi-IN"  // Hindi
  | "ar-SA"  // Arabic
  | "ru-RU"; // Russian

export interface LanguageOption {
  code: PreferredLanguage;
  label: string;
  nativeLabel: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en-US", label: "English (US)", nativeLabel: "English (US)" },
  { code: "en-GB", label: "English (UK)", nativeLabel: "English (UK)" },
  { code: "es-ES", label: "Spanish", nativeLabel: "Español" },
  { code: "fr-FR", label: "French", nativeLabel: "Français" },
  { code: "de-DE", label: "German", nativeLabel: "Deutsch" },
  { code: "it-IT", label: "Italian", nativeLabel: "Italiano" },
  { code: "pt-BR", label: "Portuguese (Brazil)", nativeLabel: "Português (Brasil)" },
  { code: "ja-JP", label: "Japanese", nativeLabel: "日本語" },
  { code: "ko-KR", label: "Korean", nativeLabel: "한국어" },
  { code: "zh-CN", label: "Chinese (Simplified)", nativeLabel: "中文 (简体)" },
  { code: "hi-IN", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "ar-SA", label: "Arabic", nativeLabel: "العربية" },
  { code: "ru-RU", label: "Russian", nativeLabel: "Русский" },
];

export interface AppSettings {
  preferredLanguage: PreferredLanguage;
  autoSelectAudioSubtitles: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  preferredLanguage: "en-US",
  autoSelectAudioSubtitles: true,
};

const STORAGE_KEY = "freestream-app-settings";

interface AppSettingsContextType {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  setPreferredLanguage: (lang: PreferredLanguage) => void;
  toggleAutoSelect: () => void;
}

const AppSettingsContext = createContext<AppSettingsContextType | undefined>(undefined);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setSettings(prev => ({ ...prev, ...parsed }));
      }
    } catch {
      // Ignore parse errors
    } finally {
      setHydrated(true);
    }
  }, []);

  // Persist settings to localStorage
  useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Ignore write errors
      }
    }
  }, [settings, hydrated]);

  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings(prev => ({ ...prev, ...partial }));
  }, []);

  const setPreferredLanguage = useCallback((lang: PreferredLanguage) => {
    setSettings(prev => ({ ...prev, preferredLanguage: lang }));
  }, []);

  const toggleAutoSelect = useCallback(() => {
    setSettings(prev => ({ ...prev, autoSelectAudioSubtitles: !prev.autoSelectAudioSubtitles }));
  }, []);

  return (
    <AppSettingsContext.Provider value={{
      settings,
      updateSettings,
      setPreferredLanguage,
      toggleAutoSelect,
    }}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);
  if (!context) {
    throw new Error("useAppSettings must be used within an AppSettingsProvider");
  }
  return context;
}