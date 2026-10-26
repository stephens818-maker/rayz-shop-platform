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
const cardParam = { name: "id", in: "path", required: true, description: "Card id from GET /me/payment-methods", schema: { type: "string", format: "uuid" } };
const ticketParam = { name: "id", in: "path", required: true, description: "Ticket id from GET /me/tickets or the push", schema: { type: "string", format: "uuid" } };
const deviceParam = { name: "id", in: "path", required: true, description: "Device ID from POST /me/devices", schema: { type: "string", format: "uuid" } };
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
    StepUpRequired: S.StepUpRequired,
    CantSignIn: S.CantSignIn,
    OtpComplete: S.OtpComplete,
    StepUpStart: S.StepUpStart,
    StepUpVerify: S.StepUpVerify,
    SignInHelp: S.SignInHelp,
    Received: S.Received,
    IdentityCheck: S.IdentityCheck,
    IdentityCheckResult: S.IdentityCheckResult,
    DeletionPreview: S.DeletionPreview,
    DeleteAccount: S.DeleteAccount,
    Deleted: S.Deleted,
    ConsentState: S.ConsentStateSchema,
    SetConsent: S.SetConsent,
    Device: S.DeviceSchema,
    DeviceList: z.object({ devices: z.array(S.DeviceSchema) }),
    DeviceResponse: z.object({ device: S.DeviceSchema }),
    ReceiptList: z.object({ receipts: z.array(S.ReceiptSummary), nextBefore: z.string().nullable().describe("Pass as ?before= for the next page; null at the end") }),
    ReceiptResponse: z.object({ receipt: S.ReceiptDetail }),
    SavedCard: S.SavedCardSchema,
    SavedCardList: S.SavedCardList,
    SavedCardResponse: z.object({ paymentMethod: S.SavedCardSchema }),
    CardSetupBody: S.CardSetupBody,
    CardSetup: S.CardSetupSchema,
    SaveCardBody: S.SaveCardBody,
    AppTicketList: z.object({ tickets: z.array(S.AppTicketSummary) }),
    AppTicketResponse: z.object({ ticket: S.AppTicketSchema }),
    QuoteBody: S.QuoteBody,
    QuoteResponse: z.object({ quote: S.AppQuoteSchema }),
    PayBody: S.PayBody,
    PayResult: S.AppPayResultSchema,
    RegisterDevice: S.RegisterDevice,
    UpdateDevice: S.UpdateDevice,
    EmailChangeStart: S.EmailChangeStart,
    SecureBody: S.SecureBody,
    SecureResult: S.SecureResult,
    ClaimChildBody: S.ClaimChildBody,
    ClaimChildResult: S.ClaimChildResult,
    EmailChangeVerify: S.EmailChangeVerify,
    RefreshBody: S.RefreshBody,
    RefreshResponse: S.RefreshResponse,
    Me: S.Me,
    UpdateMe: S.UpdateMe,
    Loyalty: S.Loyalty,
    AppConfig: S.AppConfig,
  };
  const bearer = [{ bearerAuth: [] }];
  const optionalBearer = [{}, { bearerAuth: [] }];

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Ray'z Barber Shop API",
      version: "1.2.0",
      description: [
        "Public booking + customer API used by rayzbs.com booking pages and the future iOS/Android app.",
        "",
        "**Auth:** customers sign in with a one-time code (SMS or email) → `accessToken` (JWT, 1 hour) + rotating `refreshToken` (60 days).",
        "Send `Authorization: Bearer <accessToken>`. Refresh with `POST /auth/refresh`; reusing an old refresh token revokes all sessions.",
        "",
        "**Time:** every shop runs on America/Chicago. Dates are local `YYYY-MM-DD`; instants are ISO-8601 UTC.",
        "**Money:** integer cents. **Privacy:** barbers are exposed by first name / admin label only; URLs never contain surnames.",
        "**Retries:** `POST /appointments` honors an `Idempotency-Key` header so a flaky mobile network can't double-book.",
        "",
        "**App builds:** send `X-Client: ios|android` and `X-App-Version: 1.2.3` on every request. A build below the platform's minimum gets `426` with `error.code = upgrade_required` and `details.storeUrl` on every route except `GET /app/config` and this document. Requests without `X-Client` (the website) are never gated.",
        "",
        "**Changes in 1.1 (additive):** `GET /app/config`; `bookingMode` and `externalBookingUrl` on shops (send clients to the external URL while a shop still books on its old site); `preferences` on `/me` with `preferencesNote` and `preferredBarberId` on `PATCH /me`; the `upgrade_required` error code.",
        "",
        "**Changes in 1.2:** a sign-in code no longer lists the profiles on a number (`chooseProfile` is never returned; treat it like `needsProfile` and ask for a first name). New sign-in steps: `stepUp` (a number unused 18 months confirms with the profile's verified email via `/auth/step-up/*`) and `cantSignIn` (offer `POST /auth/help`). `identityCheckRequired` on tokens and `/me`, with `POST /me/identity-check`; `redemptionLocked` on `/me/loyalty`. Only a verified email signs in: `emailVerified` on `/me`, and a new email goes through `/me/email/start` and `/me/email/verify` (`PATCH /me` only clears it). `appHash` on `/auth/otp/start` for Android. `features` (kill switches) on `/app/config`; a switched-off feature answers 403 with `details.switch`. Code requests are limited per IP as well as per number (429 with `details.retryAfterSeconds`). Account deletion: `GET /me/delete` (what happens), `POST /me/delete/start` (code), `POST /me/delete`; `links` on `/app/config` adds `support` and `deleteAccount` (the web page, which works without the app), and privacy and terms default to pages on this site. Consent: `GET`/`PUT /me/consent` (appointment and marketing texts, emails and app push, each recorded with the wording's version), the four new flags on `/me`, and push devices at `/me/devices`. Receipts: `receiptDelivery` on `/me` (email or app; a counter checkout then sends the receipt with nothing asked), `GET /me/receipts` and `/me/receipts/{id}`, and a push with `data.kind = receipt`. Cards and paying in the app: `/me/payment-methods` (saved cards on a platform-level Stripe Customer, set up with `POST /me/payment-methods/setup` for PaymentSheet), tickets the shop sends to the app at `/me/tickets` (push `data.kind = ticket`), the card fee before authorizing with `POST /me/tickets/{id}/quote`, and `POST /me/tickets/{id}/pay` (`requires_action` for 3-D Secure); `payments` on `/app/config`. Accounts: the app books signed in (401 `sign_in_required` otherwise) and signed-out website bookings never join an existing profile until that phone signs in; account holders are 13 or older (`ageConfirmed` on `/auth/otp/verify` and `/auth/otp/complete`, required from the app; `accounts` on `/app/config`); `PUT /me/secure` (`secured` on `/me`, and `stepUp.reason` is `secured` for such a profile); `POST /me/family/claim`; a child (dependent) keeps a first name and birth year only (`birthYear` on family members; their `lastName`, `birthday` and `photo` are always null).",
      ].join("\n"),
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    tags: [
      { name: "App" },
      { name: "Shops" },
      { name: "Booking" },
      { name: "Auth" },
      { name: "Me" },
      { name: "Payments" },
    ],
    paths: {
      "/app/config": {
        get: {
          tags: ["App"],
          summary: "App launch config: minimum and latest versions, store links, maintenance notice, support and legal links",
          description: "Never gated by version, so an outdated build can still read where to update.",
          parameters: [
            { name: "X-Client", in: "header", required: false, schema: { type: "string", enum: ["ios", "android"] } },
            { name: "X-App-Version", in: "header", required: false, schema: { type: "string" }, description: "e.g. 1.2.3" },
          ],
          responses: { 200: ok("AppConfig") },
        },
      },
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
          description:
            "The app (X-Client ios/android) books signed in. Signed-out booking is the website's: limited per IP and per phone or email, behind Cloudflare Turnstile when it's on, never added to an existing profile until the phone signs in with a code, and at most one confirmation text a day to a number nobody has verified. With a barber who books with a card on file, the app needs a saved card on the household's account (the guardian's for a child).",
          security: optionalBearer,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          requestBody: { required: true, content: jsonContent("CreateAppointment") },
          responses: {
            201: ok("AppointmentEnvelope", "Booked"),
            400: err("Invalid"),
            401: err("The app must sign in to book (details.reason sign_in_required)"),
            403: err("Booking is switched off (details.switch); under 13 (under_13); the bot check failed (bot_check_required, bot_check_failed); no saved card for a barber who needs one (card_required)"),
            409: err("Slot no longer available"),
            429: err("Too many guest bookings from this network or for this phone"),
          },
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
            "One adult profile on this phone (or verified email): tokens, unless the number has been unused for 18 months (`stepUp` or `cantSignIn`). None or several: `{needsProfile: true, selectionToken}`; ask for a first name and finish with /auth/otp/complete (the code isn't needed again). Who else is on a number is never shown. Sending firstName here does the same matching up front.",
          requestBody: { required: true, content: jsonContent("OtpVerify") },
          responses: {
            200: { description: "Tokens or the next step", content: { "application/json": { schema: { oneOf: [ref("TokenResponse"), ref("NeedsProfile"), ref("StepUpRequired"), ref("CantSignIn")] } } } },
            401: err("Bad/expired code"),
          },
        },
      },
      "/auth/otp/complete": {
        post: {
          tags: ["Auth"],
          summary: "Give a first name after verifying a code: signs in to the matching adult profile on the number, or creates one",
          requestBody: { required: true, content: jsonContent("OtpComplete") },
          responses: {
            200: { description: "Tokens or the next step", content: { "application/json": { schema: { oneOf: [ref("TokenResponse"), ref("StepUpRequired"), ref("CantSignIn")] } } } },
            400: err("No first name"),
            401: err("Selection expired"),
          },
        },
      },
      "/auth/step-up/start": {
        post: {
          tags: ["Auth"],
          summary: "Email a code to the profile's verified email (after a stepUp answer)",
          requestBody: { required: true, content: jsonContent("StepUpStart") },
          responses: { 200: ok("OtpStartResponse"), 401: err("Selection expired"), 403: err("No verified email"), 429: err("Rate limited") },
        },
      },
      "/auth/step-up/verify": {
        post: {
          tags: ["Auth"],
          summary: "Finish signing in with the emailed code",
          requestBody: { required: true, content: jsonContent("StepUpVerify") },
          responses: { 200: ok("TokenResponse"), 401: err("Bad/expired code or selection") },
        },
      },
      "/auth/help": {
        post: {
          tags: ["Auth"],
          summary: "\"I can't sign in\": ask the shop to confirm who they are",
          description: "Creates a task for staff. With a selectionToken (the number was proven with a code) the profiles on it are attached for staff; they're never shown to the caller.",
          requestBody: { required: true, content: jsonContent("SignInHelp") },
          responses: { 202: ok("Received", "Received"), 400: err("No phone or email"), 429: err("Rate limited") },
        },
      },
      "/auth/refresh": { post: { tags: ["Auth"], summary: "Rotate tokens", requestBody: { required: true, content: jsonContent("RefreshBody") }, responses: { 200: ok("RefreshResponse"), 401: err("Invalid") } } },
      "/auth/logout": { post: { tags: ["Auth"], summary: "Revoke a refresh token", requestBody: { required: true, content: jsonContent("RefreshBody") }, responses: { 204: { description: "Revoked" } } } },
      "/me": {
        get: { tags: ["Me"], summary: "Current customer", security: bearer, responses: { 200: ok("Me"), 401: err("Sign in required") } },
        patch: { tags: ["Me"], summary: "Update profile, notification preferences, and the client's own preferences note and preferred barber", security: bearer, requestBody: { required: true, content: jsonContent("UpdateMe") }, responses: { 200: ok("Me"), 400: err("A new email must go through /me/email/start") } },
      },
      "/me/identity-check": {
        post: {
          tags: ["Me"],
          summary: "Confirm an imported profile is theirs: last name or the shop of their last visit",
          security: bearer,
          requestBody: { required: true, content: jsonContent("IdentityCheck") },
          responses: { 200: ok("IdentityCheckResult"), 401: err("Doesn't match (details.attemptsLeft)"), 403: err("Five misses: locked, and the shop has been asked to help") },
        },
      },
      "/me/delete": {
        get: {
          tags: ["Me"],
          summary: "What deleting the account (or one of your children's profiles) does: show this before asking for the code",
          security: bearer,
          parameters: queryParams(S.DeletionQuery),
          responses: { 200: ok("DeletionPreview") },
        },
        post: {
          tags: ["Me"],
          summary: "Delete the account with a fresh code",
          description:
            "Deletes only the chosen profile (and, for your own, your children's). Other adults on the same phone are untouched. The profile is anonymized: contact details, notes, photo, preferences, sessions and upcoming bookings go; past tickets stay under \"Deleted client\" for accounting. Every token for it stops working.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("DeleteAccount") },
          responses: { 200: ok("Deleted"), 401: err("Bad/expired code"), 409: err("An active membership must be cancelled first (details.blockers)") },
        },
      },
      "/me/delete/start": {
        post: { tags: ["Me"], summary: "Send the code that confirms a deletion, to the profile's phone (or confirmed email)", security: bearer, responses: { 200: ok("OtpStartResponse"), 403: err("No phone or confirmed email"), 429: err("Rate limited") } },
      },
      "/me/secure": {
        put: {
          tags: ["Me"],
          summary: "Secure my profile (I15): signing in by phone also needs a code to the verified email",
          description: "For a phone shared with family or one that may change hands. Turning it on needs a verified email (400 email_required). The state is `secured` on /me.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("SecureBody") },
          responses: { 200: ok("SecureResult"), 400: err("No verified email"), 403: err("A child profile") },
        },
      },
      "/me/family/claim": {
        post: {
          tags: ["Me"],
          summary: "Make a child's profile on my phone number my dependent (I15)",
          description:
            "For a child the shop has as their own profile on the parent's phone. Done at once when the shop's record shows them under 13 and the profile was never used on its own; otherwise the shop checks first (status requested). The profiles on a number are never listed: send the child's first name. Five tries an hour.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("ClaimChildBody") },
          responses: { 200: ok("ClaimChildResult"), 404: err("No profile with that first name on this phone"), 429: err("Rate limited") },
        },
      },
      "/me/email/start": {
        post: {
          tags: ["Me"],
          summary: "Send a code to a new email",
          security: bearer,
          requestBody: { required: true, content: jsonContent("EmailChangeStart") },
          responses: { 200: ok("OtpStartResponse"), 429: err("Rate limited") },
        },
      },
      "/me/email/verify": {
        post: {
          tags: ["Me"],
          summary: "Save the new email, verified, once its code is entered",
          security: bearer,
          requestBody: { required: true, content: jsonContent("EmailChangeVerify") },
          responses: { 200: ok("Me"), 401: err("Bad/expired code") },
        },
      },
      "/me/consent": {
        get: { tags: ["Me"], summary: "Each message channel: on or off, the wording to show, and its version", security: bearer, responses: { 200: ok("ConsentState") } },
        put: {
          tags: ["Me"],
          summary: "Turn channels on or off. Every change is recorded with the wording's version, the app and its version",
          description:
            "Marketing on each channel is its own yes, never implied by appointment texts or emails, and Squire imports never grant it. A yes needs the textVersion from GET /me/consent (400 with details.textVersion when the wording changed). A yes to marketing texts after a STOP stays blocked until the number texts START (blockedBy: stop). A yes to marketing email needs a verified email. Turning appointment notifications on (push_transactional) is how the app gets push about its bookings; register the phone with POST /me/devices too.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("SetConsent") },
          responses: { 200: ok("ConsentState"), 400: err("Outdated wording, no phone, or unverified email (error.details.field)"), 403: err("A child profile") },
        },
      },
      "/me/devices": {
        get: { tags: ["Me"], summary: "Signed-in devices that can get push", security: bearer, responses: { 200: ok("DeviceList") } },
        post: {
          tags: ["Me"],
          summary: "Register this phone's push token after sign-in (and on every launch: it updates lastSeenAt)",
          description: "A token belongs to one account: registering it while signed in as someone else moves it. Keep the returned id to update or revoke it. Up to 10 devices per account; the oldest are revoked.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("RegisterDevice") },
          responses: { 201: ok("DeviceResponse"), 400: err("Provider doesn't match the platform") },
        },
      },
      "/me/devices/{id}": {
        patch: { tags: ["Me"], summary: "A rotated token, the phone's notification permission, or a new app version", security: bearer, parameters: [deviceParam], requestBody: { required: true, content: jsonContent("UpdateDevice") }, responses: { 200: ok("DeviceResponse"), 404: err("Not found") } },
        delete: { tags: ["Me"], summary: "Revoke the device: call before signing out", security: bearer, parameters: [deviceParam], responses: { 204: { description: "Revoked" }, 404: err("Not found") } },
      },
      "/me/appointments": { get: { tags: ["Me"], summary: "My upcoming and past appointments", security: bearer, responses: { 200: ok("AppointmentList") } } },
      "/me/receipts": {
        get: {
          tags: ["Me"],
          summary: "My receipts, newest first: mine, my children's, and tickets I paid for",
          security: bearer,
          parameters: [
            { name: "before", in: "query", required: false, description: "nextBefore from the previous page", schema: { type: "string", format: "date-time" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
          ],
          responses: { 200: ok("ReceiptList") },
        },
      },
      "/me/receipts/{id}": {
        get: {
          tags: ["Me"],
          summary: "One receipt, as the digital receipt shows it",
          security: bearer,
          parameters: [{ name: "id", in: "path", required: true, description: "Receipt id from GET /me/receipts", schema: { type: "string", format: "uuid" } }],
          responses: { 200: ok("ReceiptResponse"), 404: err("Not found") },
        },
      },
      "/me/payment-methods": {
        get: { tags: ["Payments"], summary: "My saved cards (a child's cards are the parent's)", security: bearer, responses: { 200: ok("SavedCardList") } },
        post: {
          tags: ["Payments"],
          summary: "Record the card PaymentSheet just saved",
          description: "Send the SetupIntent PaymentSheet completed. It's checked against your own Stripe Customer. setup_intent.succeeded records the same card if this call never arrives. Up to 10 cards; the first is the default.",
          security: bearer,
          requestBody: { required: true, content: jsonContent("SaveCardBody") },
          responses: { 201: ok("SavedCardResponse"), 403: err("Not your card, or payments are switched off (details.switch)"), 409: err("Not finished, or 10 cards already") },
        },
      },
      "/me/payment-methods/setup": {
        post: {
          tags: ["Payments"],
          summary: "Start saving a card: Customer, ephemeral key and SetupIntent for PaymentSheet",
          description: "Cards are on the account holder's platform-level Stripe Customer, so one card works at every shop. A child's account uses the parent's.",
          security: bearer,
          requestBody: { required: false, content: jsonContent("CardSetupBody") },
          responses: { 200: ok("CardSetup"), 400: err("stripeVersion missing (details.field)") },
        },
      },
      "/me/payment-methods/{id}": {
        delete: { tags: ["Payments"], summary: "Remove a card (detached from Stripe)", security: bearer, parameters: [cardParam], responses: { 204: { description: "Removed" }, 404: err("Not found") } },
      },
      "/me/payment-methods/{id}/default": {
        post: { tags: ["Payments"], summary: "Make this card the default", security: bearer, parameters: [cardParam], responses: { 200: ok("SavedCardResponse"), 404: err("Not found") } },
      },
      "/me/tickets": { get: { tags: ["Payments"], summary: "Tickets the shop sent to the app to tip and pay, mine and my children's", security: bearer, responses: { 200: ok("AppTicketList") } } },
      "/me/tickets/{id}": {
        get: { tags: ["Payments"], summary: "One ticket: lines, tax, tip choices and the shop's card surcharge", security: bearer, parameters: [ticketParam], responses: { 200: ok("AppTicketResponse"), 404: err("Not found") } },
      },
      "/me/tickets/{id}/quote": {
        post: {
          tags: ["Payments"],
          summary: "The tip and the card fee for the card picked, before the client authorizes",
          description:
            "Use PaymentSheet's FlowController: the client picks a saved card or enters one (a ConfirmationToken), this returns the fee and total from the card's funding, and your own Pay button calls /pay. Only credit cards pay the surcharge: never debit or prepaid, and not Apple Pay or Google Pay unless /app/config payments.walletFee.",
          security: bearer,
          parameters: [ticketParam],
          requestBody: { required: true, content: jsonContent("QuoteBody") },
          responses: { 200: ok("QuoteResponse"), 400: err("Not a tip choice, or not a card"), 403: err("Not your saved card, or payments switched off"), 409: err("Paid already, or the shop took it back (details.reason)") },
        },
      },
      "/me/tickets/{id}/pay": {
        post: {
          tags: ["Payments"],
          summary: "Pay the ticket",
          description:
            "Send the card and the quote's totalCents as expectedTotalCents (409 with details.totalCents if it changed). status requires_action: run the bank's check with clientSecret (handleNextAction), then POST again with paymentIntentId. A payment that succeeds after the app closes is finished by Stripe's webhook, and the receipt arrives by push.",
          security: bearer,
          parameters: [ticketParam],
          requestBody: { required: true, content: jsonContent("PayBody") },
          responses: { 200: ok("PayResult"), 402: err("Declined (details.reason)"), 409: err("Total changed, paid already, or taken back") },
        },
      },
      "/me/loyalty": { get: { tags: ["Me"], summary: "Loyalty progress and available rewards (brand-wide)", security: bearer, responses: { 200: ok("Loyalty") } } },
    },
    components: {
      responses: { UpgradeRequired: err("This app build is below the minimum version (error.code upgrade_required, details.storeUrl)") },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, schema(v)])),
    },
  };
  for (const [path, ops] of Object.entries(doc.paths)) {
    if (path === "/app/config") continue;
    for (const op of Object.values(ops) as { responses: Record<string, unknown> }[]) op.responses[426] ??= { $ref: "#/components/responses/UpgradeRequired" };
  }
  return doc;
}
