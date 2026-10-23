import { browserSecureStore } from "@rayz/ui";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Platform } from "react-native";

const KEY = "rayz.customer.session";

export interface Session {
  token: string;
  refreshToken: string;
  firstName: string;
  customerId: string;
}

interface Store {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

async function nativeStore(): Promise<Store> {
  const SecureStore = await import("expo-secure-store");
  return { getItem: (key) => SecureStore.getItemAsync(key), setItem: (key, value) => SecureStore.setItemAsync(key, value), removeItem: (key) => SecureStore.deleteItemAsync(key) };
}

async function store(): Promise<Store> {
  return Platform.OS === "web" ? browserSecureStore() : nativeStore();
}

const Ctx = createContext<{ session: Session | null; ready: boolean; save: (session: Session) => Promise<void>; clear: () => Promise<void> }>({
  session: null,
  ready: false,
  save: async () => undefined,
  clear: async () => undefined,
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    store()
      .then((s) => s.getItem(KEY))
      .then((raw) => setSession(raw ? (JSON.parse(raw) as Session) : null))
      .finally(() => setReady(true));
  }, []);
  const save = async (next: Session) => {
    setSession(next);
    await (await store()).setItem(KEY, JSON.stringify(next));
  };
  const clear = async () => {
    setSession(null);
    await (await store()).removeItem(KEY);
  };
  return <Ctx.Provider value={{ session, ready, save, clear }}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}
