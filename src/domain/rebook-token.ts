/** Rebook link tokens: server-only (node:crypto), apart from src/domain/outreach.ts so client code can use the labels there. */
import { createHash, randomBytes } from "node:crypto";

/** 256 random bits, URL-safe. Only the hash is stored. */
export const newRebookToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** Anything else is refused before a lookup. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
