import { z } from "zod";

import type { AiDiagnosticModelOutput } from "../../domain/ai-diagnostic/index.js";
import {
  DirectusError,
  getDirectusAiCatalogs,
  getDirectusVehicleContext,
  type DirectusAiCatalogs,
  type DirectusVehicleContext,
} from "../../infrastructure/directus/index.js";
import {
  AiDiagnosticImageSchema,
  type AiDiagnosticInput,
} from "./ai-diagnostic.input.js";
import { analyzeAiDiagnostic } from "./ai-diagnostic.service.js";

const answerSchema = z
  .object({
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const AnalyzeAiDiagnosticRequestSchema = z
  .object({
    vehicle_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    description: z.string().trim().min(10).max(3_000),
    answers: z.array(answerSchema).max(5).default([]),
    photo: AiDiagnosticImageSchema.nullable().default(null),
  })
  .strict();

export type AnalyzeAiDiagnosticRequest = z.infer<
  typeof AnalyzeAiDiagnosticRequestSchema
>;

export type AnalyzeAiDiagnosticUseCaseDependencies = {
  getVehicleContext(
    accessToken: string,
    vehicleId: unknown,
  ): Promise<DirectusVehicleContext>;
  getAiCatalogs(accessToken: string): Promise<DirectusAiCatalogs>;
  analyzeDiagnostic(input: unknown): Promise<AiDiagnosticModelOutput>;
};

export type AnalyzeAiDiagnosticUseCase = (
  accessToken: string,
  request: unknown,
) => Promise<AiDiagnosticModelOutput>;

const buildInternalInput = (
  request: AnalyzeAiDiagnosticRequest,
  vehicle: DirectusVehicleContext,
  catalogs: DirectusAiCatalogs,
): AiDiagnosticInput => ({
  problem_description: request.description,
  vehicle: {
    brand: vehicle.brand,
    model: vehicle.model,
    year: vehicle.year,
    mileage: vehicle.mileage,
  },
  previous_answers: request.answers.map((answer, index) => ({
    question_id: `answer-${index + 1}`,
    question: answer.question,
    answer: answer.answer,
  })),
  available_services: catalogs.available_services,
  available_workshops: catalogs.available_workshops,
  image: request.photo,
});

export const createAnalyzeAiDiagnosticUseCase = (
  dependencies: AnalyzeAiDiagnosticUseCaseDependencies,
): AnalyzeAiDiagnosticUseCase =>
  async (accessToken, rawRequest) => {
    if (accessToken.trim().length === 0) {
      throw new DirectusError("DIRECTUS_UNAUTHORIZED");
    }

    const request = AnalyzeAiDiagnosticRequestSchema.parse(rawRequest);
    const [vehicle, catalogs] = await Promise.all([
      dependencies.getVehicleContext(accessToken, request.vehicle_id),
      dependencies.getAiCatalogs(accessToken),
    ]);

    return dependencies.analyzeDiagnostic(
      buildInternalInput(request, vehicle, catalogs),
    );
  };

export const analyzeAiDiagnosticUseCase = createAnalyzeAiDiagnosticUseCase({
  getVehicleContext: getDirectusVehicleContext,
  getAiCatalogs: getDirectusAiCatalogs,
  analyzeDiagnostic: analyzeAiDiagnostic,
});
