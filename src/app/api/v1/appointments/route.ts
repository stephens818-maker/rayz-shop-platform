import { clientIp } from "@/lib/client-ip";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { body, json, options, route } from "@/server/api";
import { clientPlatform } from "@/server/app-config";
import { assertSwitch } from "@/server/app-switches";
import { CreateAppointment } from "@/server/api-schemas";
import { audit, customerActor } from "@/server/audit";
import { customerFromRequest } from "@/server/auth/customer";
import { assertReviewShop, isReviewAccount } from "@/server/auth/review-login";
import { assertHuman } from "@/server/bot-check";
import { createAppointment } from "@/server/booking";
import { requestConsentContext } from "@/server/consent-events";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";

const GUEST_PER_IP_HOUR = 10;
const GUEST_PER_CONTACT_DAY = 5;

export const OPTIONS = options;
export const POST = route(async (req) => {
  await assertSwitch("booking");
  const b = await body(req, CreateAppointment);
  const customerId = await customerFromRequest(req);
  if (!customerId) {
    // I14: the app books signed in. Only the website takes guest bookings, and those are hardened.
    if (clientPlatform(req)) throw new AppError("unauthorized", "Sign in to book in the app", { reason: "sign_in_required" });
    if (!b.customer) throw new AppError("bad_request", "customer is required when not signed in");
    if (b.customer.ageConfirmed === false) throw new AppError("forbidden", "You need to be 13 or older to book. A parent or guardian can book for you.", { reason: "under_13" });
    const ip = clientIp(req.headers);
    await assertHuman(b.captchaToken ?? req.headers.get("cf-turnstile-response"), ip);
    await rateLimit("guest_booking_ip", ip, GUEST_PER_IP_HOUR, 3_600_000, "Too many bookings from this network. Try again later, or call the shop.");
    const contact = normalizePhone(b.customer.phone) ?? normalizeEmail(b.customer.email);
    await rateLimit("guest_booking_contact", contact, GUEST_PER_CONTACT_DAY, 86_400_000, "Too many bookings for this phone number today. Sign in to book more, or call the shop.");
  }
  // C18 scaffold: the App Review account's bookings stay at the review shop and notify nobody.
  const review = customerId ? await isReviewAccount(customerId) : false;
  if (review) await assertReviewShop(b.shopId);
  const idem = req.headers.get("idempotency-key");
  const appointment = await createAppointment({
    shopRef: b.shopId,
    serviceId: b.serviceId,
    addonIds: b.addonIds ?? [],
    barberRef: b.barberId ?? "any",
    startsAt: b.startsAt,
    customerId,
    customer: customerId ? null : b.customer,
    guest: !customerId,
    source: req.headers.get("x-client") === "web" ? "online" : "api",
    consent: requestConsentContext(req),
    notes: b.notes ?? null,
    idempotencyKey: idem ? `api:${idem.slice(0, 100)}` : null,
    actor: customerActor(customerId ?? b.customer?.firstName ?? "guest"),
    silent: review,
  });
  if (review) await audit({ staffId: null, label: "review" }, "review.booking", "appointment", appointment.id, { shop: appointment.shop.slug }, appointment.shop.id);
  return json({ appointment }, 201);
});
