import { DEEP_LINK_PARAMS } from "@/domain/location-profile";

/**
 * The booking widget for any website:
 *
 *   <div data-rayz-booking data-location="le-claire"></div>            inline booking frame
 *   <button data-rayz-book data-location="le-claire">Book now</button>  opens it over the page
 *   <script src="https://<site>/widget.js" async></script>
 *
 * Optional data-service (slug or ID), data-barber (slug), data-start (ISO time) and data-coupon
 * pre-fill it, the same as the deep link. Without data-location it asks which shop. The frame grows
 * with its content, and a "rayz:booked" event (detail: { location }) fires on the element and window
 * after a booking. Also window.RayzBooking.open({ location, service, … }) and .mount(el, options).
 */
const SCRIPT = `(function () {
  if (window.RayzBooking) return;
  var me = document.currentScript;
  var BASE = me && me.src ? new URL(me.src).origin : location.origin;
  var PARAMS = ${JSON.stringify(DEEP_LINK_PARAMS)};
  function src(o) {
    var loc = o.location && /^[a-z0-9-]{1,60}$/.test(o.location) ? "/" + o.location : "";
    var q = new URLSearchParams();
    PARAMS.forEach(function (k) { if (o[k]) q.set(k, String(o[k])); });
    var s = q.toString();
    return BASE + "/embed/book" + loc + (s ? "?" + s : "");
  }
  function opts(el, extra) {
    var o = {};
    ["location"].concat(PARAMS).forEach(function (k) { var v = el.getAttribute("data-" + k); if (v) o[k] = v; });
    for (var k in extra || {}) o[k] = extra[k];
    return o;
  }
  var frames = [];
  function frame(o, host) {
    var f = document.createElement("iframe");
    f.src = src(o);
    f.title = "Book at Ray'z Barber Shop";
    f.setAttribute("allow", "geolocation; payment");
    f.style.cssText = "display:block;width:100%;border:0;min-height:640px;background:transparent;color-scheme:light";
    frames.push({ f: f, host: host });
    return f;
  }
  window.addEventListener("message", function (e) {
    if (e.origin !== BASE || !e.data || typeof e.data.type !== "string") return;
    frames.forEach(function (x) {
      if (x.f.contentWindow !== e.source) return;
      if (e.data.type === "rayz:height" && typeof e.data.height === "number" && !x.modal) x.f.style.height = Math.max(320, Math.min(e.data.height, 20000)) + "px";
      if (e.data.type === "rayz:booked") {
        var detail = { location: String(e.data.location || "") };
        x.host.dispatchEvent(new CustomEvent("rayz:booked", { detail: detail, bubbles: true }));
        if (x.host !== window) window.dispatchEvent(new CustomEvent("rayz:booked", { detail: detail }));
      }
    });
  });
  function mount(el, extra) {
    if (el.getAttribute("data-rayz-mounted")) return;
    el.setAttribute("data-rayz-mounted", "1");
    el.appendChild(frame(opts(el, extra), el));
  }
  function open(o, host) {
    var back = document.createElement("div");
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.setAttribute("aria-label", "Book an appointment");
    back.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(17,19,24,.6);display:flex;align-items:center;justify-content:center;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:100%;max-width:720px;height:min(90vh,900px);background:#fafafa;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)";
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\\u00d7";
    close.style.cssText = "position:absolute;top:8px;right:8px;z-index:1;width:36px;height:36px;border:0;border-radius:18px;background:#111318;color:#fff;font-size:22px;line-height:36px;cursor:pointer";
    var f = frame(o, host || window);
    frames[frames.length - 1].modal = true;
    f.style.height = "100%";
    f.style.minHeight = "0";
    box.appendChild(close);
    box.appendChild(f);
    back.appendChild(box);
    var prev = document.activeElement;
    function done() {
      back.remove();
      frames = frames.filter(function (x) { return x.f !== f; });
      document.removeEventListener("keydown", esc);
      if (prev && prev.focus) prev.focus();
    }
    function esc(e) { if (e.key === "Escape") done(); }
    close.addEventListener("click", done);
    back.addEventListener("click", function (e) { if (e.target === back) done(); });
    document.addEventListener("keydown", esc);
    document.body.appendChild(back);
    close.focus();
    return { close: done };
  }
  function scan() {
    document.querySelectorAll("[data-rayz-booking]").forEach(function (el) { mount(el); });
    document.querySelectorAll("[data-rayz-book]").forEach(function (el) {
      if (el.getAttribute("data-rayz-mounted")) return;
      el.setAttribute("data-rayz-mounted", "1");
      el.addEventListener("click", function (e) { e.preventDefault(); open(opts(el), el); });
    });
  }
  window.RayzBooking = { open: function (o) { return open(o || {}); }, mount: function (el, o) { mount(el, o || {}); }, scan: scan, url: src };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
