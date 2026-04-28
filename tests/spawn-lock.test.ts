import { describe, expect, test } from "bun:test";
import { SpawnLock } from "../src/spawn-lock.ts";

function delayedResolve<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function delayedReject(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("spawn failed")), ms),
  );
}

describe("SpawnLock", () => {
  test("single caller spawns successfully", async () => {
    const lock = new SpawnLock();
    const result = await lock.acquire("server-A", () =>
      delayedResolve("ok", 10),
    );
    expect(result).toBe("ok");
  });

  test("two simultaneous callers share one spawn (spawnFn called once)", async () => {
    const lock = new SpawnLock();
    let calls = 0;

    const spawnFn = () => {
      calls++;
      return delayedResolve("ok", 20);
    };

    const [r1, r2] = await Promise.all([
      lock.acquire("server-A", spawnFn),
      lock.acquire("server-A", spawnFn),
    ]);

    expect(r1).toBe("ok");
    expect(r2).toBe("ok");
    expect(calls).toBe(1);
  });

  test("three simultaneous callers share one spawn (spawnFn called once)", async () => {
    const lock = new SpawnLock();
    let calls = 0;

    const spawnFn = () => {
      calls++;
      return delayedResolve("ok", 20);
    };

    const [r1, r2, r3] = await Promise.all([
      lock.acquire("server-A", spawnFn),
      lock.acquire("server-A", spawnFn),
      lock.acquire("server-A", spawnFn),
    ]);

    expect(r1).toBe("ok");
    expect(r2).toBe("ok");
    expect(r3).toBe("ok");
    expect(calls).toBe(1);
  });

  test("spawn failure rejects all waiters", async () => {
    const lock = new SpawnLock();
    let calls = 0;

    const spawnFn = () => {
      calls++;
      return delayedReject(10);
    };

    const results = await Promise.allSettled([
      lock.acquire("server-A", spawnFn),
      lock.acquire("server-A", spawnFn),
    ]);

    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason.message).toBe(
      "spawn failed",
    );
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      "spawn failed",
    );
    expect(calls).toBe(1);
  });

  test("after successful spawn, next call creates new promise (not stale)", async () => {
    const lock = new SpawnLock();
    let calls = 0;

    const spawnFn = () => {
      calls++;
      return delayedResolve(calls, 10);
    };

    const r1 = await lock.acquire("server-A", spawnFn);
    expect(r1).toBe(1);
    expect(calls).toBe(1);

    const r2 = await lock.acquire("server-A", spawnFn);
    expect(r2).toBe(2);
    expect(calls).toBe(2);
  });

  test("concurrent calls for different servers don't block each other", async () => {
    const lock = new SpawnLock();
    let callsA = 0;
    let callsB = 0;

    const [rA1, rA2, rB1, rB2] = await Promise.all([
      lock.acquire("server-A", () => {
        callsA++;
        return delayedResolve("A", 20);
      }),
      lock.acquire("server-A", () => {
        callsA++;
        return delayedResolve("A", 20);
      }),
      lock.acquire("server-B", () => {
        callsB++;
        return delayedResolve("B", 20);
      }),
      lock.acquire("server-B", () => {
        callsB++;
        return delayedResolve("B", 20);
      }),
    ]);

    expect(rA1).toBe("A");
    expect(rA2).toBe("A");
    expect(rB1).toBe("B");
    expect(rB2).toBe("B");
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });
});
