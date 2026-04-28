import { describe, expect, test } from "bun:test";
import { HealthTracker } from "../src/recovery.js";

function makeError(msg: string): Error {
  return new Error(msg);
}

describe("HealthTracker", () => {
  test("1. healthy after successful spawn", () => {
    const tracker = new HealthTracker();
    tracker.recordSuccess("echo-server");
    expect(tracker.isHealthy("echo-server")).toBe(true);
    expect(tracker.getFailureCount("echo-server")).toBe(0);
    expect(tracker.isUnhealthy("echo-server")).toBe(false);
  });

  test("2. unhealthy after 3 consecutive failures", () => {
    const tracker = new HealthTracker();
    tracker.recordFailure("echo-server", makeError("crash 1"));
    expect(tracker.isUnhealthy("echo-server")).toBe(false);

    tracker.recordFailure("echo-server", makeError("crash 2"));
    expect(tracker.isUnhealthy("echo-server")).toBe(false);

    tracker.recordFailure("echo-server", makeError("crash 3"));
    expect(tracker.isUnhealthy("echo-server")).toBe(true);
    expect(tracker.isHealthy("echo-server")).toBe(false);
    expect(tracker.getFailureCount("echo-server")).toBe(3);
  });

  test("3. healthy again after successful recovery", () => {
    const tracker = new HealthTracker();

    tracker.recordFailure("echo-server", makeError("crash 1"));
    tracker.recordFailure("echo-server", makeError("crash 2"));
    tracker.recordFailure("echo-server", makeError("crash 3"));
    expect(tracker.isHealthy("echo-server")).toBe(false);

    tracker.recordSuccess("echo-server");
    expect(tracker.isHealthy("echo-server")).toBe(true);
    expect(tracker.getFailureCount("echo-server")).toBe(0);
    expect(tracker.isUnhealthy("echo-server")).toBe(false);
  });

  test("4. exponential backoff: 1s → 2s → 4s → 8s → capped at 30s", () => {
    const tracker = new HealthTracker();

    tracker.recordFailure("echo-server", makeError("crash 1"));
    expect(tracker.getRetryDelay("echo-server")).toBe(2000);
    expect(tracker.isHealthy("echo-server")).toBe(false);

    tracker.recordFailure("echo-server", makeError("crash 2"));
    expect(tracker.getRetryDelay("echo-server")).toBe(4000);

    tracker.recordFailure("echo-server", makeError("crash 3"));
    expect(tracker.getRetryDelay("echo-server")).toBe(8000);
    expect(tracker.isUnhealthy("echo-server")).toBe(true);

    tracker.recordFailure("echo-server", makeError("crash 4"));
    expect(tracker.getRetryDelay("echo-server")).toBe(16000);

    tracker.recordFailure("echo-server", makeError("crash 5"));
    expect(tracker.getRetryDelay("echo-server")).toBe(30000);

    tracker.recordFailure("echo-server", makeError("crash 6"));
    expect(tracker.getRetryDelay("echo-server")).toBe(30000);
  });

  test("5. crash mid-call triggers re-spawn attempt", () => {
    const tracker = new HealthTracker();

    tracker.recordFailure("echo-server", makeError("mid-call crash"));
    expect(tracker.isHealthy("echo-server")).toBe(false);
    expect(tracker.isUnhealthy("echo-server")).toBe(false);
    expect(tracker.getFailureCount("echo-server")).toBe(1);

    tracker.recordSuccess("echo-server");
    expect(tracker.isHealthy("echo-server")).toBe(true);
    expect(tracker.getFailureCount("echo-server")).toBe(0);
  });

  test("6. unhealthy server excluded from discovery", () => {
    const tracker = new HealthTracker();

    tracker.recordFailure("echo-server", makeError("crash 1"));
    tracker.recordFailure("echo-server", makeError("crash 2"));
    expect(tracker.isUnhealthy("echo-server")).toBe(false);

    tracker.recordFailure("echo-server", makeError("crash 3"));
    expect(tracker.isUnhealthy("echo-server")).toBe(true);
    expect(tracker.isHealthy("echo-server")).toBe(false);

    const health = tracker.getHealth("echo-server");
    expect(health?.unhealthy).toBe(true);
  });

  test("7. consecutive failures reset on success", () => {
    const tracker = new HealthTracker();

    tracker.recordFailure("echo-server", makeError("crash 1"));
    tracker.recordFailure("echo-server", makeError("crash 2"));
    expect(tracker.getFailureCount("echo-server")).toBe(2);
    expect(tracker.isUnhealthy("echo-server")).toBe(false);

    tracker.recordSuccess("echo-server");
    expect(tracker.getFailureCount("echo-server")).toBe(0);
    expect(tracker.isHealthy("echo-server")).toBe(true);
    expect(tracker.isUnhealthy("echo-server")).toBe(false);
  });
});
