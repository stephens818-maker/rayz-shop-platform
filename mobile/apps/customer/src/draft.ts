export interface BookingDraft {
  slug: string;
  shopId: string;
  shopName: string;
  serviceId: string;
  serviceName: string;
  priceCents: number;
  barberId: string | null;
  barberName: string;
  startsAt: string;
  notes: string;
  forCustomerId: string | null;
  forName: string;
}

let current: BookingDraft | null = null;

export function setDraft(draft: BookingDraft | null) {
  current = draft;
}

export function peekDraft() {
  return current;
}
