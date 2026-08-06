import type { RequestHandler, Response } from "express";

import { HttpError } from "./error-handler.js";

const MAX_BEARER_TOKEN_LENGTH = 4_096;
const bearerTokenPattern = /^[A-Za-z0-9._~+/-]+=*$/;
const tokenByResponse = new WeakMap<Response, string>();

export const bearerAuthMiddleware: RequestHandler = (
  request,
  response,
  next,
) => {
  const authorization = request.get("Authorization");
  const match = /^Bearer (.+)$/i.exec(authorization ?? "");
  const token = match?.[1];

  if (
    token === undefined ||
    token.length === 0 ||
    token.length > MAX_BEARER_TOKEN_LENGTH ||
    !bearerTokenPattern.test(token)
  ) {
    next(
      new HttpError(
        401,
        "AUTHORIZATION_REQUIRED",
        "A valid Bearer authorization header is required.",
      ),
    );
    return;
  }

  tokenByResponse.set(response, token);
  next();
};

export const getDirectusAccessToken = (response: Response) => {
  const token = tokenByResponse.get(response);
  if (token === undefined) {
    throw new HttpError(
      401,
      "AUTHORIZATION_REQUIRED",
      "A valid Bearer authorization header is required.",
    );
  }

  return token;
};
