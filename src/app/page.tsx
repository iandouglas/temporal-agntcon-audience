import { getPublicServices, pageSubtitle, pageTitle } from "../lib/config";
import { SwitchBoard } from "../components/SwitchBoard";

/**
 * Rendered per request so the toggle names come from the environment at runtime
 * rather than being baked in at build time. Only names and ids cross to the
 * browser -- the service base URLs never leave this process.
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <SwitchBoard
      services={getPublicServices()}
      title={pageTitle()}
      subtitle={pageSubtitle()}
    />
  );
}
