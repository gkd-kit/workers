import { env, exports } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

const makeSnapshotZip = (id: number): Uint8Array => {
  return zipSync(
    {
      "snapshot.json": strToU8(JSON.stringify({ id, nodes: [] })),
      "screenshot.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
    { level: 0 },
  );
};

const makeAttachmentResponse = (id: number): Response => {
  const bytes = makeSnapshotZip(id);
  return new Response(bytes, {
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "application/zip",
    },
  });
};

const postDetection = (id: number, importId: number): Promise<Response> => {
  return exports.default.fetch(
    "https://worker.test/snapshot-detect/detectSnapshot",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, importId }),
    },
  );
};

const postBuildAsset = (
  body: BodyInit,
  contentType?: string,
  query = "",
): Promise<Response> => {
  return exports.default.fetch(
    `https://worker.test/build-asset/createBuildAsset${query}`,
    {
      method: "POST",
      ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      body,
    },
  );
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing and CORS", () => {
  it("returns JSON errors with HTTP 200 and 204 for preflight", async () => {
    const missing = await exports.default.fetch("https://worker.test/missing");
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({
      error: true,
      message: "Not Found",
    });

    const unknownApi = await exports.default.fetch(
      "https://worker.test/snapshot-detect/unknown",
    );
    expect(unknownApi.status).toBe(200);

    const preflight = await exports.default.fetch(
      "https://worker.test/proxy",
      { method: "OPTIONS" },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toBe(
      "GET,HEAD,POST,OPTIONS",
    );
    expect(preflight.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns HTTP 200 errors for unsupported methods", async () => {
    const response = await exports.default.fetch(
      "https://worker.test/snapshot-detect/getImportId?id=123",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");

    const detection = await exports.default.fetch(
      "https://worker.test/snapshot-detect/detectSnapshot",
      { method: "PUT" },
    );
    expect(detection.status).toBe(200);
    expect(detection.headers.get("allow")).toBe(
      "GET, HEAD, POST, OPTIONS",
    );
  });

  it("serves HEAD through registered GET routes", async () => {
    const response = await exports.default.fetch(
      "https://worker.test/snapshot-detect/getImportId?id=123",
      { method: "HEAD" },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("snapshot detection", () => {
  it("returns null before insertion and persists a verified mapping", async () => {
    const lookupBefore = await exports.default.fetch(
      "https://worker.test/snapshot-detect/getImportId?id=123",
    );
    expect(lookupBefore.status).toBe(200);
    expect(await lookupBefore.json()).toBeNull();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(makeAttachmentResponse(123)));
    const created = await postDetection(123, 456);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      id: 123,
      importId: 456,
      created: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/user-attachments/files/456/file.zip",
    );

    const lookupAfter = await exports.default.fetch(
      "https://worker.test/snapshot-detect/getImportId?id=123",
    );
    expect(await lookupAfter.json()).toBe(456);
    const row = await env.DB.prepare(
      "SELECT id, import_id FROM snapshot WHERE id = ?",
    )
      .bind(123)
      .first();
    expect(row).toEqual({ id: 123, import_id: 456 });
  });

  it("is idempotent and skips the attachment fetch for existing rows", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(makeAttachmentResponse(123)),
    );
    expect((await postDetection(123, 456)).status).toBe(200);
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const duplicate = await postDetection(123, 999);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({
      id: 123,
      importId: 456,
      created: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles concurrent writes without overwriting the winning mapping", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(makeAttachmentResponse(123));
    });
    const responses = await Promise.all([
      postDetection(123, 456),
      postDetection(123, 789),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const stored = await env.DB.prepare(
      "SELECT import_id FROM snapshot WHERE id = 123",
    ).first<{ import_id: number }>();
    expect([456, 789]).toContain(stored?.import_id);
  });

  it("lists stored snapshots", async () => {
    await env.DB.prepare(
      "INSERT INTO snapshot (id, import_id) VALUES (?, ?), (?, ?)",
    )
      .bind(2, 20, 1, 10)
      .run();
    const response = await exports.default.fetch(
      "https://worker.test/snapshot-detect/getSnapshotList",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 1, import_id: 10 },
      { id: 2, import_id: 20 },
    ]);
  });

  it("supports the legacy GET parameters for detection", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(makeAttachmentResponse(123)),
    );
    const response = await exports.default.fetch(
      "https://worker.test/snapshot-detect/detectSnapshot?id=123&importId=456",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 123,
      importId: 456,
      created: true,
    });
  });

  it("rejects invalid parameters and mismatched snapshots", async () => {
    const invalid = await exports.default.fetch(
      "https://worker.test/snapshot-detect/getImportId?id=9007199254740992",
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({
      error: true,
      message: "id must be a positive safe integer",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(makeAttachmentResponse(999)),
    );
    const mismatch = await postDetection(123, 456);
    expect(mismatch.status).toBe(200);
    expect(await mismatch.json()).toEqual({
      error: true,
      message: "snapshot.json id 999 does not match requested id 123",
    });
  });

  it("rejects malformed archives", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    );
    const response = await postDetection(123, 456);
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      error: true,
    });
  });
});

describe("build assets", () => {
  it("returns null before creation and reads a JSON-created asset", async () => {
    const missing = await exports.default.fetch(
      "https://worker.test/build-asset/getBuildAsset?buildKey=release%3A1",
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toBeNull();

    const created = await postBuildAsset(
      JSON.stringify({ buildKey: "release:1", assetId: 456 }),
      "application/json",
    );
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      buildKey: "release:1",
      assetId: 456,
    });

    const found = await exports.default.fetch(
      "https://worker.test/build-asset/getBuildAsset?buildKey=release%3A1",
    );
    expect(await found.json()).toEqual({ assetId: 456 });
    expect(
      await env.DB.prepare(
        "SELECT build_key, asset_id FROM build_asset WHERE build_key = ?",
      )
        .bind("release:1")
        .first(),
    ).toEqual({ build_key: "release:1", asset_id: 456 });
  });

  it("upserts an existing build key", async () => {
    await postBuildAsset(
      JSON.stringify({ buildKey: "release:1", assetId: 456 }),
      "application/json",
    );
    const updated = await postBuildAsset(
      JSON.stringify({ buildKey: "release:1", assetId: 789 }),
      "application/json",
    );
    expect(await updated.json()).toEqual({
      buildKey: "release:1",
      assetId: 789,
    });
    const found = await exports.default.fetch(
      "https://worker.test/build-asset/getBuildAsset?buildKey=release%3A1",
    );
    expect(await found.json()).toEqual({ assetId: 789 });
  });

  it("accepts URL-encoded and multipart forms", async () => {
    const urlEncoded = await postBuildAsset(
      new URLSearchParams({ buildKey: "form:1", assetId: "123" }),
      "application/x-www-form-urlencoded",
    );
    expect(await urlEncoded.json()).toEqual({
      buildKey: "form:1",
      assetId: 123,
    });

    const form = new FormData();
    form.set("buildKey", "form:2");
    form.set("assetId", "234");
    const multipart = await postBuildAsset(form);
    expect(await multipart.json()).toEqual({
      buildKey: "form:2",
      assetId: 234,
    });
  });

  it("rejects forbidden parameter sources and malformed values", async () => {
    const invalidGet = await exports.default.fetch(
      "https://worker.test/build-asset/getBuildAsset?buildKey=a&extra=b",
    );
    expect(await invalidGet.json()).toEqual({
      error: true,
      message: "GET query must contain exactly one buildKey",
    });

    const queryPost = await postBuildAsset(
      JSON.stringify({ buildKey: "a", assetId: 1 }),
      "application/json",
      "?extra=b",
    );
    expect(await queryPost.json()).toEqual({
      error: true,
      message: "POST query parameters are not allowed",
    });

    for (const body of [
      { buildKey: "", assetId: 1 },
      { buildKey: " a", assetId: 1 },
      { buildKey: "a", assetId: 0 },
      { buildKey: "a", assetId: 2147483648 },
      { buildKey: "a", assetId: "1" },
      { buildKey: "a", assetId: 1, extra: true },
    ]) {
      const response = await postBuildAsset(
        JSON.stringify(body),
        "application/json",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ error: true });
    }
  });

  it("rejects unsupported or oversized bodies", async () => {
    const unsupported = await postBuildAsset("buildKey=a&assetId=1", "text/plain");
    expect(await unsupported.json()).toEqual({
      error: true,
      message: "Content-Type must be JSON or form data",
    });

    const oversized = await postBuildAsset(
      JSON.stringify({ buildKey: "a".repeat(4096), assetId: 1 }),
      "application/json",
    );
    expect(await oversized.json()).toEqual({
      error: true,
      message: "Request body is too large",
    });
  });
});

describe("GET proxy", () => {
  it("streams the upstream response and strips sensitive headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response("proxied", {
          status: 206,
          headers: {
            "Content-Type": "text/plain",
            "Content-Range": "bytes 0-6/7",
            "Set-Cookie": "secret=value",
            "X-Upstream-Secret": "hidden",
          },
        }),
      ),
    );
    const response = await exports.default.fetch(
      "https://worker.test/proxy?url=https%3A%2F%2Fexample.com%2Ffile",
      { headers: { Range: "bytes=0-6", Cookie: "private=value" } },
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("proxied");
    expect(response.headers.get("content-range")).toBe("bytes 0-6/7");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream-secret")).toBeNull();
    const upstreamInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const upstreamHeaders = new Headers(upstreamInit.headers);
    expect(upstreamHeaders.get("range")).toBe("bytes=0-6");
    expect(upstreamHeaders.get("cookie")).toBeNull();
  });

  it("follows and revalidates redirects", async () => {
    let requestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      requestCount++;
      return Promise.resolve(
        requestCount === 1
          ? new Response(null, {
              status: 302,
              headers: { Location: "https://cdn.example.com/final" },
            })
          : new Response("done"),
      );
    });
    const response = await exports.default.fetch(
      "https://worker.test/proxy?url=https%3A%2F%2Fexample.com%2Fstart",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects to unsafe targets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "https://127.0.0.1/private" },
        }),
      ),
    );
    const response = await exports.default.fetch(
      "https://worker.test/proxy?url=https%3A%2F%2Fexample.com%2Fstart",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe targets before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const target of [
      "http://example.com",
      "https://127.0.0.1/data",
      "https://localhost/data",
      "https://worker.test/proxy",
      "https://user:pass@example.com/data",
    ]) {
      const response = await exports.default.fetch(
        `https://worker.test/proxy?url=${encodeURIComponent(target)}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ error: true });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a JSON error when the native limiter rejects the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await app.request(
      "https://worker.test/proxy?url=https%3A%2F%2Fexample.com%2Ffile",
      undefined,
      {
        RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: false }),
        } as RateLimit,
      } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      error: true,
      message: "Too many proxy requests",
    });
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
