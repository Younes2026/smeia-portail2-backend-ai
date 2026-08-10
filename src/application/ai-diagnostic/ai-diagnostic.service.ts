import { env } from "../../config/env.js";
import {
  AiDiagnosticModelOutputSchema,
  getCompatibleWorkshopIdsForServiceCode,
  type AiDiagnosticModelOutput,
  validateAiDiagnosticBusinessRules,
} from "../../domain/ai-diagnostic/index.js";
import {
  AiDiagnosticError,
  buildAiDiagnosticOpenAIRequest,
  createOpenAIClient,
  getSafeZodIssuePaths,
  mapOpenAIError,
  sanitizeAiDiagnosticIssuePaths,
  type AiDiagnosticIssuePath,
  type AiDiagnosticOpenAIClientFactory,
  type AiInvalidOutputReason,
} from "../../infrastructure/openai/index.js";
import {
  AiDiagnosticInputSchema,
  type AiDiagnosticInput,
} from "./ai-diagnostic.input.js";
import {
  AI_DIAGNOSTIC_PROMPT_VERSION,
  AI_DIAGNOSTIC_SYSTEM_PROMPT,
  buildAiDiagnosticInputText,
} from "./ai-diagnostic.prompt.js";

type AiDiagnosticServiceConfig = {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  maxRetries: number;
};

type AiDiagnosticServiceDependencies = {
  clientFactory?: AiDiagnosticOpenAIClientFactory;
};

export type AiDiagnosticService = {
  analyzeAiDiagnostic(input: unknown): Promise<AiDiagnosticModelOutput>;
};

const createInvalidOutputError = (
  reason: AiInvalidOutputReason,
  issuePaths: readonly AiDiagnosticIssuePath[] = [],
) =>
  new AiDiagnosticError("AI_INVALID_OUTPUT", {
    reason,
    issue_paths: [...issuePaths],
    prompt_version: AI_DIAGNOSTIC_PROMPT_VERSION,
  });

const validateCatalogSelections = (
  output: AiDiagnosticModelOutput,
  input: AiDiagnosticInput,
) => {
  if (output.image_analysis.image_provided !== (input.image !== null)) {
    throw createInvalidOutputError("IMAGE_FLAG_MISMATCH", [
      "image_analysis.image_provided",
    ]);
  }

  const availableServiceIds = new Set(
    input.available_services.map((service) => service.id),
  );
  const availableWorkshopIds = new Set(
    input.available_workshops.map((workshop) => workshop.id),
  );

  if (
    output.suggested_service_type_id !== null &&
    !availableServiceIds.has(output.suggested_service_type_id)
  ) {
    throw createInvalidOutputError("SERVICE_NOT_IN_CATALOG", [
      "suggested_service_type_id",
    ]);
  }

  if (
    output.suggested_workshop_ids.some(
      (workshopId) => !availableWorkshopIds.has(workshopId),
    )
  ) {
    throw createInvalidOutputError("WORKSHOP_NOT_IN_CATALOG", [
      "suggested_workshop_ids",
    ]);
  }

  if (output.suggested_service_type_id === null) {
    return;
  }

  const suggestedService = input.available_services.find(
    (service) => service.id === output.suggested_service_type_id,
  );
  const compatibleWorkshopIds =
    suggestedService?.code === null || suggestedService?.code === undefined
      ? undefined
      : getCompatibleWorkshopIdsForServiceCode(suggestedService.code) ??
        undefined;

  if (
    compatibleWorkshopIds === undefined ||
    output.suggested_workshop_ids.some(
      (workshopId) => !compatibleWorkshopIds.has(workshopId),
    )
  ) {
    throw createInvalidOutputError("SERVICE_WORKSHOP_MISMATCH", [
      "suggested_service_type_id",
      "suggested_workshop_ids",
    ]);
  }
};

export const createAiDiagnosticService = (
  config: AiDiagnosticServiceConfig,
  dependencies: AiDiagnosticServiceDependencies = {},
): AiDiagnosticService => {
  const clientFactory = dependencies.clientFactory ?? createOpenAIClient;

  return {
    async analyzeAiDiagnostic(rawInput) {
      const input = AiDiagnosticInputSchema.parse(rawInput);

      if (config.apiKey === undefined || config.apiKey.trim().length === 0) {
        throw new AiDiagnosticError("AI_NOT_CONFIGURED");
      }

      const request = buildAiDiagnosticOpenAIRequest({
        model: config.model,
        instructions: AI_DIAGNOSTIC_SYSTEM_PROMPT,
        inputText: buildAiDiagnosticInputText(input),
        imageDataUrl: input.image?.data_url ?? null,
      });

      let providerResponse;
      try {
        const client = clientFactory({
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
        });
        providerResponse = await client.createResponse(request);
      } catch (error: unknown) {
        throw mapOpenAIError(error, AI_DIAGNOSTIC_PROMPT_VERSION);
      }

      if (providerResponse.refused) {
        throw new AiDiagnosticError("AI_REFUSED");
      }

      if (providerResponse.status === "incomplete") {
        throw createInvalidOutputError("RESPONSE_INCOMPLETE");
      }

      if (providerResponse.status !== "completed") {
        throw new AiDiagnosticError("AI_PROVIDER_ERROR");
      }

      if (
        providerResponse.outputParsed === null ||
        providerResponse.outputParsed === undefined
      ) {
        throw createInvalidOutputError("OUTPUT_PARSED_MISSING");
      }

      const parsedOutput = AiDiagnosticModelOutputSchema.safeParse(
        providerResponse.outputParsed,
      );
      if (!parsedOutput.success) {
        throw createInvalidOutputError(
          "MODEL_SCHEMA_VIOLATION",
          getSafeZodIssuePaths(parsedOutput.error),
        );
      }

      const businessRulesResult = validateAiDiagnosticBusinessRules(
        parsedOutput.data,
      );
      if (!businessRulesResult.success) {
        throw createInvalidOutputError(
          "BUSINESS_RULE_VIOLATION",
          sanitizeAiDiagnosticIssuePaths(
            businessRulesResult.error.issues.map((issue) => issue.path),
          ),
        );
      }

      validateCatalogSelections(parsedOutput.data, input);

      return parsedOutput.data;
    },
  };
};

const defaultAiDiagnosticService = createAiDiagnosticService({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_MODEL,
  timeoutMs: env.OPENAI_TIMEOUT_MS,
  maxRetries: env.OPENAI_MAX_RETRIES,
});

export const analyzeAiDiagnostic = (input: unknown) =>
  defaultAiDiagnosticService.analyzeAiDiagnostic(input);
