import { RequestHandler, Response } from "express";

export const MAX_REQUEST_BODY_SIZE = "64kb";
export const MAX_JSON_NESTING_DEPTH = 20;

function parseByteSize(value: string): number {
  const match = /^(\d+)(b|kb|mb)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid byte size string: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  return amount * multiplier;
}

const MAX_REQUEST_BODY_SIZE_BYTES = parseByteSize(MAX_REQUEST_BODY_SIZE);

function rejectOversizedBody(response: Response): void {
  response.status(413).json({
    statusCode: 413,
    message: `Request body exceeds the maximum size of ${MAX_REQUEST_BODY_SIZE}`,
  });
}

/**
 * Rejects on the declared Content-Length before any body bytes are read,
 * so an oversized request is never buffered just to be discarded. A missing
 * or malformed Content-Length (chunked encoding, or a header that lies)
 * falls back to counting bytes as they stream in.
 */
export const requestBodySizeLimit: RequestHandler = (request, response, next) => {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_SIZE_BYTES) {
    rejectOversizedBody(response);
    return;
  }

  let bytesRead = 0;
  let rejected = false;
  request.on("data", (chunk: Buffer) => {
    if (rejected) return;
    bytesRead += chunk.length;
    if (bytesRead > MAX_REQUEST_BODY_SIZE_BYTES) {
      rejected = true;
      request.destroy();
      if (!response.headersSent) {
        rejectOversizedBody(response);
      }
    }
  });

  next();
};

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
