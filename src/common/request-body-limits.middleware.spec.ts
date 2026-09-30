import { Request, Response } from "express";
import { jsonBodyDepthLimit, MAX_JSON_NESTING_DEPTH } from "./request-body-limits.middleware";

describe("jsonBodyDepthLimit", () => {
  function invoke(body: unknown) {
    const request = { body } as Request;
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn();

    jsonBodyDepthLimit(request, response, next);
    return { response, next };
  }

  it("accepts a body at the configured maximum depth", () => {
    let body: unknown = "value";
    for (let depth = 0; depth < MAX_JSON_NESTING_DEPTH; depth++) {
      body = { child: body };
    }

    const { response, next } = invoke(body);
    expect(response.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a body deeper than the configured maximum", () => {
    let body: unknown = "value";
    for (let depth = 0; depth <= MAX_JSON_NESTING_DEPTH; depth++) {
      body = { child: body };
    }

    const { response, next } = invoke(body);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
