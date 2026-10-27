import { z, ZodType } from "zod";
import * as S from "./schemas";

const schema = (s: ZodType) => {
  const js = z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
};
const queryParams = (s: z.ZodObject) =>
  Object.entries(s.shape).map(([name, f]) => {
    const field = f as ZodType;
    const js = schema(field);
    return { name, in: "query", required: !field.safeParse(undefined).success, description: (js.description as string) ?? undefined, schema: js };
  });
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const shopHeader = { name: "X-Shop-Id", in: "header", required: false, description: 'A shop id to work in, or "all" for all their shops (where their role allows it). Their first shop when left out.', schema: { type: "string" } };
const deviceHeader = { name: "X-Clock-Device", in: "header", required: true, description: "This install's front-desk clock token, from POST /clock/kiosk/register", schema: { type: "string" } };

interface Op {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  /** Who may call it, as the brand's Roles and permissions say. */
  permission: string;
  tag: string;
  body?: ZodType;
  query?: z.ZodObject;
  params?: boolean;
  kiosk?: boolean;
  public?: boolean;
}

const OPS: Op[] = [
  { method: "post", path: "/auth/login", tag: "Sign-in", summary: "Email and password. Returns { tokens } or, with two-step sign-in, { twoFactor: { ticket, enroll? } } for /auth/login/code.", permission: "Any active staff login", body: S.LoginBody, public: true },
  { method: "post", path: "/auth/login/code", tag: "Sign-in", summary: "The authenticator code for the ticket. A wrong code is 401 with details.twoFactor to try again.", permission: "Any active staff login", body: S.LoginCodeBody, public: true },
  { method: "post", path: "/auth/refresh", tag: "Sign-in", summary: "Rotates the refresh token. Reusing an old one ends every staff app session for that person.", permission: "A live session", body: S.RefreshBody, public: true },
  { method: "post", path: "/auth/logout", tag: "Sign-in", summary: "Ends the session; its access token and its phone's pushes stop at once. 204.", permission: "A live session", body: S.RefreshBody, public: true },
  { method: "get", path: "/me", tag: "Me", summary: "Who they are, their shops, the app features they may use and every permission they hold.", permission: "Signed in" },
  { method: "get", path: "/me/notifications", tag: "Me", summary: "How they hear about their own clients' bookings, changes, cancellations and arrivals, and their phones.", permission: "Their own (not a shop login)" },
  { method: "put", path: "/me/notifications", tag: "Me", summary: "Change it. push is the app.", permission: "Their own (not a shop login)", body: S.NotificationPrefsBody },
  { method: "get", path: "/schedule", tag: "Schedule", summary: "Their working days: hours, time off, lunch and other blocks (private reasons masked), and how many are booked.", permission: "Their own (not a shop login)", query: S.ScheduleQuery },
  { method: "get", path: "/appointments", tag: "Schedule", summary: "Their own appointments over the days asked, in start order. Last names follow Client data.", permission: "Their own (not a shop login)", query: S.AppointmentsQuery },
  { method: "get", path: "/appointments/{id}", tag: "Schedule", summary: "One appointment: theirs, or anyone's at their shops with calendar.view_all or calendar.manage. Otherwise 404.", permission: "Signed in; calendar.view_all for others'", params: true },
  { method: "get", path: "/appointments/{id}/notes", tag: "Client notes", summary: "The client's notes as Client notes' permissions show them (private manager notes need notes.private). Logged as a client view.", permission: "notes.view", params: true },
  { method: "post", path: "/appointments/{id}/notes", tag: "Client notes", summary: "Add a note for the appointment's client; a cut note (kind visit) is tied to this visit. Body as POST /staff/clients/{id}/notes.", permission: "notes.view, plus the note kind's write permission", params: true },
  { method: "get", path: "/clock", tag: "Time clock", summary: "Where they stand, what they can punch next, each shop's rule (QR, NFC, Wi-Fi, location), today's punches, break reasons and whether their PIN is set.", permission: "timeclock.punch" },
  { method: "post", path: "/clock/punch", tag: "Time clock", summary: "Clock in or out from their phone with the shop's proof. { kind: confirm } asks first during time off; clocking in returns welcome (milestones).", permission: "timeclock.punch", body: S.PunchBody },
  { method: "post", path: "/clock/breaks/start", tag: "Breaks", summary: "Start a break, with a reason and planned length; the calendar blocks it.", permission: "timeclock.punch", body: S.BreakStartBody },
  { method: "post", path: "/clock/breaks/end", tag: "Breaks", summary: "End the break.", permission: "timeclock.punch", body: S.BreakEndBody },
  { method: "put", path: "/clock/pin", tag: "Time clock", summary: "Set their own PIN for the front-desk clock.", permission: "timeclock.punch", body: S.PinBody },
  { method: "post", path: "/clock/kiosk/register", tag: "Front-desk clock", summary: "Make this install one of a shop's front-desk clocks. The token is returned once; send it as X-Clock-Device.", permission: "settings.shop", body: S.KioskRegisterBody },
  { method: "get", path: "/clock/kiosk/team", tag: "Front-desk clock", summary: "Who can punch here.", permission: "timeclock.kiosk", kiosk: true },
  { method: "get", path: "/clock/kiosk/qr", tag: "Front-desk clock", summary: "The link to draw as the QR code phones scan. It changes every 30 seconds.", permission: "timeclock.kiosk", kiosk: true },
  { method: "post", path: "/clock/kiosk/status", tag: "Front-desk clock", summary: "Their PIN, then what they can punch next. Five wrong PINs lock theirs for five minutes.", permission: "timeclock.kiosk", body: S.KioskStatusBody, kiosk: true },
  { method: "post", path: "/clock/kiosk/punch", tag: "Front-desk clock", summary: "Punch (in, out, break start or end) as the person whose PIN was typed.", permission: "timeclock.kiosk", body: S.KioskPunchBody, kiosk: true },
  { method: "get", path: "/tips", tag: "Tips and pay", summary: "Their tips (S3): today, settling, ready, in a payout, paid out; how each shop pays them; history by ticket.", permission: "tips.own", query: S.TipsQuery },
  { method: "get", path: "/payouts", tag: "Tips and pay", summary: "Their tip payouts: method, status and what they got after fees.", permission: "tips.own" },
  { method: "get", path: "/earnings", tag: "Tips and pay", summary: "Day by day: net sales (report.my_sales.view with reports.money), tips (tips.own) and commission (compensation.own, where the brand has compensation on). Parts they may not see are null.", permission: "Any of those", query: S.EarningsQuery },
  {
    method: "get",
    path: "/banking",
    tag: "Banking",
    summary:
      "Their Stripe Connect Express account: the account id, status, onboarding step (start, resume, update or done), Stripe's requirements (due, pending, deadline), the default card or bank's type, name and last 4, and instant payouts (allowed, the card they go to, the fee and who pays it). Never a number.",
    permission: "tips.own",
    query: S.BankingQuery,
  },
  { method: "get", path: "/banking/external-accounts", tag: "Banking", summary: "Every bank account and debit card on their Stripe account: type, bank or brand name, last 4, which is the default and which takes instant payouts. Never a number. ?refresh=1 reads Stripe first.", permission: "tips.own", query: S.BankingQuery },
  {
    method: "post",
    path: "/banking/onboarding-link",
    tag: "Banking",
    summary:
      "Starts or resumes Stripe's hosted onboarding for their own Express account (identity, bank account, debit card for instant payouts), or opens it for what Stripe asks for later. step says which. Open url in the browser; Stripe returns to /staff-app/stripe. url is null in the simulator, where setup finishes at once. Stripe test mode only unless MONEY_MOVEMENT_LIVE is on.",
    permission: "tips.own",
  },
  { method: "post", path: "/banking/dashboard-link", tag: "Banking", summary: "A one-time sign-in to their Stripe Express dashboard, where they change the card or bank and see Stripe's payouts.", permission: "tips.own" },
  { method: "put", path: "/banking/method", tag: "Banking", summary: "How they're paid, where the brand lets them choose. Sends a security notice.", permission: "tips.own", body: S.PayoutMethodBody },
  { method: "get", path: "/popups", tag: "Pop-ups", summary: "Milestones they haven't seen, a clock-in reminder when their first client or shift starts within 30 minutes, and an old open shift.", permission: "Signed in" },
  { method: "post", path: "/popups/seen", tag: "Pop-ups", summary: "Milestones shown: they won't pop up again here or on the web.", permission: "Their own", body: S.SeenBody },
  { method: "get", path: "/devices", tag: "Push", summary: "Their phones registered for push.", permission: "Their own" },
  { method: "post", path: "/devices", tag: "Push", summary: "Register this phone's push token for their own clients' new, changed and cancelled bookings. A first phone turns those on when they've never chosen.", permission: "Their own", body: S.DeviceBody },
  { method: "patch", path: "/devices/{id}", tag: "Push", summary: "A rotated token, notification permission or app version.", permission: "Their own", body: S.DevicePatch, params: true },
  { method: "delete", path: "/devices/{id}", tag: "Push", summary: "Stop pushes to the phone. 204.", permission: "Their own", params: true },
];

/** The staff app's API as OpenAPI 3.1, for the app builder. */
export function staffOpenApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    const parameters = [...(op.params ? [idParam] : []), ...(op.query ? queryParams(op.query) : []), ...(op.public ? [] : [shopHeader]), ...(op.kiosk ? [deviceHeader] : [])];
    (paths[op.path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: `Permission: ${op.permission}.`,
      ...(op.public ? { security: [] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(op.body) } } } } : {}),
      responses: {
        ...(op.method === "delete" || op.path === "/auth/logout" ? { "204": { description: "Done" } } : { "200": { description: "OK" } }),
        "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Sign in required" },
        "403": { description: "Their role or the location's sign-in rule doesn't allow it" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Ray'z Staff app API",
      version: "1",
      description:
        "For the Ray'z Staff app (replacing Squire Commander). Separate from the customer API at /api/v1. Sign in with email and password (and the authenticator code where set up), then send Authorization: Bearer <accessToken>. Access tokens last an hour; refresh with the rotating refresh token. Roles, permissions, Client data masking and each location's sign-in rule are enforced on the server on every request.",
    },
    servers: [{ url: `${baseUrl}/api/staff/v1` }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] } },
          required: ["error"],
        },
      },
    },
    security: [{ bearer: [] }],
    paths,
  };
}

export const STAFF_API_PATHS = OPS.map((o) => `${o.method.toUpperCase()} ${o.path}`);
