import { request } from "undici";
import { stageUrl } from "./config";

/**
 * How many orders are queued and how many have been fulfilled.
 *
 * Both numbers come from the stage screen, which is the only thing that holds
 * a Temporal client. The board reads them so the room can watch the backlog on
 * their own phones instead of only on the projector -- the gap between the two
 * numbers is the whole argument, and it lands harder in your hand.
 *
 * Read-only and unauthenticated: `/api/snapshot` is what the projector itself
 * polls. Nothing here can change anything, so a leaked board does not become a
 * way to drive the demo.
 */

const TIMEOUT_MS = 2000;

export interface OrderCounts {
  /** Running right now: started, not yet fulfilled. */
  queued: number;
  /** Fulfilled since the stage screen started. */
  completed: number;
}

export async function fetchOrderCounts(): Promise<OrderCounts | null> {
  const base = stageUrl();
  if (!base) return null;

  try {
    const response = await request(`${base}/api/snapshot`, {
      method: "GET",
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    if (response.statusCode !== 200) {
      response.body.dump();
      return null;
    }

    const body = (await response.body.json()) as {
      orders_in_flight?: unknown;
      scoreboard?: { orders_completed?: unknown };
    };

    const queued = Number(body.orders_in_flight);
    const completed = Number(body.scoreboard?.orders_completed);
    // A snapshot that is missing either field is not worth showing. Rendering
    // NaN, or a silent zero, would read as "nothing is happening" during the
    // exact beat where plenty is.
    if (!Number.isFinite(queued) || !Number.isFinite(completed)) return null;

    return { queued, completed };
  } catch {
    // Deliberately silent. The stage screen is optional from the board's point
    // of view, and a laptop that is not running one must not fill the logs at
    // the poll rate for the whole talk.
    return null;
  }
}
