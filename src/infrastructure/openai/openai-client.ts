import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputContent,
  ResponseStatus,
} from "openai/resources/responses/responses";

import {
  AiDiagnosticModelOutputSchema,
  type AiDiagnosticModelOutput,
} from "../../domain/ai-diagnostic/index.js";

const aiDiagnosticTextFormat = zodTextFormat(
  AiDiagnosticModelOutputSchema,
  "smeia_ai_diagnostic",
);

type BuildAiDiagnosticOpenAIRequestOptions = {
  model: string;
  instructions: string;
  inputText: string;
  imageDataUrl: string | null;
};

export const buildAiDiagnosticOpenAIRequest = (
  options: BuildAiDiagnosticOpenAIRequestOptions,
) => {
  const content: ResponseInputContent[] = [
    {
      type: "input_text",
      text: options.inputText,
    },
  ];

  if (options.imageDataUrl !== null) {
    content.push({
      type: "input_image",
      image_url: options.imageDataUrl,
      detail: "high",
    });
  }

  return {
    model: options.model,
    instructions: options.instructions,
    input: [
      {
        role: "user",
        content,
      },
    ],
    text: {
      format: aiDiagnosticTextFormat,
    },
    store: false,
  } satisfies ResponseCreateParamsNonStreaming;
};

export type AiDiagnosticOpenAIRequest = ReturnType<
  typeof buildAiDiagnosticOpenAIRequest
>;

export type AiDiagnosticOpenAIResponse = {
  status: ResponseStatus | undefined;
  outputParsed: unknown;
  refused: boolean;
};

export interface AiDiagnosticOpenAIClient {
  createResponse(
    request: AiDiagnosticOpenAIRequest,
  ): Promise<AiDiagnosticOpenAIResponse>;
}

export type OpenAIClientConfig = {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
};

export type AiDiagnosticOpenAIClientFactory = (
  config: OpenAIClientConfig,
) => AiDiagnosticOpenAIClient;

const containsRefusal = (response: {
  output: Array<{
    type: string;
    content?: Array<{ type: string }>;
  }>;
}) =>
  response.output.some(
    (item) =>
      item.type === "message" &&
      item.content?.some((content) => content.type === "refusal") === true,
  );

export const createOpenAIClient: AiDiagnosticOpenAIClientFactory = (config) => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  return {
    async createResponse(request) {
      const response = await client.responses.parse(request);

      return {
        status: response.status,
        outputParsed: response.output_parsed as AiDiagnosticModelOutput | null,
        refused: containsRefusal(response),
      };
    },
  };
};
