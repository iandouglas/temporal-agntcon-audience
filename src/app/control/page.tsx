import { adminToken, canStopOrders, getPublicServices, tokensMatch } from "../../lib/config";
import { ControlPanel } from "./ControlPanel";

export const dynamic = "force-dynamic";

/**
 * Operator view. Gated on `admin_token`; with no token configured the page
 * refuses to render at all rather than defaulting to open.
 */
export default async function ControlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  if (!adminToken()) {
    return (
      <main className="control">
        <h1>Control</h1>
        <p className="control-sub">admin_token is not configured on this deployment.</p>
      </main>
    );
  }

  if (!tokensMatch(token)) {
    return (
      <main className="control">
        <h1>Control</h1>
        <p className="control-sub">Append ?token=… to reach this page.</p>
      </main>
    );
  }

  return (
    <ControlPanel
      services={getPublicServices()}
      token={token as string}
      canStopOrders={canStopOrders()}
    />
  );
}
