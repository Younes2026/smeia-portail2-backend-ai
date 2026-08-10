import assert from "node:assert/strict";
import test from "node:test";

import { createBookingSlotLock } from "./booking-slot-lock.js";

test("serializes concurrent confirmations for the same slot", async () => {
  const lock = createBookingSlotLock({
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    idleTtlMs: 1_000,
    maxKeys: 10,
  });
  let active = 0;
  let maximumActive = 0;
  const order: string[] = [];
  const operation = (name: string) =>
    lock.withLock("1|2026-08-12|08:00:00", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`${name}:end`);
      active -= 1;
      return name;
    });

  assert.deepEqual(await Promise.all([operation("a"), operation("b")]), ["a", "b"]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("cleans idle lock keys with an injected clock and remains bounded", async () => {
  let now = new Date("2026-08-10T12:00:00.000Z");
  const lock = createBookingSlotLock({
    now: () => now,
    idleTtlMs: 1_000,
    maxKeys: 2,
  });
  await lock.withLock("slot-a", async () => undefined);
  await lock.withLock("slot-b", async () => undefined);
  assert.equal(lock.getSize(), 2);
  await lock.withLock("slot-c", async () => undefined);
  assert.equal(lock.getSize(), 2);
  now = new Date("2026-08-10T12:00:02.000Z");
  lock.cleanup();
  assert.equal(lock.getSize(), 0);
});
