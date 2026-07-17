import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CircuitBreaker } from "./circuit-breaker";

describe("CircuitBreaker", () => {
  let dir: string;
  let statePath: string;
  let clock: number;

  const now = () => clock;
  const makeBreaker = (extra = {}) =>
    new CircuitBreaker({
      statePath,
      now,
      rng: () => 0, // deterministic: no jitter
      quotaBaseDelayMs: 60_000,
      quotaMaxDelayMs: 12 * 60 * 60 * 1000,
      transientHoldMs: 60_000,
      probeGuardMs: 30_000,
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eai-breaker-"));
    statePath = join(dir, "ai-breaker.json");
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts closed and allows attempts", () => {
    const b = makeBreaker();
    expect(b.peek().status).toBe("closed");
    expect(b.canAttempt().allowed).toBe(true);
    expect(b.isOpen()).toBe(false);
  });

  it("quota failure opens until the provider reset time", () => {
    const b = makeBreaker();
    const resetAt = clock + 3 * 60 * 60 * 1000;
    b.recordFailure("quota", { resetAt, provider: "kimi" });

    const state = b.peek();
    expect(state.status).toBe("open");
    expect(state.reason).toBe("quota");
    expect(Date.parse(state.nextAllowedAttempt!)).toBe(resetAt);
    expect(b.canAttempt().allowed).toBe(false);
  });

  it("quota failure with no hint uses capped exponential backoff", () => {
    const b = makeBreaker();
    b.recordFailure("quota", {}); // failures=1 → base 60s
    expect(Date.parse(b.peek().nextAllowedAttempt!) - clock).toBe(60_000);

    b.recordFailure("quota", {}); // failures=2 → 120s
    expect(Date.parse(b.peek().nextAllowedAttempt!) - clock).toBe(120_000);

    b.recordFailure("quota", {}); // failures=3 → 240s
    expect(Date.parse(b.peek().nextAllowedAttempt!) - clock).toBe(240_000);
  });

  it("auth failure is held for the long (quotaMax) window", () => {
    const b = makeBreaker();
    b.recordFailure("auth", { provider: "kimi", error: "Invalid Authentication" });
    const held = Date.parse(b.peek().nextAllowedAttempt!) - clock;
    expect(held).toBe(12 * 60 * 60 * 1000);
    expect(b.peek().reason).toBe("auth");
  });

  it("SURVIVES A PROCESS RESTART via the state file", () => {
    // First process trips the breaker...
    const first = makeBreaker();
    first.recordFailure("quota", { resetAt: clock + 3_600_000 });
    expect(existsSync(statePath)).toBe(true);

    // ...a brand-new instance (fresh launchd process) sees it as open.
    const second = makeBreaker();
    expect(second.isOpen()).toBe(true);
    expect(second.canAttempt().allowed).toBe(false);
    expect(second.peek().reason).toBe("quota");
  });

  it("breaker-open skips attempts until the window elapses", () => {
    const b = makeBreaker();
    b.recordFailure("quota", { resetAt: clock + 1_000 });
    expect(b.canAttempt().allowed).toBe(false);

    clock += 1_000; // reach the reset window
    expect(b.canAttempt().allowed).toBe(true); // now a probe is allowed
  });

  it("half-open allows exactly ONE probe", () => {
    const b = makeBreaker();
    b.recordFailure("quota", { resetAt: clock + 1_000 });
    clock += 1_000;

    // First call transitions to half_open and is allowed.
    expect(b.canAttempt().allowed).toBe(true);
    expect(b.peek().status).toBe("half_open");

    // A second immediate call is blocked by the probe guard.
    expect(b.canAttempt().allowed).toBe(false);
  });

  it("half-open probe SUCCESS closes the breaker", () => {
    const b = makeBreaker();
    b.recordFailure("quota", { resetAt: clock + 1_000 });
    clock += 1_000;
    expect(b.canAttempt().allowed).toBe(true); // probe

    b.recordSuccess();
    expect(b.peek().status).toBe("closed");
    expect(b.peek().consecutiveFailures).toBe(0);
    expect(b.canAttempt().allowed).toBe(true);
  });

  it("half-open probe FAILURE reopens with a longer backoff", () => {
    const b = makeBreaker();
    b.recordFailure("quota", {}); // failures=1 → 60s
    clock += 60_000;
    expect(b.canAttempt().allowed).toBe(true); // probe (half_open)

    // Probe fails again → failures=2 → 120s from now.
    b.recordFailure("quota", {});
    expect(b.peek().status).toBe("open");
    expect(b.peek().consecutiveFailures).toBe(2);
    expect(Date.parse(b.peek().nextAllowedAttempt!) - clock).toBe(120_000);
    expect(b.canAttempt().allowed).toBe(false);
  });

  it("reset() clears an auth hold (e.g. after fixing the key)", () => {
    const b = makeBreaker();
    b.recordFailure("auth", {});
    expect(b.isOpen()).toBe(true);
    b.reset();
    expect(b.isOpen()).toBe(false);
    expect(b.peek().status).toBe("closed");
  });

  it("tolerates a corrupt state file (treats as closed)", () => {
    const b = makeBreaker();
    writeFileSync(statePath, "{ not json");
    expect(b.peek().status).toBe("closed");
    expect(b.canAttempt().allowed).toBe(true);
  });
});
