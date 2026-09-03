/**
 * Per-connection token bucket.
 *
 * A person mashing a switch tops out around four taps a second and never notices
 * this. A scripted loop in devtools gets its excess dropped, so one bored
 * attendee cannot generate unbounded load against the backend services. Dropped
 * taps still flip the shared state -- only the outbound POST is suppressed.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond = 5,
    private readonly capacity = 10,
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  /** Consumes one token. Returns false when the caller is over budget. */
  take(): boolean {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
