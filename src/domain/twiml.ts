/** TwiML, the XML Twilio runs for a call or answers a text with. Pure string building, escaped. */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const attrs = (a: Record<string, string | number | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");

export const say = (text: string) => `<Say voice="Polly.Joanna">${esc(text)}</Say>`;
export const pause = (seconds: number) => `<Pause length="${seconds}"/>`;
export const hangup = () => "<Hangup/>";
/** `speech`: the caller can also talk; Twilio posts what it heard as SpeechResult. */
export const gather = (a: { action: string; numDigits?: number; timeout?: number; speech?: { hints: string } }, ...inner: string[]) =>
  `<Gather${attrs({ action: a.action, method: "POST", numDigits: a.numDigits ?? 1, timeout: a.timeout ?? 6, ...(a.speech ? { input: "dtmf speech", speechTimeout: "auto", hints: a.speech.hints, language: "en-US" } : {}) })}>${inner.join("")}</Gather>`;
export const dial = (a: { callerId?: string | null; timeout?: number; action?: string }, number: string) =>
  `<Dial${attrs({ callerId: a.callerId ?? undefined, timeout: a.timeout, action: a.action, method: a.action ? "POST" : undefined })}>${esc(number)}</Dial>`;
/** Continues the call at another webhook, as when a Gather times out with no key pressed. */
export const redirect = (url: string) => `<Redirect method="POST">${esc(url)}</Redirect>`;
export const message = (text: string) => `<Message>${esc(text)}</Message>`;

export const response = (...verbs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;
export const EMPTY_RESPONSE = response();
