import { RequestHandler } from "express";

export const MAX_REQUEST_BODY_SIZE = "64kb";
export const MAX_JSON_NESTING_DEPTH = 20;

export const jsonBodyDepthLimit: RequestHandler = (request, response, next) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: request.body, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (current.depth >= MAX_JSON_NESTING_DEPTH) {
      response.status(400).json({
        statusCode: 400,
        message: `JSON body exceeds the maximum nesting depth of ${MAX_JSON_NESTING_DEPTH}`,
      });
      return;
    }
    for (const value of Object.values(current.value)) {
      pending.push({ value, depth: current.depth + 1 });
    }
  }

  next();
};
