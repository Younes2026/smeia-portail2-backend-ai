import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  BookingVehicleIdSchema,
  IsoDateSchema,
  IsoTimeSchema,
} from "../../domain/ai-booking/index.js";
import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_IDS,
} from "../../domain/ai-diagnostic/index.js";
import { BookingAvailabilityError } from "./booking-errors.js";

export const BOOKING_SLOT_TOKEN_VERSION = 1 as const;
export const BOOKING_SLOT_TOKEN_TTL_SECONDS = 10 * 60;

const base64UrlSegmentPattern = /^[A-Za-z0-9_-]+$/;

export const BookingSlotTokenClaimsSchema = z
  .object({
    vehicle_id: BookingVehicleIdSchema,
    service_type_id: z.literal(ALLOWED_SERVICE_TYPE_IDS),
    workshop_id: z.literal(ALLOWED_WORKSHOP_IDS),
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    slot_interval_minutes: z.number().int().positive().max(24 * 60),
  })
  .strict();

export const BookingSlotTokenPayloadSchema = BookingSlotTokenClaimsSchema.extend(
  {
    version: z.literal(BOOKING_SLOT_TOKEN_VERSION),
    expiration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  },
).strict();

export type BookingSlotTokenClaims = z.infer<
  typeof BookingSlotTokenClaimsSchema
>;
export type BookingSlotTokenPayload = z.infer<
  typeof BookingSlotTokenPayloadSchema
>;

export type CreatedBookingSlotToken = {
  slotToken: string;
  expiresAt: string;
};

export interface BookingSlotTokenService {
  assertConfigured(): void;
  create(claims: BookingSlotTokenClaims): CreatedBookingSlotToken;
  verify(slotToken: string): BookingSlotTokenPayload;
}

export type BookingSlotTokenServiceConfig = {
  secret: string | undefined;
  now(): Date;
};

const invalidToken = (): never => {
  throw new BookingAvailabilityError("BOOKING_SLOT_TOKEN_INVALID");
};

const decodeBase64UrlSegment = (segment: string) => {
  if (!base64UrlSegmentPattern.test(segment)) {
    return invalidToken();
  }

  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) {
    return invalidToken();
  }

  return decoded;
};

export const createBookingSlotTokenService = (
  config: BookingSlotTokenServiceConfig,
): BookingSlotTokenService => {
  const getSecret = () => {
    if (config.secret === undefined || config.secret.trim().length === 0) {
      throw new BookingAvailabilityError("BOOKING_CONFIGURATION_ERROR");
    }

    return config.secret;
  };

  const sign = (payloadSegment: string, secret: string) =>
    createHmac("sha256", secret).update(payloadSegment, "ascii").digest();

  return {
    assertConfigured() {
      getSecret();
    },

    create(rawClaims) {
      const secret = getSecret();
      const claims = BookingSlotTokenClaimsSchema.parse(rawClaims);
      const issuedAtSeconds = Math.floor(config.now().getTime() / 1_000);
      const payload = BookingSlotTokenPayloadSchema.parse({
        version: BOOKING_SLOT_TOKEN_VERSION,
        expiration: issuedAtSeconds + BOOKING_SLOT_TOKEN_TTL_SECONDS,
        ...claims,
      });
      const payloadSegment = Buffer.from(
        JSON.stringify(payload),
        "utf8",
      ).toString("base64url");
      const signatureSegment = sign(payloadSegment, secret).toString(
        "base64url",
      );

      return {
        slotToken: `${payloadSegment}.${signatureSegment}`,
        expiresAt: new Date(payload.expiration * 1_000).toISOString(),
      };
    },

    verify(slotToken) {
      const secret = getSecret();
      if (slotToken.length > 4_096) {
        return invalidToken();
      }

      const segments = slotToken.split(".");
      if (segments.length !== 2) {
        return invalidToken();
      }
      const [payloadSegment, signatureSegment] = segments;
      if (payloadSegment === undefined || signatureSegment === undefined) {
        return invalidToken();
      }

      const payloadBytes = decodeBase64UrlSegment(payloadSegment);
      const receivedSignature = decodeBase64UrlSegment(signatureSegment);
      const expectedSignature = sign(payloadSegment, secret);
      const comparableSignature =
        receivedSignature.length === expectedSignature.length
          ? receivedSignature
          : Buffer.alloc(expectedSignature.length);
      const signatureMatches = timingSafeEqual(
        expectedSignature,
        comparableSignature,
      );
      if (
        receivedSignature.length !== expectedSignature.length ||
        !signatureMatches
      ) {
        return invalidToken();
      }

      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(payloadBytes.toString("utf8")) as unknown;
      } catch {
        return invalidToken();
      }

      const parsedPayload = BookingSlotTokenPayloadSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        return invalidToken();
      }

      const nowSeconds = Math.floor(config.now().getTime() / 1_000);
      if (parsedPayload.data.expiration <= nowSeconds) {
        throw new BookingAvailabilityError("BOOKING_SLOT_TOKEN_EXPIRED");
      }

      return parsedPayload.data;
    },
  };
};
