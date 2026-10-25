/**
 * The HTML part of a marketing email, made from its plain text: paragraphs, links made clickable,
 * the footer, and a 1×1 open-tracking image. It follows the reader's light or dark mode
 * (prefers-color-scheme), and the editor's preview forces either one to check both.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;

const PALETTE = {
  light: { bg: "#f4f4f5", card: "#ffffff", text: "#18181b", muted: "#71717a", link: "#1d4ed8", rule: "#e4e4e7" },
  dark: { bg: "#09090b", card: "#18181b", text: "#f4f4f5", muted: "#a1a1aa", link: "#93c5fd", rule: "#3f3f46" },
} as const;

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
export function marketingEmailHtml(o: { subject: string; body: string; pixelUrl?: string | null; scheme?: "light" | "dark" | "auto" }): string {
  const [main, footer = ""] = o.body.split(/\n\n--\n/);
  const scheme = o.scheme ?? "auto";
  const p = PALETTE[scheme === "dark" ? "dark" : "light"];
  const d = PALETTE.dark;
  const darkCss =
    scheme === "auto"
      ? `@media (prefers-color-scheme: dark){body,.bg{background:${d.bg}!important}.card{background:${d.card}!important;color:${d.text}!important}.muted{color:${d.muted}!important}a{color:${d.link}!important}.rule{border-color:${d.rule}!important}}`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${scheme === "auto" ? "light dark" : scheme}"><meta name="supported-color-schemes" content="${scheme === "auto" ? "light dark" : scheme}"><title>${esc(o.subject)}</title><style>${darkCss}</style></head><body style="margin:0;padding:0;background:${p.bg}"><div class="bg" style="background:${p.bg};padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><div class="card" style="max-width:560px;margin:0 auto;background:${p.card};color:${p.text};border-radius:12px;padding:28px 24px;font-size:16px">${paragraphs(main.trim(), p.link)}${footer ? `<div class="rule muted" style="border-top:1px solid ${p.rule};margin-top:24px;padding-top:16px;color:${p.muted};font-size:12px">${paragraphs(footer.trim(), p.link)}</div>` : ""}</div></div>${o.pixelUrl ? `<img src="${esc(o.pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : ""}</body></html>`;
}
