import { request } from "undici";
import { stageAdminToken, stageUrl } from "./config";

/**
 * Outbound call to the stage screen's teardown endpoint.
 *
 * Deliberately not routed through `dispatch.ts`'s bounded pool. That pool
 * exists to stop a live crowd exhausting sockets; this is one operator
 * pressing one button after the talk, and borrowing the pool would mean a
 * surge of audience taps could shed the one request that matters.
 *
 * The timeout is generous for the same reason the endpoint sweeps more than
 * once: Temporal's visibility store lags, so the stage screen pauses between
 * passes before deciding it is done. A two-second budget like the taps get
 * would time out on a perfectly healthy teardown.
 */

const TIMEOUT_MS = 30_000;

export interface StopResult {
  ok: boolean;
  terminated: number;
  failed: number;
  submitting: boolean;
  error: string;
}

function failure(error: string): StopResult {
  return { ok: false, terminated: 0, failed: 0, submitting: false, error };
}

export async function stopAllOrders(): Promise<StopResult> {
  const base = stageUrl();
  const token = stageAdminToken();
  if (!base || !token) {
    return failure("stage_url and stage_admin_token are not both set");
  }

  try {
    const response = await request(`${base}/api/orders/terminate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });

    const text = await response.body.text();
    if (response.statusCode !== 200) {
      // Surface the stage screen's own words. A 401 here almost always means
      // the two services disagree about the token, and saying "401" alone
      // sends you looking in the wrong place.
      return failure(`stage screen returned ${response.statusCode}: ${text.slice(0, 200)}`);
    }

    const body = JSON.parse(text) as Partial<StopResult> & { passes?: number };
    return {
      ok: true,
      terminated: Number(body.terminated ?? 0),
      failed: Number(body.failed ?? 0),
      submitting: Boolean(body.submitting),
      error: typeof body.error === "string" ? body.error : "",
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return failure(`could not reach the stage screen: ${message}`);
  }
}
