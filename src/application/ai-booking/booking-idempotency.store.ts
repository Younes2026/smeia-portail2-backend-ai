import { createHash } from "node:crypto";

import { BookingConfirmationError } from "./booking-confirmation-errors.js";

type IdempotencyEntry = {
  bodyFingerprint: string;
  promise: Promise<unknown>;
  state: "pending" | "settled";
  expiresAt: number;
  createdAt: number;
};

export type BookingIdempotencyStoreConfig = {
  now(): Date;
  ttlMs: number;
  maxEntries: number;
};

export interface BookingIdempotencyStore {
  execute<T>(
    accessToken: string,
    idempotencyKey: string,
    normalizedBody: unknown,
    operation: () => Promise<T>,
  ): Promise<T>;
  cleanup(): void;
  getSize(): number;
}

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Process-local temporary idempotency for the current Express instance only.
 * Multi-instance production requires a shared persistent idempotency store.
 */
export const createBookingIdempotencyStore = (
  config: BookingIdempotencyStoreConfig,
): BookingIdempotencyStore => {
  if (
    !Number.isSafeInteger(config.ttlMs) ||
    config.ttlMs < 1 ||
    !Number.isSafeInteger(config.maxEntries) ||
    config.maxEntries < 1
  ) {
    throw new BookingConfirmationError("BOOKING_CONFIGURATION_UNAVAILABLE");
  }

  const entries = new Map<string, IdempotencyEntry>();

  const cleanup = () => {
    const now = config.now().getTime();
    for (const [key, entry] of entries) {
      if (entry.state === "settled" && entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  };

  const ensureCapacity = () => {
    cleanup();
    while (entries.size >= config.maxEntries) {
      const oldestSettledEntry = [...entries.entries()]
        .filter(([, entry]) => entry.state === "settled")
        .sort(([, left], [, right]) => left.createdAt - right.createdAt)[0];
      if (oldestSettledEntry === undefined) {
        throw new BookingConfirmationError(
          "BOOKING_CONFIGURATION_UNAVAILABLE",
        );
      }
      entries.delete(oldestSettledEntry[0]);
    }
  };

  return {
    execute<T>(
      accessToken: string,
      idempotencyKey: string,
      normalizedBody: unknown,
      operation: () => Promise<T>,
    ): Promise<T> {
      cleanup();
      const clientTokenHash = hash(accessToken);
      const internalKey = hash(`${clientTokenHash}\0${idempotencyKey}`);
      const bodyFingerprint = hash(JSON.stringify(normalizedBody));
      const existing = entries.get(internalKey);
      if (existing !== undefined) {
        if (existing.bodyFingerprint !== bodyFingerprint) {
          throw new BookingConfirmationError("IDEMPOTENCY_CONFLICT");
        }
        return existing.promise as Promise<T>;
      }

      ensureCapacity();
      const createdAt = config.now().getTime();
      const promise = Promise.resolve().then(operation);
      const entry: IdempotencyEntry = {
        bodyFingerprint,
        promise,
        state: "pending",
        expiresAt: createdAt + config.ttlMs,
        createdAt,
      };
      entries.set(internalKey, entry);
      promise.then(
        () => {
          entry.state = "settled";
          entry.expiresAt = config.now().getTime() + config.ttlMs;
        },
        () => {
          entry.state = "settled";
          entry.expiresAt = config.now().getTime() + config.ttlMs;
        },
      );
      return promise;
    },
    cleanup,
    getSize: () => entries.size,
  };
};
