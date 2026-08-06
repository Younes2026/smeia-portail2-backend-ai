import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_IDS,
} from "../../domain/ai-diagnostic/index.js";

export const MAX_AI_DIAGNOSTIC_IMAGE_BYTES = 5 * 1024 * 1024;

const allowedImageMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const AiDiagnosticImageSchema = z
  .object({
    mime_type: z.enum(allowedImageMimeTypes),
    data_url: z.string().min(1),
  })
  .strict()
  .superRefine((image, context) => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      image.data_url,
    );

    if (match === null || match[2] === undefined || match[1] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["data_url"],
        message: "The image must be a valid base64 data URL.",
      });
      return;
    }

    if (match[1] !== image.mime_type) {
      context.addIssue({
        code: "custom",
        path: ["data_url"],
        message: "The data URL MIME type must match the declared image type.",
      });
    }

    const base64Payload = match[2];
    if (base64Payload.length % 4 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["data_url"],
        message: "The image must contain valid base64 data.",
      });
      return;
    }

    if (
      Buffer.byteLength(base64Payload, "base64") >
      MAX_AI_DIAGNOSTIC_IMAGE_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["data_url"],
        message: "The decoded image must not exceed 5 MB.",
      });
    }
  });

export const AiDiagnosticInputSchema = z
  .object({
    problem_description: z.string().trim().min(10).max(3_000),
    vehicle: z
      .object({
        brand: z.string().trim().min(1),
        model: z.string().trim().min(1).nullable(),
        year: z.number().int().nullable(),
        mileage: z.number().int().min(0).nullable().default(null),
      })
      .strict(),
    previous_answers: z
      .array(
        z
          .object({
            question_id: z.string().trim().min(1).max(100),
            question: z.string().trim().min(1).max(300),
            answer: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      )
      .max(5),
    available_services: z.array(
      z
        .object({
          id: z.literal(ALLOWED_SERVICE_TYPE_IDS),
          name: z.string().trim().min(1),
          code: z.string().trim().min(1).nullable(),
        })
        .strict(),
    ),
    available_workshops: z.array(
      z
        .object({
          id: z.literal(ALLOWED_WORKSHOP_IDS),
          name: z.string().trim().min(1),
          workshop_type: z.string().trim().min(1),
        })
        .strict(),
    ),
    image: AiDiagnosticImageSchema.nullable(),
  })
  .strict();

export type AiDiagnosticInput = z.infer<typeof AiDiagnosticInputSchema>;
export type AiDiagnosticImage = z.infer<typeof AiDiagnosticImageSchema>;
