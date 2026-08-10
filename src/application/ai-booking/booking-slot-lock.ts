import { BookingConfirmationError } from "./booking-confirmation-errors.js";

type BookingSlotLockEntry = {
  tail: Promise<void>;
  queued: number;
  lastUsedAt: number;
};

export type BookingSlotLockConfig = {
  now(): Date;
  idleTtlMs: number;
  maxKeys: number;
};

export interface BookingSlotLock {
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  cleanup(): void;
  getSize(): number;
}

/**
 * Process-local keyed lock for the current single Express instance only.
 * Multi-instance production requires a shared Directus/SQL transaction or lock.
 */
export const createBookingSlotLock = (
  config: BookingSlotLockConfig,
): BookingSlotLock => {
  if (
    !Number.isSafeInteger(config.idleTtlMs) ||
    config.idleTtlMs < 1 ||
    !Number.isSafeInteger(config.maxKeys) ||
    config.maxKeys < 1
  ) {
    throw new BookingConfirmationError("BOOKING_CONFIGURATION_UNAVAILABLE");
  }

  const entries = new Map<string, BookingSlotLockEntry>();

  const cleanup = () => {
    const now = config.now().getTime();
    for (const [key, entry] of entries) {
      if (entry.queued === 0 && now - entry.lastUsedAt >= config.idleTtlMs) {
        entries.delete(key);
      }
    }
  };

  const ensureCapacity = () => {
    cleanup();
    while (entries.size >= config.maxKeys) {
      const oldestIdleEntry = [...entries.entries()]
        .filter(([, entry]) => entry.queued === 0)
        .sort(
          ([, left], [, right]) => left.lastUsedAt - right.lastUsedAt,
        )[0];
      if (oldestIdleEntry === undefined) {
        throw new BookingConfirmationError(
          "BOOKING_CONFIGURATION_UNAVAILABLE",
        );
      }
      entries.delete(oldestIdleEntry[0]);
    }
  };

  return {
    async withLock(key, operation) {
      cleanup();
      let entry = entries.get(key);
      if (entry === undefined) {
        ensureCapacity();
        entry = {
          tail: Promise.resolve(),
          queued: 0,
          lastUsedAt: config.now().getTime(),
        };
        entries.set(key, entry);
      }

      const waitFor = entry.tail;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry.tail = waitFor.then(() => gate);
      entry.queued += 1;

      await waitFor;
      try {
        return await operation();
      } finally {
        entry.queued -= 1;
        entry.lastUsedAt = config.now().getTime();
        release();
      }
    },
    cleanup,
    getSize: () => entries.size,
  };
};

export const createBookingSlotLockKey = (selection: {
  workshop_id: number;
  requested_date: string;
  requested_time: string;
}) =>
  `${selection.workshop_id}|${selection.requested_date}|${selection.requested_time}`;
