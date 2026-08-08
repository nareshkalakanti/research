"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type AuthState = {
  user: string | null;
  ready: boolean;
  login: (email: string, password: string) => { ok: boolean; error?: string };
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);
const STORAGE_KEY = "research_demo_user";

/** Demo-only credentials — any email works with password `demo`. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setUser(saved);
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  const login = useCallback((email: string, password: string) => {
    const e = email.trim();
    if (!e) return { ok: false, error: "Enter an email" };
    if (password !== "demo") {
      return { ok: false, error: "Use password: demo" };
    }
    localStorage.setItem(STORAGE_KEY, e);
    setUser(e);
    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, login, logout }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
