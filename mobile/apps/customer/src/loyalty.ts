export function loyaltyBadge(badge: { label: string; reason: string } | null | undefined): { label: string; reason: string } | null {
  if (!badge?.label) return null;
  return badge;
}
