/**
 * SpawnLock — Prevents race conditions when multiple callers
 * trigger spawn for the same server name simultaneously.
 *
 * Pure async coordination using Map<string, Promise>. No external deps.
 * In-memory only — no disk persistence.
 */

export class SpawnLock {
  private inFlight = new Map<string, Promise<unknown>>();

  /**
   * Acquire the spawn lock for `name`. If another caller is already
   * spawning this name, returns its promise (shared spawn).
   * Otherwise, calls `spawnFn()`, stores the promise, and returns it.
   *
   * On settle (success or failure) the promise is removed from the map.
   */
  acquire<T>(name: string, spawnFn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(name);
    if (existing != null) {
      return existing as Promise<T>;
    }

    const promise = spawnFn().then(
      (result) => {
        this.inFlight.delete(name);
        return result;
      },
      (error) => {
        this.inFlight.delete(name);
        throw error;
      },
    );

    this.inFlight.set(name, promise);
    return promise;
  }
}
