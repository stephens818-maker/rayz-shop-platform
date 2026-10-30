/**
 * The HTML part of a marketing email, made from its plain text: an optional header image and
 * headline, paragraphs with links made clickable, the booking button in the brand's color, the
 * footer, and a 1×1 open-tracking image. It follows the reader's light or dark mode
 * (prefers-color-scheme), and the editor's preview forces either one to check both.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;

/** The brand's red, as on receipts and the booking page; a location's own accent color replaces it. */
export const BRAND_COLOR = "#c81e1e";
const HEX = /^#[0-9a-f]{6}$/i;

const PALETTE = {
  light: { bg: "#f4f4f5", card: "#ffffff", text: "#18181b", muted: "#71717a", link: "#1d4ed8", rule: "#e4e4e7" },
  dark: { bg: "#09090b", card: "#18181b", text: "#f4f4f5", muted: "#a1a1aa", link: "#93c5fd", rule: "#3f3f46" },
} as const;

/** Black or white text, whichever reads better on the button color. */
function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#18181b" : "#ffffff";
}

function paragraphs(text: string, linkColor: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.5">${esc(p).replace(/\n/g, "<br>").replace(URL_RE, (u) => `<a href="${u}" style="color:${linkColor};text-decoration:underline">${u}</a>`)}</p>`)
    .join("");
}

/**
 * `body` is the rendered plain text with the footer after "\n\n--\n" (emailFooter). `pixelUrl`
 * loads the open-tracking image; previews leave it out. `scheme` forces light or dark for previews.
 */
export function marketingEmailHtml(o: {
  subject: string;
  body: string;
  headline?: string;
  image?: { src: string; alt: string } | null;
  cta?: { label: string; url: string } | null;
  color?: string | null;
  pixelUrl?: string | null;
  scheme?: "light" | "dark" | "auto";
}): string {
  const [main, footer = ""] = o.body.split(/\n\n--\n/);
  const scheme = o.scheme ?? "auto";
  const p = PALETTE[scheme === "dark" ? "dark" : "light"];
  const d = PALETTE.dark;
  const color = o.color && HEX.test(o.color) ? o.color : BRAND_COLOR;
  const darkCss =
    scheme === "auto"
      ? `@media (prefers-color-scheme: dark){body,.bg{background:${d.bg}!important}.card{background:${d.card}!important;color:${d.text}!important}.muted{color:${d.muted}!important}a:not(.cta){color:${d.link}!important}.rule{border-color:${d.rule}!important}}`
      : "";
  const image = o.image?.src
    ? `<img src="${esc(o.image.src)}" alt="${esc(o.image.alt)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:12px 12px 0 0">`
    : "";
  const headline = o.headline?.trim() ? `<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;font-weight:700">${esc(o.headline.trim())}</h1>` : "";
  const cta = o.cta?.label.trim()
    ? `<div style="margin:8px 0 8px"><a class="cta" href="${esc(o.cta.url)}" style="display:inline-block;background:${color};color:${onColor(color)};text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${esc(o.cta.label.trim())}</a></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${scheme === "auto" ? "light dark" : scheme}"><meta name="supported-color-schemes" content="${scheme === "auto" ? "light dark" : scheme}"><title>${esc(o.subject)}</title><style>${darkCss}</style></head><body style="margin:0;padding:0;background:${p.bg}"><div class="bg" style="background:${p.bg};padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><div class="card" style="max-width:560px;margin:0 auto;background:${p.card};color:${p.text};border-radius:12px;font-size:16px">${image}<div style="padding:28px 24px">${headline}${paragraphs(main.trim(), p.link)}${cta}${footer ? `<div class="rule muted" style="border-top:1px solid ${p.rule};margin-top:24px;padding-top:16px;color:${p.muted};font-size:12px">${paragraphs(footer.trim(), p.link)}</div>` : ""}</div></div></div>${o.pixelUrl ? `<img src="${esc(o.pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : ""}</body></html>`;
}
