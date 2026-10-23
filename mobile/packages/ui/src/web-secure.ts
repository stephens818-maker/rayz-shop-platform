/**
 * Web tokens stay out of localStorage. The key is non-extractable AES-GCM.
 * Ciphertext lives in the supplied store (sessionStorage in the browser).
 */

export interface KeyValueStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function sealToken(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return JSON.stringify({ iv: bytesToBase64(iv), data: bytesToBase64(data) });
}

export async function openToken(key: CryptoKey, sealed: string): Promise<string> {
  const parsed = JSON.parse(sealed) as { iv: string; data: string };
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(parsed.iv) }, key, base64ToBytes(parsed.data));
  return new TextDecoder().decode(plain);
}

export function createSecureTokenStore(storage: KeyValueStore, key: () => Promise<CryptoKey>) {
  return {
    async getItem(name: string) {
      const sealed = storage.getItem(name);
      if (!sealed) return null;
      return openToken(await key(), sealed);
    },
    async setItem(name: string, value: string) {
      storage.setItem(name, await sealToken(await key(), value));
    },
    async removeItem(name: string) {
      storage.removeItem(name);
    },
  };
}

const DB_NAME = "rayz-secure";
const KEY_ID = "token-key";

function browserKey(): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Secure storage is unavailable"));
      return;
    }
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error ?? new Error("Secure storage is unavailable"));
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction("keys").objectStore("keys").get(KEY_ID);
      read.onsuccess = () => {
        if (read.result) {
          resolve(read.result as CryptoKey);
          return;
        }
        void crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]).then((created) => {
          const write = db.transaction("keys", "readwrite").objectStore("keys").put(created, KEY_ID);
          write.onsuccess = () => resolve(created);
          write.onerror = () => reject(write.error ?? new Error("Secure storage is unavailable"));
        });
      };
      read.onerror = () => reject(read.error ?? new Error("Secure storage is unavailable"));
    };
  });
}

export function browserSecureStore() {
  return createSecureTokenStore(sessionStorage, browserKey);
}
