import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./generated/v1";
import { earningsSearch } from "./query";
import type {
  AppConfig,
  EarningsDaysResponse,
  EarningsQuery,
  EarningsResponse,
  EarningsTicketsResponse,
  PayoutAccount,
  PayoutsResponse,
  PayPeriodListItem,
  PaymentPreview,
  StaffConfig,
} from "./types";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
}

async function read<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { ok: true, status: 204, data: null, error: null };
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | T | null;
  if (!res.ok) {
    const err = body && typeof body === "object" && "error" in body ? body.error : undefined;
    return { ok: false, status: res.status, data: null, error: err ?? { code: "internal", message: res.statusText } };
  }
  return { ok: true, status: res.status, data: body as T, error: null };
}

function authHeaders(token: string | null, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { "content-type": "application/json", "x-client": "ios", "x-app-version": "3.0.0", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function createCustomerClient(baseUrl: string, getToken: () => string | null) {
  const middleware: Middleware = {
    onRequest({ request }) {
      const token = getToken();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      request.headers.set("X-Client", "ios");
      request.headers.set("X-App-Version", "3.0.0");
      return request;
    },
  };
  const v1 = createClient<paths>({ baseUrl: `${baseUrl.replace(/\/$/, "")}/api/v1` });
  v1.use(middleware);
  const root = baseUrl.replace(/\/$/, "");

  async function send<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
    const res = await fetch(`${root}${path}`, { ...init, headers: { ...authHeaders(getToken()), ...(init?.headers ?? {}) } });
    return read<T>(res);
  }

  return {
    raw: v1,
    config: () => send<AppConfig>("/api/v1/app/config"),
    home: () => send<Record<string, unknown>>("/api/v1/me/home"),
    paymentPreview: (code: string, body: unknown) =>
      send<PaymentPreview>(`/api/v1/appointments/${code}/payment-preview`, { method: "POST", body: JSON.stringify(body) }),
    pay: (code: string, body: unknown, idempotencyKey: string) =>
      send<Record<string, unknown>>(`/api/v1/appointments/${code}/payments`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    send,
  };
}

export function createStaffClient(baseUrl: string, getToken: () => string | null, getStepUp: () => string | null = () => null) {
  const root = baseUrl.replace(/\/$/, "");

  async function send<T>(path: string, init?: RequestInit, stepUp = false): Promise<ApiResult<T>> {
    const extra: Record<string, string> = { "x-client": "ios", "x-app-version": "1.0.0" };
    const step = getStepUp();
    if (stepUp && step) extra["x-step-up"] = step;
    const res = await fetch(`${root}${path}`, { ...init, headers: { ...authHeaders(getToken(), extra), ...(init?.headers ?? {}) } });
    return read<T>(res);
  }

  const earningsPath = (suffix: string, query: EarningsQuery) => `/api/staff/v1/me/earnings${suffix}?${earningsSearch(query)}`;

  return {
    config: () => send<StaffConfig>("/api/staff/v1/config"),
    earnings: (query: EarningsQuery) => send<EarningsResponse>(earningsPath("", query), undefined, true),
    earningsDays: (query: EarningsQuery) => send<EarningsDaysResponse>(earningsPath("/days", query), undefined, true),
    earningsTickets: (query: EarningsQuery, date?: string) => {
      const base = earningsPath("/tickets", query);
      const path = date ? `${base}&date=${date}` : base;
      return send<EarningsTicketsResponse>(path, undefined, true);
    },
    payouts: (query: EarningsQuery) => send<PayoutsResponse>(`/api/staff/v1/me/payouts?${earningsSearch(query)}`, undefined, true),
    payPeriods: () => send<{ periods: PayPeriodListItem[] }>("/api/staff/v1/me/pay-periods", undefined, true),
    payrollReport: async (query: EarningsQuery, format: "csv" | "pdf") => {
      const res = await fetch(`${root}/api/staff/v1/me/earnings/report?${earningsSearch(query)}&format=${format}`, {
        headers: authHeaders(getToken(), { "x-step-up": getStepUp() ?? "", "x-client": "ios", "x-app-version": "1.0.0" }),
      });
      return { ok: res.ok, status: res.status, body: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
    },
    payoutAccount: () => send<{ account: PayoutAccount }>("/api/staff/v1/me/payout-account"),
    send,
  };
}
