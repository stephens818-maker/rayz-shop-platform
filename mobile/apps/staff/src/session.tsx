import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { API_URL } from "./net";

const KEY = "rayz.team.session";

export interface StaffSession {
  token: string;
  refreshToken: string;
  firstName: string;
  staffId: string;
}

interface Store {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

const webStore: Store = {
  getItem: async (key) => (typeof localStorage === "undefined" ? null : localStorage.getItem(key)),
  setItem: async (key, value) => localStorage.setItem(key, value),
  removeItem: async (key) => localStorage.removeItem(key),
};

async function nativeStore(): Promise<Store> {
  const SecureStore = await import("expo-secure-store");
  return { getItem: (key) => SecureStore.getItemAsync(key), setItem: (key, value) => SecureStore.setItemAsync(key, value), removeItem: (key) => SecureStore.deleteItemAsync(key) };
}

async function store(): Promise<Store> {
  return Platform.OS === "web" ? webStore : nativeStore();
}

interface StaffContext {
  session: StaffSession | null;
  ready: boolean;
  unlocked: boolean;
  stepUp: string | null;
  save: (session: StaffSession) => Promise<void>;
  clear: () => Promise<void>;
  setUnlocked: (value: boolean) => void;
  elevate: (pin: string) => Promise<void>;
}

const Ctx = createContext<StaffContext>({
  session: null,
  ready: false,
  unlocked: false,
  stepUp: null,
  save: async () => undefined,
  clear: async () => undefined,
  setUnlocked: () => undefined,
  elevate: async () => undefined,
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [stepUp, setStepUp] = useState<string | null>(null);

  useEffect(() => {
    store()
      .then((box) => box.getItem(KEY))
      .then((raw) => setSession(raw ? (JSON.parse(raw) as StaffSession) : null))
      .finally(() => setReady(true));
  }, []);

  const save = async (next: StaffSession) => {
    setSession(next);
    setUnlocked(false);
    await (await store()).setItem(KEY, JSON.stringify(next));
  };
  const clear = async () => {
    setSession(null);
    setUnlocked(false);
    setStepUp(null);
    await (await store()).removeItem(KEY);
  };
  const elevate = async (pin: string) => {
    if (!session) throw new Error("Sign in required");
    const res = await fetch(`${API_URL}/api/staff/v1/auth/step-up`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const body = (await res.json()) as { stepUpToken?: string; error?: { message: string } };
    if (!res.ok || !body.stepUpToken) throw new Error(body.error?.message ?? "That PIN didn't match.");
    setStepUp(body.stepUpToken);
  };

  return <Ctx.Provider value={{ session, ready, unlocked, stepUp, save, clear, setUnlocked, elevate }}>{children}</Ctx.Provider>;
}

export function useStaff() {
  return useContext(Ctx);
}
