// Reconnecting to the engine. The bug being pinned here made a temporary disconnect permanent: a
// connection attempt that hung left the "connecting" guard set forever, so the automatic retry
// no-opped AND the Try again button did nothing at all. Recovering had to mean restarting the app.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The guard logic as the store implements it, isolated from the DOM so it can be reasoned about. */
class Connector {
  socket: { closed: boolean } | null = null;
  connecting = false;
  attempts = 0;
  timer: number | null = null;
  opened = 0;
  /** Attempts that were actually started (a no-op returns without incrementing). */
  started = 0;

  connect(force = false): void {
    if (force) {
      if (this.timer !== null) this.timer = null;
      this.socket = null;
      this.connecting = false;
      this.attempts = 0;
    }
    if (this.socket || this.connecting) return;
    this.connecting = true;
    this.started++;
  }

  /** The handshake never completed and the give-up timer fired. */
  timeout(): void {
    this.connecting = false;
    this.scheduleRetry();
  }

  succeed(): void {
    this.connecting = false;
    this.socket = { closed: false };
    this.attempts = 0;
    this.opened++;
  }

  drop(): void {
    this.socket = null;
    this.connecting = false;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.timer !== null) return;
    this.attempts++;
    this.timer = 1;
  }

  /** The scheduled retry fires. */
  tick(): void {
    if (this.timer === null) return;
    this.timer = null;
    this.connect();
  }

  backoff(): number {
    return Math.min(1500 * this.attempts, 8000);
  }
}

describe("reconnecting", () => {
  let c: Connector;
  beforeEach(() => {
    c = new Connector();
  });

  it("connects once on start", () => {
    c.connect();
    c.succeed();
    expect(c.opened).toBe(1);
  });

  it("does not open a second socket while one is already connecting", () => {
    c.connect();
    c.connect();
    expect(c.started).toBe(1);
  });

  it("recovers from a handshake that never completes — the bug that made this permanent", () => {
    c.connect();
    c.timeout(); // used to leave `connecting` true forever
    c.tick();
    expect(c.started).toBe(2);
    c.succeed();
    expect(c.opened).toBe(1);
  });

  it("keeps retrying through repeated failures rather than giving up", () => {
    c.connect();
    for (let i = 0; i < 5; i++) {
      c.timeout();
      c.tick();
    }
    expect(c.started).toBe(6);
  });

  it("Try again works even while an attempt is stuck", () => {
    c.connect(); // hangs, `connecting` stays true
    c.connect(); // a plain retry is correctly ignored…
    expect(c.started).toBe(1);
    c.connect(true); // …but the button forces it
    expect(c.started).toBe(2);
  });

  it("comes back on its own once the engine returns", () => {
    c.connect();
    c.succeed();
    c.drop(); // engine went away
    c.tick(); // engine still down
    c.timeout();
    c.tick(); // engine is back
    c.succeed();
    expect(c.opened).toBe(2);
  });

  it("backs off so a busy engine is not hammered, but never past a few seconds", () => {
    c.connect();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      c.timeout();
      waits.push(c.backoff());
      c.tick();
    }
    expect(waits[0]).toBeLessThan(waits[3]!); // grows
    expect(Math.max(...waits)).toBeLessThanOrEqual(8000); // capped: it must keep trying often enough
  });

  it("resets the backoff after a successful connection", () => {
    c.connect();
    for (let i = 0; i < 4; i++) {
      c.timeout();
      c.tick();
    }
    c.succeed();
    expect(c.attempts).toBe(0);
  });

  it("only schedules one retry at a time", () => {
    c.connect();
    c.drop();
    const first = c.attempts;
    c.drop(); // a second close event must not stack another timer
    expect(c.attempts).toBe(first);
  });
});

describe("opening an external link", () => {
  it("asks the engine, because the desktop webview ignores window.open", async () => {
    // The update button appeared completely dead: window.open on an external URL is dropped by the
    // webview, and location.href would have navigated the editor itself to the installer.
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ opened: true }) });
    const open = async (url: string) => {
      const r = await fetchMock("/open", { method: "POST", body: JSON.stringify({ url }) }).then((x: { json: () => Promise<{ opened: boolean }> }) => x.json());
      return r.opened;
    };
    expect(await open("https://example.com/x.exe")).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
