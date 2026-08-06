import { env } from "../../config/env.js";
import {
  AiDiagnosticModelOutputSchema,
  type AiDiagnosticModelOutput,
  validateAiDiagnosticBusinessRules,
} from "../../domain/ai-diagnostic/index.js";
import {
  AiDiagnosticError,
  buildAiDiagnosticOpenAIRequest,
  createOpenAIClient,
  mapOpenAIError,
  type AiDiagnosticOpenAIClientFactory,
} from "../../infrastructure/openai/index.js";
import {
  AiDiagnosticInputSchema,
  type AiDiagnosticInput,
} from "./ai-diagnostic.input.js";
import {
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

const validateCatalogSelections = (
  output: AiDiagnosticModelOutput,
  input: AiDiagnosticInput,
) => {
  if (output.image_analysis.image_provided !== (input.image !== null)) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
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
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
  }

  if (
    output.suggested_workshop_ids.some(
      (workshopId) => !availableWorkshopIds.has(workshopId),
    )
  ) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
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
        throw mapOpenAIError(error);
      }

      if (providerResponse.refused) {
        throw new AiDiagnosticError("AI_REFUSED");
      }

      if (providerResponse.status === "incomplete") {
        throw new AiDiagnosticError("AI_INVALID_OUTPUT");
      }

      if (providerResponse.status !== "completed") {
        throw new AiDiagnosticError("AI_PROVIDER_ERROR");
      }

      const parsedOutput = AiDiagnosticModelOutputSchema.safeParse(
        providerResponse.outputParsed,
      );
      if (!parsedOutput.success) {
        throw new AiDiagnosticError("AI_INVALID_OUTPUT");
      }

      const businessRulesResult = validateAiDiagnosticBusinessRules(
        parsedOutput.data,
      );
      if (!businessRulesResult.success) {
        throw new AiDiagnosticError("AI_INVALID_OUTPUT");
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
