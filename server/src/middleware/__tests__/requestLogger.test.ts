import express, { Express } from "express";
import request from "supertest";
import { correlationIdMiddleware } from "../correlationId";
import { errorHandler, requestLoggerMiddleware } from "../requestLogger";

/**
 * requestLoggerMiddleware logs on the response's "finish" event, which fires
 * after supertest's request() promise has already resolved. Every assertion
 * on the logged line polls briefly rather than asserting immediately after
 * the response comes back.
 */
function waitFor(assertion: () => void, timeoutMs = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      try {
        assertion();
        resolve();
      } catch (err) {
        if (Date.now() - start > timeoutMs) {
          reject(err);
        } else {
          setTimeout(attempt, 5);
        }
      }
    };
    attempt();
  });
}

describe("requestLoggerMiddleware", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function buildApp(): Express {
    const app = express();
    app.use(correlationIdMiddleware);
    app.use(requestLoggerMiddleware);
    app.get("/thing", (_req, res) => res.json({ ok: true }));
    app.get("/boom", (_req, res) => res.status(503).json({ ok: false }));
    return app;
  }

  it("logs method, path, status, and duration for a successful request", async () => {
    const app = buildApp();

    await request(app).get("/thing").expect(200);

    await waitFor(() => {
      expect(logSpy).toHaveBeenCalled();
      const line = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(line).toMatchObject({
        level: "info",
        method: "GET",
        path: "/thing",
        status: 200,
      });
      expect(typeof line.durationMs).toBe("number");
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof line.ts).toBe("string");
    });
  });

  it("logs the correlation ID and request ID attached by correlationIdMiddleware", async () => {
    const app = buildApp();

    const response = await request(app)
      .get("/thing")
      .set("x-correlation-id", "trace-abc-12345")
      .expect(200);

    await waitFor(() => {
      const line = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(line.correlationId).toBe("trace-abc-12345");
      expect(line.requestId).toBe(response.headers["x-request-id"]);
    });
  });

  it("logs a non-2xx status without treating it as a thrown error", async () => {
    const app = buildApp();

    await request(app).get("/boom").expect(503);

    await waitFor(() => {
      const line = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(line.level).toBe("info");
      expect(line.status).toBe(503);
    });
  });

  it("logs the original request path even when query parameters are present", async () => {
    const app = buildApp();

    await request(app).get("/thing?foo=bar").expect(200);

    await waitFor(() => {
      const line = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(line.path).toBe("/thing?foo=bar");
    });
  });
});

describe("errorHandler", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function buildApp(thrown: unknown): Express {
    const app = express();
    app.use(correlationIdMiddleware);
    app.get("/thing", () => {
      throw thrown;
    });
    app.use(errorHandler);
    return app;
  }

  it("responds 500 with the correlation ID and request ID in the JSON body", async () => {
    const app = buildApp(new Error("boom"));

    const response = await request(app).get("/thing").expect(500);

    expect(response.body).toMatchObject({ error: "Internal server error." });
    expect(response.body.correlationId).toBe(
      response.headers["x-correlation-id"],
    );
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("logs the error's name and message alongside the correlation ID", async () => {
    const app = buildApp(new TypeError("not a function"));

    await request(app)
      .get("/thing")
      .set("x-correlation-id", "err-trace-12345")
      .expect(500);

    expect(errorSpy).toHaveBeenCalled();
    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      level: "error",
      correlationId: "err-trace-12345",
      error: { name: "TypeError", message: "not a function" },
    });
  });

  it("falls back to a generic error shape when a non-Error value is thrown", async () => {
    const app = buildApp("a plain string, not an Error");

    await request(app).get("/thing").expect(500);

    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(line.error).toEqual({ name: "Error", message: "Unexpected error" });
  });

  it("does not attempt to send a second response once headers are already sent", async () => {
    const app = express();
    app.use(correlationIdMiddleware);
    app.get("/thing", (_req, res, next) => {
      res.status(200).json({ partial: true });
      next(new Error("late failure after the response was already sent"));
    });
    app.use(errorHandler);

    const response = await request(app).get("/thing").expect(200);

    // errorHandler must not throw (e.g. "Cannot set headers after they are
    // sent") when invoked after the handler already responded.
    expect(response.body).toEqual({ partial: true });
    expect(errorSpy).toHaveBeenCalled();
  });
});
