/**
 * HealthTracker — Per-server health state with exponential backoff for retries.
 * Pure in-memory tracking. No disk persistence, no child_process imports.
 */
import type { ServerStatus } from "./types.js";

export interface ServerHealth {
  consecutiveFailures: number;
  unhealthy: boolean;
  lastError: Error | null;
  lastAttempt: number;
}

export class HealthTracker {
  private health = new Map<string, ServerHealth>();

  recordSuccess(name: string): void {
    this.health.set(name, {
      consecutiveFailures: 0,
      unhealthy: false,
      lastError: null,
      lastAttempt: Date.now(),
    });
  }

  recordFailure(name: string, error: Error): void {
    const entry = this.health.get(name);
    const failures = (entry?.consecutiveFailures ?? 0) + 1;

    this.health.set(name, {
      consecutiveFailures: failures,
      unhealthy: failures >= 3,
      lastError: error,
      lastAttempt: Date.now(),
    });
  }

  isHealthy(name: string): boolean {
    const entry = this.health.get(name);
    if (!entry) return true;

    if (entry.unhealthy) return false;

    if (entry.consecutiveFailures > 0) {
      const delay = this.getRetryDelay(name);
      const elapsed = Date.now() - entry.lastAttempt;
      if (elapsed < delay) return false;
    }

    return true;
  }

  /**
   * Exponential backoff: min(1000 * 2^failures, 30000) ms.
   * Pattern: 1s → 2s → 4s → 8s → 16s → capped at 30s.
   */
  getRetryDelay(name: string): number {
    const entry = this.health.get(name);
    const failures = entry?.consecutiveFailures ?? 0;
    if (failures === 0) return 0;
    return Math.min(1000 * Math.pow(2, failures), 30000);
  }

  markHealthy(name: string): void {
    this.health.delete(name);
  }

  markUnhealthy(name: string, error: Error): void {
    this.health.set(name, {
      consecutiveFailures: 3,
      unhealthy: true,
      lastError: error,
      lastAttempt: Date.now(),
    });
  }

  getHealth(name: string): ServerHealth | undefined {
    return this.health.get(name);
  }

  getFailureCount(name: string): number {
    return this.health.get(name)?.consecutiveFailures ?? 0;
  }

  isUnhealthy(name: string): boolean {
    return this.health.get(name)?.unhealthy ?? false;
  }

  reset(): void {
    this.health.clear();
  }
}
