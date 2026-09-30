import express, { Express } from "express";
import request from "supertest";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  correlationIdMiddleware,
  getCorrelationId,
  getRequestId,
} from "../correlationId";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildApp(): Express {
  const app = express();
  app.get("/thing", correlationIdMiddleware, (req, res) => {
    res.json({
      correlationId: getCorrelationId(req),
      requestId: getRequestId(req),
    });
  });
  return app;
}

describe("correlationIdMiddleware", () => {
  it("generates a fresh correlation ID and request ID when no header is sent", async () => {
    const app = buildApp();

    const response = await request(app).get("/thing").expect(200);

    expect(response.headers["x-correlation-id"]).toMatch(UUID_V4_PATTERN);
    expect(response.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
    // The same IDs set on the response headers are the ones attached to req
    // and readable via getCorrelationId/getRequestId downstream.
    expect(response.body.correlationId).toBe(
      response.headers["x-correlation-id"],
    );
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("honors a valid inbound X-Correlation-Id instead of generating one", async () => {
    const app = buildApp();
    const inbound = "client-supplied-correlation-id";

    const response = await request(app)
      .get("/thing")
      .set(CORRELATION_ID_HEADER, inbound)
      .expect(200);

    expect(response.headers["x-correlation-id"]).toBe(inbound);
    expect(response.body.correlationId).toBe(inbound);
  });

  it("always generates a fresh X-Request-Id even when the client sends one", async () => {
    // Per the middleware's own doc comment: request IDs are per-hop, never
    // forwarded, so distinct service legs of the same correlated trace can
    // still be told apart.
    const app = buildApp();
    const clientSuppliedRequestId = "should-be-ignored";

    const response = await request(app)
      .get("/thing")
      .set(REQUEST_ID_HEADER, clientSuppliedRequestId)
      .expect(200);

    expect(response.headers["x-request-id"]).not.toBe(clientSuppliedRequestId);
    expect(response.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
  });

  it("generates a fresh request ID on every request, even with the same correlation ID reused", async () => {
    const app = buildApp();
    const inbound = "same-trace-two-hops";

    const first = await request(app)
      .get("/thing")
      .set(CORRELATION_ID_HEADER, inbound)
      .expect(200);
    const second = await request(app)
      .get("/thing")
      .set(CORRELATION_ID_HEADER, inbound)
      .expect(200);

    expect(first.headers["x-correlation-id"]).toBe(inbound);
    expect(second.headers["x-correlation-id"]).toBe(inbound);
    expect(first.headers["x-request-id"]).not.toBe(
      second.headers["x-request-id"],
    );
  });

  describe("inbound X-Correlation-Id validation", () => {
    it("rejects an inbound ID shorter than 8 characters and generates one instead", async () => {
      const app = buildApp();

      const response = await request(app)
        .get("/thing")
        .set(CORRELATION_ID_HEADER, "short")
        .expect(200);

      expect(response.headers["x-correlation-id"]).not.toBe("short");
      expect(response.headers["x-correlation-id"]).toMatch(UUID_V4_PATTERN);
    });

    it("rejects an inbound ID longer than 128 characters and generates one instead", async () => {
      const app = buildApp();
      const tooLong = "a".repeat(129);

      const response = await request(app)
        .get("/thing")
        .set(CORRELATION_ID_HEADER, tooLong)
        .expect(200);

      expect(response.headers["x-correlation-id"]).not.toBe(tooLong);
      expect(response.headers["x-correlation-id"]).toMatch(UUID_V4_PATTERN);
    });

    it("accepts an inbound ID at exactly the 8-character lower bound", async () => {
      const app = buildApp();
      const exactly8 = "12345678";

      const response = await request(app)
        .get("/thing")
        .set(CORRELATION_ID_HEADER, exactly8)
        .expect(200);

      expect(response.headers["x-correlation-id"]).toBe(exactly8);
    });

    it("accepts an inbound ID at exactly the 128-character upper bound", async () => {
      const app = buildApp();
      const exactly128 = "a".repeat(128);

      const response = await request(app)
        .get("/thing")
        .set(CORRELATION_ID_HEADER, exactly128)
        .expect(200);

      expect(response.headers["x-correlation-id"]).toBe(exactly128);
    });

    it("trims whitespace from a valid inbound ID", async () => {
      const app = buildApp();

      const response = await request(app)
        .get("/thing")
        .set(CORRELATION_ID_HEADER, "  padded-id-12345  ")
        .expect(200);

      expect(response.headers["x-correlation-id"]).toBe("padded-id-12345");
    });

    it("rejects an inbound ID that is only whitespace and generates one instead", async () => {
      const app = buildApp();

      const response = await request(app)
        .get("/thing")
        .set(CORRELATION_ID_HEADER, "           ")
        .expect(200);

      expect(response.headers["x-correlation-id"]).toMatch(UUID_V4_PATTERN);
    });
  });

  describe("getCorrelationId / getRequestId", () => {
    it("return undefined before the middleware has run", () => {
      const req = {} as unknown as Parameters<typeof getCorrelationId>[0];
      expect(getCorrelationId(req)).toBeUndefined();
      expect(getRequestId(req)).toBeUndefined();
    });
  });
});
