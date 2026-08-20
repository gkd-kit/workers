import { ApiError, type ErrorResponse } from "./errors";

const MAX_BUILD_KEY_SIZE = 256;
const MAX_REQUEST_BODY_SIZE = 4096;
const JSON_CONTENT_TYPE = "application/json";
const URL_ENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";
const MULTIPART_CONTENT_TYPE = "multipart/form-data";
const textEncoder = new TextEncoder();

type BuildAssetRow = {
  asset_id: number;
};

type BuildAssetListRow = {
  build_key: string;
  asset_id: number;
};

type BuildAsset = {
  buildKey: string;
  assetId: number;
};

export type GetBuildAssetResponse =
  | Pick<BuildAsset, "assetId">
  | null
  | ErrorResponse;

export type GetBuildAssetListResponse = BuildAsset[] | ErrorResponse;

export type CreateBuildAssetResponse = BuildAsset | ErrorResponse;

const parseBuildKey = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    textEncoder.encode(value).byteLength > MAX_BUILD_KEY_SIZE
  ) {
    throw new ApiError(
      `buildKey must be a non-empty string of at most ${MAX_BUILD_KEY_SIZE} UTF-8 bytes without surrounding whitespace`,
    );
  }
  return value;
};

const parseAssetId = (value: unknown, allowString: boolean): number => {
  const numberValue =
    allowString && typeof value === "string" && /^[0-9]+$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof numberValue !== "number" ||
    !Number.isInteger(numberValue) ||
    numberValue <= 0 ||
    numberValue > 2147483647
  ) {
    throw new ApiError("assetId must be a positive 32-bit integer");
  }
  return numberValue;
};

const assertExactKeys = (keys: Iterable<string>): void => {
  const values = [...keys];
  if (
    values.length !== 2 ||
    !values.includes("buildKey") ||
    !values.includes("assetId")
  ) {
    throw new ApiError("Request body must contain only buildKey and assetId");
  }
};

const readBodyBytes = async (request: Request): Promise<Uint8Array> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BODY_SIZE
  ) {
    throw new ApiError("Request body is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BODY_SIZE) {
    throw new ApiError("Request body is too large");
  }
  return bytes;
};

const readJsonBody = (bytes: Uint8Array): BuildAsset => {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  assertExactKeys(Object.keys(record));
  return {
    buildKey: parseBuildKey(record.buildKey),
    assetId: parseAssetId(record.assetId, false),
  };
};

const readFormBody = async (
  bytes: Uint8Array,
  contentType: string,
): Promise<BuildAsset> => {
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new ApiError("Request body is not valid form data");
  }
  const keys = [...new Set(form.keys())];
  assertExactKeys(keys);
  const buildKeyValues = form.getAll("buildKey");
  const assetIdValues = form.getAll("assetId");
  if (
    buildKeyValues.length !== 1 ||
    assetIdValues.length !== 1 ||
    typeof buildKeyValues[0] !== "string" ||
    typeof assetIdValues[0] !== "string"
  ) {
    throw new ApiError("buildKey and assetId must each be one form field");
  }
  return {
    buildKey: parseBuildKey(buildKeyValues[0]),
    assetId: parseAssetId(assetIdValues[0], true),
  };
};

const readBuildAsset = async (request: Request): Promise<BuildAsset> => {
  const url = new URL(request.url);
  if ([...url.searchParams].length > 0) {
    throw new ApiError("POST query parameters are not allowed");
  }
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== JSON_CONTENT_TYPE &&
    mediaType !== URL_ENCODED_CONTENT_TYPE &&
    mediaType !== MULTIPART_CONTENT_TYPE
  ) {
    throw new ApiError("Content-Type must be JSON or form data");
  }
  const bytes = await readBodyBytes(request);
  return mediaType === JSON_CONTENT_TYPE
    ? readJsonBody(bytes)
    : readFormBody(bytes, contentType);
};

export const getBuildAsset = async (
  request: Request,
  database: D1Database,
): Promise<Pick<BuildAsset, "assetId"> | null> => {
  if (request.body !== null) {
    throw new ApiError("GET request body is not allowed");
  }
  const searchParams = new URL(request.url).searchParams;
  const buildKeyValues = searchParams.getAll("buildKey");
  if (
    buildKeyValues.length !== 1 ||
    [...searchParams.keys()].some((key) => key !== "buildKey")
  ) {
    throw new ApiError("GET query must contain exactly one buildKey");
  }
  const buildKey = parseBuildKey(buildKeyValues[0]);
  const row = await database
    .prepare("SELECT asset_id FROM build_asset WHERE build_key = ? LIMIT 1")
    .bind(buildKey)
    .first<BuildAssetRow>();
  return row === null ? null : { assetId: row.asset_id };
};

export const getBuildAssetList = async (
  request: Request,
  database: D1Database,
): Promise<BuildAsset[]> => {
  if (request.body !== null) {
    throw new ApiError("GET request body is not allowed");
  }
  const searchParams = new URL(request.url).searchParams;
  if ([...searchParams].length > 0) {
    throw new ApiError("GET query parameters are not allowed");
  }
  const { results } = await database
    .prepare(
      "SELECT build_key, asset_id FROM build_asset ORDER BY build_key",
    )
    .all<BuildAssetListRow>();
  return results.map((row) => ({
    buildKey: row.build_key,
    assetId: row.asset_id,
  }));
};

export const createBuildAsset = async (
  request: Request,
  database: D1Database,
): Promise<BuildAsset> => {
  const buildAsset = await readBuildAsset(request);
  await database
    .prepare(
      `INSERT INTO build_asset (build_key, asset_id) VALUES (?, ?)
       ON CONFLICT(build_key) DO UPDATE SET asset_id = excluded.asset_id`,
    )
    .bind(buildAsset.buildKey, buildAsset.assetId)
    .run();
  return buildAsset;
};
