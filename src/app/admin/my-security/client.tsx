"use client";

import { Button } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { endMyAppSessionAction, endMyWebSessionAction, endOtherWebSessionsAction } from "./actions";

function End({ label, confirmText, act }: { label: string; confirmText: string; act: () => ReturnType<typeof endMyWebSessionAction> }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm(confirmText) && run(act, undefined, "Signed out")}>
        {label}
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

export const EndWebSession = ({ id }: { id: string }) => <End label="Sign out" confirmText="Sign out this browser?" act={() => endMyWebSessionAction(id)} />;
export const EndAppSession = ({ id }: { id: string }) => <End label="Sign out" confirmText="Sign out this phone? Its pushes stop too." act={() => endMyAppSessionAction(id)} />;

export function EndOtherWebSessions() {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => confirm("Sign out every other browser?") && run(() => endOtherWebSessionsAction(), undefined, "Signed out other browsers")}>
        Sign out other browsers
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
