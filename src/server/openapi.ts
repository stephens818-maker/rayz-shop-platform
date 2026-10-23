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
    RegisterDevice: S.RegisterDevice,
    DeviceList: S.DeviceList,
    DeviceRegistered: S.DeviceRegistered,
    DeviceRevoked: S.DeviceRevoked,
    AppConfig: S.AppConfig,
    Home: S.Home,
    FamilyList: S.FamilyList,
    AddFamilyMember: S.AddFamilyMember,
    FamilyCreated: S.FamilyCreated,
    CardList: S.CardList,
    SetupCard: S.SetupCard,
    SetupCardResponse: S.SetupCardResponse,
    ReceiptList: S.ReceiptList,
    CustomerReceipt: S.CustomerReceipt,
    ReceiptMissing: S.ReceiptMissing,
    DeleteStartResponse: S.DeleteStartResponse,
    DeleteConfirm: S.DeleteConfirm,
    DeleteConfirmResponse: S.DeleteConfirmResponse,
    PaymentRequest: S.PaymentRequest,
    PaymentBreakdown: S.PaymentBreakdown,
    PaymentIntentSheet: S.PaymentIntentSheet,
    PaymentPreview: S.PaymentPreview,
    PaymentResult: S.PaymentResult,
    LiveWait: S.LiveWait,
    PurchaseList: S.PurchaseList,
    PurchaseReceipt: S.PurchaseReceipt,
    StaffConnect: S.StaffConnect,
    StaffOnboardRequest: S.StaffOnboardRequest,
    StaffOnboard: S.StaffOnboard,
    ConnectOnboardRequest: S.ConnectOnboardRequest,
    ConnectOnboard: S.ConnectOnboard,
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
        "**Launch:** GET /app/config returns the brand launched flag and launchAt, plus shops[] with each shop's own launched flag. A shop stays on Squire until its own instant. closedCopy is the sentence to show instead of a booking form. Customer booking, customer payments, and push for that shop stay closed. A build older than minVersion / forceUpdateBelow gets 426 upgrade_required. Fields added after 1.0.0 are additive.",
        "**Money:** integer cents. Purchase history and receipts add the shop and tip split when the Connect ledger has one. A transferred tip reads as paid to the barber's first name. A refund record names which portion it came from, and that portion is the shop's. Ticket service, product, tax, and tip stay separate. **Privacy:** barbers are exposed by first name / admin label only; URLs never contain surnames.",
        "**Retries:** `POST /appointments` and `POST /appointments/{code}/payments` honor an `Idempotency-Key` header so a flaky mobile network can't double-book or double-charge.",
        "**Cards:** saved cards use a Stripe SetupIntent and PaymentSheet ephemeral key. Card numbers are not accepted. The customer app pays only through POST /appointments/{code}/payment-intents, then Stripe confirms that intent on the device with the saved PaymentMethod, then POST /appointments/{code}/payments with { paymentIntentId }. There is no confirm route. A bare card id on the customer payments route is 400. Staff POS and web checkout still charge on the server through chargeCard. Wallet and funding come from the PaymentMethod (card.wallet, card.funding). A value sent by the client is ignored. The priced breakdown, including the tip, is stored on the intent and a checkout row. The payment-intents response includes clientSecret, ephemeralKey, customerId, amountCents, currency, and breakdown. POST /payments checks that breakdown and never uses a tip sent by the app. A different card on an unconfirmed intent is repriced so the device confirms the new amount. An intent that is still processing or requires_action returns 409 with details.status and is not refunded. A succeeded charge that does not match is refunded and logged. A credit surcharge is sent to Stripe as its own line. The label is Credit card surcharge (3%) at the shop's rate, which stays configurable. Debit, including a debit card in Apple Pay or Google Pay, is not surcharged. FEATURE_WALLET_FEE is on only when it is exactly true. Live Stripe keys are refused unless STRIPE_MODE=live.",
        "**SMS:** smsOptIn defaults to false. consentTextVersion is required to opt in. A customer who opted out can opt back in by sending smsOptIn true with a new consentTextVersion. That stores a new consent record.",
        "**Calendar:** GET /app/config returns weekStartDay sunday and timeZone America/Chicago. Payroll weeks are unchanged.",
        "**Privacy:** GET /me returns the customer's own last name. Sign-in profiles and staff surfaces are first names only.",
      ].join("\n"),
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    tags: [
      { name: "Shops" },
      { name: "Booking" },
      { name: "Auth" },
      { name: "Me" },
      { name: "Staff" },
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
        patch: {
          tags: ["Me"],
          summary: "Update profile / notification preferences",
          description:
            "smsOptIn defaults to false. consentTextVersion is required to turn a channel on. A customer who opted out can opt back in: send smsOptIn true with a new consentTextVersion. That writes another consent record. An opt-out does not need a version. Booking and import cannot turn texts back on.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("UpdateMe") },
          responses: { 200: ok("Me") },
        },
      },
      "/me/appointments": { get: { tags: ["Me"], summary: "My upcoming and past appointments", security: bearer, responses: { 200: ok("AppointmentList") } } },
      "/me/loyalty": { get: { tags: ["Me"], summary: "Loyalty progress and available rewards (brand-wide)", security: bearer, responses: { 200: ok("Loyalty") } } },
      "/me/devices": {
        get: { tags: ["Me"], summary: "Push devices registered for this profile", security: bearer, responses: { 200: ok("DeviceList") } },
        post: { tags: ["Me"], summary: "Register an APNs, FCM, or Expo push token", security: bearer, requestBody: { required: true, content: jsonContent("RegisterDevice") }, responses: { 201: ok("DeviceRegistered", "Registered") } },
      },
      "/me/devices/{id}": {
        delete: { tags: ["Me"], summary: "Revoke one push device", security: bearer, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: ok("DeviceRevoked", "Revoked") } },
      },
      "/app/config": {
        get: {
          tags: ["Shops"],
          summary: "App config: timeFormat, weekStartDay sunday, timeZone America/Chicago, launch gate, and the minimum version. New fields are additive.",
          responses: { 200: ok("AppConfig"), 426: err("App version is below forceUpdateBelow") },
        },
      },
      "/me/home": { get: { tags: ["Me"], summary: "Next visit, rebook, loyalty, family, and favorite shop", security: bearer, responses: { 200: ok("Home"), 401: err("Sign in required") } } },
      "/me/family": {
        get: { tags: ["Me"], summary: "Family members on this profile. First names only.", security: bearer, responses: { 200: ok("FamilyList"), 401: err("Sign in required") } },
        post: { tags: ["Me"], summary: "Add a family member. Six is the cap.", security: bearer, requestBody: { required: true, content: jsonContent("AddFamilyMember") }, responses: { 201: ok("FamilyCreated", "Created"), 400: err("Cap reached") } },
      },
      "/me/family/{id}": {
        delete: { tags: ["Me"], summary: "Remove a family member", security: bearer, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 204: { description: "Removed" }, 404: err("Not found") } },
      },
      "/me/payment-methods": { get: { tags: ["Me"], summary: "Saved cards. No card numbers.", security: bearer, responses: { 200: ok("CardList") } } },
      "/me/payment-methods/setup": {
        post: { tags: ["Me"], summary: "SetupIntent and PaymentSheet ephemeral key", security: bearer, requestBody: { required: true, content: jsonContent("SetupCard") }, responses: { 200: ok("SetupCardResponse"), 400: err("Card number refused") } },
      },
      "/me/payment-methods/{id}": {
        delete: { tags: ["Me"], summary: "Detach a saved card", security: bearer, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 204: { description: "Detached" }, 404: err("Not found") } },
      },
      "/me/receipts": { get: { tags: ["Me"], summary: "Receipt list. limit and cursor page the list. Refunds are not folded into the total.", security: bearer, responses: { 200: ok("ReceiptList") } } },
      "/me/receipts/{id}": {
        get: {
          tags: ["Me"],
          summary: "One gross receipt, with the credit card surcharge on its own line. Refunds are separate records and include a prorated surcharge. Unknown id returns receipt null.",
          security: bearer,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: {
              description: "Receipt",
              content: { "application/json": { schema: { oneOf: [ref("CustomerReceipt"), ref("ReceiptMissing")] } } },
            },
          },
        },
      },
      "/me/delete/start": { post: { tags: ["Me"], summary: "Start account deletion. A dev code is returned only when dev codes are enabled.", security: bearer, responses: { 200: ok("DeleteStartResponse") } } },
      "/me/delete/confirm": {
        post: {
          tags: ["Me"],
          summary: "Confirm account deletion. Sales stay on the shop books.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("DeleteConfirm") },
          responses: { 200: ok("DeleteConfirmResponse"), 401: err("Code did not match") },
        },
      },
      "/appointments/{code}/payment-preview": {
        post: {
          tags: ["Booking"],
          summary: "Credit card surcharge before confirm, from computeCardFee. Wallet and funding come from the PaymentMethod, not the request body. The label is Credit card surcharge (3%) at the shop rate. Integer cents.",
          security: bearer,
          parameters: [codeParam],
          requestBody: { required: true, content: jsonContent("PaymentRequest") },
          responses: { 200: ok("PaymentPreview"), 404: err("Appointment not found") },
        },
      },
      "/appointments/{code}/payment-intents": {
        post: {
          tags: ["Booking"],
          summary: "Price the visit on the server (service, product, tax, tip, and the surcharge from the PaymentMethod). Returns clientSecret, ephemeralKey, customerId, amountCents, currency usd, and breakdown. The same breakdown is stored on the intent and a checkout row. Stripe confirms the intent on the device. This API has no confirm route. An already-paid visit is 409. An older unused intent is reused when the card, tip, and total match, or canceled. A succeeded unused intent is refunded before a new one is created. An intent that is still processing or needs authentication is left in place.",
          security: bearer,
          parameters: [codeParam],
          requestBody: { required: true, content: jsonContent("PaymentRequest") },
          responses: { 200: ok("PaymentIntentSheet"), 403: err("Shop is not launched"), 409: err("This visit is already paid") },
        },
      },
      "/appointments/{code}/payments": {
        post: {
          tags: ["Booking"],
          summary: "Record a PaymentIntent Stripe already confirmed on the device. Send { paymentIntentId }. The tip and fee are the stored breakdown, never a tip sent by the app. A bare card id is 400. A different card on an unconfirmed intent is repriced here, and the device confirms that new amount. processing and requires_action return 409 with details.status and are not refunded. A succeeded charge that does not match the stored price is refunded and logged. An already-paid visit is 409. Idempotency-Key is honored. Staff POS does not use this route. There is no confirm route.",
          security: bearer,
          parameters: [codeParam, { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          requestBody: { required: true, content: jsonContent("PaymentRequest") },
          responses: { 200: ok("PaymentResult"), 400: err("Confirm the payment sheet before charging"), 402: err("The charge was refunded"), 403: err("Shop is not launched"), 409: err("Still processing, needs authentication, or already paid. details.status is processing or requires_action when the intent is not finished. Those are not refunded.") },
        },
      },
      "/appointments/{code}/rebook": {
        post: { tags: ["Booking"], summary: "Book the same barber and service three weeks out. The shop gate applies.", security: bearer, parameters: [codeParam], responses: { 201: ok("AppointmentEnvelope", "Booked"), 403: err("Shop is not launched") } },
      },
      "/shops/{shop}/live": {
        get: { tags: ["Shops"], summary: "Chairs free and wait minutes for a shop", parameters: [shopParam], responses: { 200: ok("LiveWait"), 404: err("Shop not found") } },
      },
      "/me/purchases": {
        get: { tags: ["Me"], summary: "Purchase history with service, product, tax, tip, and the credit card surcharge kept separate. Refund records include a prorated surcharge and name which portion they came from.", security: bearer, responses: { 200: ok("PurchaseList") } },
      },
      "/me/purchases/receipt": {
        get: { tags: ["Me"], summary: "Receipt text for one sale. The surcharge is its own line. format=pdf returns a PDF. Refunds stay separate.", security: bearer, responses: { 200: ok("PurchaseReceipt") } },
      },
      "/staff/connect": {
        get: {
          tags: ["Staff"],
          summary: "Barber recipient account, recent tip transfers, and payout schedule. Gated on the shop tip switch. Stripe hosts onboarding.",
          security: bearer,
          responses: { 200: ok("StaffConnect"), 401: err("Sign in required") },
        },
      },
      "/staff/connect/onboard": {
        post: {
          tags: ["Staff"],
          summary: "Stripe-hosted Account Link for the barber's recipient account. Refused when the shop tip switch is off.",
          security: bearer,
          requestBody: { required: false, content: jsonContent("StaffOnboardRequest") },
          responses: { 200: ok("StaffOnboard"), 401: err("Sign in required"), 403: err("Shop keeps tips") },
        },
      },
      "/internal/connect/onboard": {
        post: {
          tags: ["Me"],
          summary: "Hosted Stripe Connect onboarding for a shop (test mode, internal secret)",
          requestBody: { required: true, content: jsonContent("ConnectOnboardRequest") },
          responses: { 200: ok("ConnectOnboard"), 401: err("Not authorized") },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, schema(v)])),
    },
  };
}
