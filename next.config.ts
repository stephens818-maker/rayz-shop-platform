import type { NextConfig } from "next";

/** Checkout takes keyed cards only through Stripe's iframes (SAQ-A): scripts and frames come from this app and Stripe, and nothing may frame the page. */
export const CHECKOUT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com",
  "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
  "connect-src 'self' https://api.stripe.com",
  "img-src 'self' data: https://*.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  experimental: {
    // Squire CSV exports (appointment history) are uploaded through a server action.
    serverActions: { bodySizeLimit: "25mb" },
  },
  // Development needs eval for hot reload, so the policy applies to production builds only.
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/admin/checkout/:path*", headers: [{ key: "Content-Security-Policy", value: CHECKOUT_CSP }] }];
  },
};

export default nextConfig;
