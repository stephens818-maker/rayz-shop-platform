import { z, ZodType } from "zod";
import * as S from "./api-schemas";

const schema = (s: ZodType) => {
  const js = z.toJSONSchema(s, { unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (name: string) => ({ "application/json": { schema: ref(name) } });
const err = (description: string) => ({ description, content: jsonContent("Error") });
const ok = (name: string, description = "OK") => ({ description, content: jsonContent(name) });

const shopParam = { name: "shop", in: "path", required: true, description: "Shop slug (e.g. coralville) or ID", schema: { type: "string" } };
const codeParam = { name: "code", in: "path", required: true, description: "Appointment code", schema: { type: "string" } };
const queryParams = (s: z.ZodObject) =>
  Object.entries(s.shape).map(([name, f]) => {
    const field = f as ZodType;
    const js = schema(field);
    return { name, in: "query", required: !field.safeParse(undefined).success, description: (js.description as string) ?? undefined, schema: js };
  });

export function openApiDocument(baseUrl: string) {
  const components = {
    Error: S.ErrorBody,
    Shop: S.Shop,
    ShopList: S.ShopList,
    Service: S.Service,
    ServiceList: S.ServiceList,
    Barber: S.Barber,
    BarberList: S.BarberList,
    Availability: S.Availability,
    AvailableDays: S.AvailableDays,
    CreateAppointment: S.CreateAppointment,
    Appointment: S.Appointment,
    AppointmentEnvelope: S.AppointmentEnvelope,
    AppointmentList: S.AppointmentList,
    CancelBody: S.CancelBody,
    RescheduleBody: S.RescheduleBody,
    OtpStart: S.OtpStart,
    OtpStartResponse: S.OtpStartResponse,
    OtpVerify: S.OtpVerify,
    TokenResponse: S.TokenResponse,
    NeedsProfile: S.NeedsProfile,
    ChooseProfile: S.ChooseProfile,
    OtpComplete: S.OtpComplete,
    RefreshBody: S.RefreshBody,
    RefreshResponse: S.RefreshResponse,
    Me: S.Me,
    UpdateMe: S.UpdateMe,
    Loyalty: S.Loyalty,
  };
  const bearer = [{ bearerAuth: [] }];
  const optionalBearer = [{}, { bearerAuth: [] }];

  return {
    openapi: "3.1.0",
    info: {
      title: "Ray'z Barber Shop API",
      version: "1.0.0",
      description: [
        "Public booking + customer API used by rayzbs.com booking pages and the future iOS/Android app.",
        "",
        "**Auth:** customers sign in with a one-time code (SMS or email) → `accessToken` (JWT, 1 hour) + rotating `refreshToken` (60 days).",
        "Send `Authorization: Bearer <accessToken>`. Refresh with `POST /auth/refresh`; reusing an old refresh token revokes all sessions.",
        "",
        "**Time:** timestamps are stored and returned as ISO-8601 UTC. Human text (receipts, reminders, SMS) uses America/Chicago. GET /app/config returns timeFormat (default 12h) so apps can match.",
        "**Launch:** GET /app/config returns launched and launchAt (ISO UTC, or null). Customer booking, customer payments, and push stay closed until that instant. A build older than minVersion / forceUpdateBelow gets 426 upgrade_required. Fields added after 1.0.0 are additive.",
        "**Money:** integer cents. **Privacy:** barbers are exposed by first name / admin label only; URLs never contain surnames.",
        "**Retries:** `POST /appointments` honors an `Idempotency-Key` header so a flaky mobile network can't double-book.",
      ].join("\n"),
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    tags: [
      { name: "Shops" },
      { name: "Booking" },
      { name: "Auth" },
      { name: "Me" },
    ],
    paths: {
      "/shops": { get: { tags: ["Shops"], summary: "List shops", responses: { 200: ok("ShopList") } } },
      "/shops/{shop}": { get: { tags: ["Shops"], summary: "Get a shop", parameters: [shopParam], responses: { 200: ok("Shop"), 404: err("Not found") } } },
      "/shops/{shop}/services": {
        get: { tags: ["Shops"], summary: "Services and add-ons at a shop (shop prices/durations applied)", parameters: [shopParam], responses: { 200: ok("ServiceList") } },
      },
      "/shops/{shop}/barbers": {
        get: { tags: ["Shops"], summary: "Barbers taking online bookings at a shop (may be empty)", parameters: [shopParam], responses: { 200: ok("BarberList") } },
      },
      "/shops/{shop}/availability": {
        get: {
          tags: ["Booking"],
          summary: "Open start times for a day",
          description: "Accounts for shop hours, closures, barber weekly hours, time blocks, and the barber's appointments at every shop.",
          parameters: [shopParam, ...queryParams(S.AvailabilityQuery)],
          responses: { 200: ok("Availability"), 400: err("Invalid query"), 404: err("Unknown shop/service/barber") },
        },
      },
      "/shops/{shop}/available-days": {
        get: { tags: ["Booking"], summary: "Slot counts for a run of days (date picker)", parameters: [shopParam, ...queryParams(S.AvailableDaysQuery)], responses: { 200: ok("AvailableDays") } },
      },
      "/appointments": {
        post: {
          tags: ["Booking"],
          summary: "Book an appointment",
          security: optionalBearer,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          requestBody: { required: true, content: jsonContent("CreateAppointment") },
          responses: { 201: ok("AppointmentEnvelope", "Booked"), 400: err("Invalid"), 409: err("Slot no longer available") },
        },
      },
      "/appointments/{code}": {
        get: { tags: ["Booking"], summary: "Get an appointment by code", parameters: [codeParam], responses: { 200: ok("AppointmentEnvelope"), 404: err("Not found") } },
      },
      "/appointments/{code}/cancel": {
        post: {
          tags: ["Booking"],
          summary: "Cancel (up to the shop's cutoff, 30 minutes by default)",
          security: optionalBearer,
          parameters: [codeParam],
          requestBody: { required: false, content: jsonContent("CancelBody") },
          responses: { 200: ok("AppointmentEnvelope"), 409: err("Already cancelled/completed"), 422: err("Inside the cancellation cutoff") },
        },
      },
      "/appointments/{code}/reschedule": {
        post: {
          tags: ["Booking"],
          summary: "Move to a new time (and optionally barber)",
          security: optionalBearer,
          parameters: [codeParam],
          requestBody: { required: true, content: jsonContent("RescheduleBody") },
          responses: { 200: ok("AppointmentEnvelope"), 409: err("Slot unavailable"), 422: err("Inside the cutoff") },
        },
      },
      "/auth/otp/start": {
        post: { tags: ["Auth"], summary: "Send a sign-in code", requestBody: { required: true, content: jsonContent("OtpStart") }, responses: { 200: ok("OtpStartResponse"), 429: err("Rate limited") } },
      },
      "/auth/otp/verify": {
        post: {
          tags: ["Auth"],
          summary: "Exchange the code for tokens",
          description:
            "One profile on this phone/email: tokens. None: `{needsProfile: true, selectionToken}`. Several (families share phones): `{chooseProfile: true, selectionToken, profiles}`. Finish either case with /auth/otp/complete; the code is not needed again. Sending firstName here does the same matching up front.",
          requestBody: { required: true, content: jsonContent("OtpVerify") },
          responses: {
            200: { description: "Tokens, needsProfile, or chooseProfile", content: { "application/json": { schema: { oneOf: [ref("TokenResponse"), ref("NeedsProfile"), ref("ChooseProfile")] } } } },
            401: err("Bad/expired code"),
          },
        },
      },
      "/auth/otp/complete": {
        post: {
          tags: ["Auth"],
          summary: "Pick a profile or create one after verifying a code",
          requestBody: { required: true, content: jsonContent("OtpComplete") },
          responses: { 200: ok("TokenResponse"), 401: err("Selection expired"), 403: err("Profile isn't on this phone/email") },
        },
      },
      "/auth/refresh": { post: { tags: ["Auth"], summary: "Rotate tokens", requestBody: { required: true, content: jsonContent("RefreshBody") }, responses: { 200: ok("RefreshResponse"), 401: err("Invalid") } } },
      "/auth/logout": { post: { tags: ["Auth"], summary: "Revoke a refresh token", requestBody: { required: true, content: jsonContent("RefreshBody") }, responses: { 204: { description: "Revoked" } } } },
      "/me": {
        get: { tags: ["Me"], summary: "Current customer", security: bearer, responses: { 200: ok("Me"), 401: err("Sign in required") } },
        patch: { tags: ["Me"], summary: "Update profile / notification preferences", security: bearer, requestBody: { required: true, content: jsonContent("UpdateMe") }, responses: { 200: ok("Me") } },
      },
      "/me/appointments": { get: { tags: ["Me"], summary: "My upcoming and past appointments", security: bearer, responses: { 200: ok("AppointmentList") } } },
      "/me/loyalty": { get: { tags: ["Me"], summary: "Loyalty progress and available rewards (brand-wide)", security: bearer, responses: { 200: ok("Loyalty") } } },
      "/me/devices": {
        get: { tags: ["Me"], summary: "Push devices registered for this profile", security: bearer, responses: { 200: { description: "Devices" } } },
        post: { tags: ["Me"], summary: "Register an APNs, FCM, or Expo push token", security: bearer, responses: { 201: { description: "Registered" } } },
      },
      "/me/devices/{id}": {
        delete: { tags: ["Me"], summary: "Revoke one push device", security: bearer, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Revoked" } } },
      },
      "/app/config": {
        get: {
          tags: ["Shops"],
          summary: "App config: timeFormat, launch gate, and the minimum version. New fields are additive.",
          responses: { 200: { description: "Config" }, 426: err("App version is below forceUpdateBelow") },
        },
      },
      "/me/purchases": {
        get: { tags: ["Me"], summary: "Purchase history with service, product, tax, and tip kept separate, plus refund records", security: bearer, responses: { 200: { description: "Purchases" } } },
      },
      "/me/purchases/receipt": {
        get: { tags: ["Me"], summary: "Receipt text for one sale. format=pdf returns a PDF. Refunds stay separate.", security: bearer, responses: { 200: { description: "Receipt" } } },
      },
      "/internal/connect/onboard": {
        post: {
          tags: ["Me"],
          summary: "Hosted Stripe Connect onboarding for a shop (test mode, internal secret)",
          responses: { 200: { description: "Account link" }, 401: err("Not authorized") },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, schema(v)])),
    },
  };
}
