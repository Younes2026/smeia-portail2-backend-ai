import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BookingAvailabilityError } from "./booking-errors.js";
import {
  BOOKING_SLOT_TOKEN_TTL_SECONDS,
  BOOKING_SLOT_TOKEN_VERSION,
  createBookingSlotTokenService,
} from "./booking-slot-token.service.js";

const SECRET = "unit-test-booking-slot-secret-placeholder";
const ISSUED_AT = new Date("2026-08-10T12:00:00.000Z");
const claims = {
  vehicle_id: 14,
  service_type_id: 2 as const,
  workshop_id: 1 as const,
  requested_date: "2026-08-12",
  requested_time: "09:30:00",
  slot_interval_minutes: 30,
};

const createHarness = (secret: string | undefined = SECRET) => {
  let now = ISSUED_AT;
  const service = createBookingSlotTokenService({
    secret,
    now: () => now,
  });
  return {
    service,
    setNow(value: Date) {
      now = value;
    },
  };
};

const signRawPayload = (payload: unknown, secret = SECRET) => {
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signatureSegment = createHmac("sha256", secret)
    .update(payloadSegment, "ascii")
    .digest("base64url");
  return `${payloadSegment}.${signatureSegment}`;
};

const expectTokenError = (
  operation: () => unknown,
  code:
    | "BOOKING_CONFIGURATION_ERROR"
    | "BOOKING_SLOT_TOKEN_EXPIRED"
    | "BOOKING_SLOT_TOKEN_INVALID",
) => {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof BookingAvailabilityError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
};

test("creates a verifiable HMAC token that expires in exactly ten minutes", () => {
  const { service } = createHarness();
  const created = service.create(claims);
  const verified = service.verify(created.slotToken);

  assert.equal(
    created.expiresAt,
    new Date(
      ISSUED_AT.getTime() + BOOKING_SLOT_TOKEN_TTL_SECONDS * 1_000,
    ).toISOString(),
  );
  assert.deepEqual(verified, {
    version: BOOKING_SLOT_TOKEN_VERSION,
    expiration: Math.floor(ISSUED_AT.getTime() / 1_000) + 600,
    ...claims,
  });
});

test("keeps the signed payload strict and free of PII or secrets", () => {
  const { service } = createHarness();
  const created = service.create(claims);
  const [payloadSegment] = created.slotToken.split(".");
  assert.ok(payloadSegment !== undefined);
  const payload = JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf8"),
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(payload).sort(), [
    "expiration",
    "requested_date",
    "requested_time",
    "service_type_id",
    "slot_interval_minutes",
    "vehicle_id",
    "version",
    "workshop_id",
  ]);
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of [
    "customer_id",
    "registration_number",
    "vin",
    "description",
    "capacity",
    "directus",
    SECRET.toLowerCase(),
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("rejects a one-character token modification and a wrong signature", () => {
  const { service } = createHarness();
  const token = service.create(claims).slotToken;
  const replacement = token[0] === "A" ? "B" : "A";
  expectTokenError(
    () => service.verify(`${replacement}${token.slice(1)}`),
    "BOOKING_SLOT_TOKEN_INVALID",
  );

  const tokenWithWrongSignature = createHarness("different-test-secret")
    .service.create(claims).slotToken;
  expectTokenError(
    () => service.verify(tokenWithWrongSignature),
    "BOOKING_SLOT_TOKEN_INVALID",
  );
});

test("rejects an expired token", () => {
  const harness = createHarness();
  const token = harness.service.create(claims).slotToken;
  harness.setNow(
    new Date(
      ISSUED_AT.getTime() + BOOKING_SLOT_TOKEN_TTL_SECONDS * 1_000,
    ),
  );

  expectTokenError(
    () => harness.service.verify(token),
    "BOOKING_SLOT_TOKEN_EXPIRED",
  );
});

test("rejects a wrong version and additional payload properties", () => {
  const expiration = Math.floor(ISSUED_AT.getTime() / 1_000) + 600;
  const { service } = createHarness();

  expectTokenError(
    () =>
      service.verify(
        signRawPayload({ version: 2, expiration, ...claims }),
      ),
    "BOOKING_SLOT_TOKEN_INVALID",
  );
  expectTokenError(
    () =>
      service.verify(
        signRawPayload({
          version: BOOKING_SLOT_TOKEN_VERSION,
          expiration,
          ...claims,
          customer_id: 99,
        }),
      ),
    "BOOKING_SLOT_TOKEN_INVALID",
  );
});

test("returns a controlled configuration error when the secret is absent", () => {
  for (const secret of [undefined, "", "   "]) {
    const service = createBookingSlotTokenService({
      secret,
      now: () => ISSUED_AT,
    });
    expectTokenError(
      () => service.assertConfigured(),
      "BOOKING_CONFIGURATION_ERROR",
    );
    expectTokenError(
      () => service.create(claims),
      "BOOKING_CONFIGURATION_ERROR",
    );
  }
});
