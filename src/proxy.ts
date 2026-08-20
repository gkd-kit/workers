import { ApiError } from "./errors";

const MAX_REDIRECTS = 5;
const MAX_KNOWN_RESPONSE_SIZE = 32 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "accept-language",
  "range",
  "if-none-match",
  "if-modified-since",
] as const;
const RESPONSE_HEADER_ALLOWLIST = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary",
] as const;

const isIpv4Hostname = (hostname: string): boolean => {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^[0-9]+$/.test(part) && Number(part) <= 255)
  );
};

const validateTarget = (target: URL, workerHostname: string): URL => {
  if (target.protocol !== "https:") {
    throw new ApiError("Only HTTPS URLs are allowed");
  }
  if (target.username || target.password) {
    throw new ApiError("URLs containing credentials are not allowed");
  }
  if (target.port && target.port !== "443") {
    throw new ApiError("Only the default HTTPS port is allowed");
  }
  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname.length === 0 ||
    hostname === workerHostname.toLowerCase().replace(/\.$/, "") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".onion") ||
    hostname.includes(":") ||
    isIpv4Hostname(hostname) ||
    !hostname.includes(".")
  ) {
    throw new ApiError("The target hostname is not allowed");
  }
  target.hostname = hostname;
  target.hash = "";
  return target;
};

const createUpstreamHeaders = (request: Request): Headers => {
  const headers = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
};

const fetchWithValidatedRedirects = async (
  initialTarget: URL,
  workerHostname: string,
  headers: Headers,
): Promise<Response> => {
  let target = initialTarget;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let response: Response;
    try {
      response = await fetch(target, {
        method: "GET",
        headers,
        redirect: "manual",
      });
    } catch {
      throw new ApiError("Unable to fetch the upstream URL");
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === MAX_REDIRECTS) {
      throw new ApiError("The upstream URL redirected too many times");
    }
    target = validateTarget(new URL(location, target), workerHostname);
  }
  throw new ApiError("The upstream URL redirected too many times");
};

const createProxyResponse = (upstream: Response): Response => {
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_KNOWN_RESPONSE_SIZE
  ) {
    throw new ApiError("The upstream response exceeds the size limit");
  }
  const headers = new Headers();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const body =
    upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
};

export const handleProxy = async (
  request: Request,
  env: Pick<Env, "RATE_LIMITER">,
): Promise<Response> => {
  const requestUrl = new URL(request.url);
  const targetValues = requestUrl.searchParams.getAll("url");
  if (targetValues.length !== 1 || !targetValues[0]) {
    throw new ApiError("Exactly one url query parameter is required");
  }
  let target: URL;
  try {
    target = validateTarget(new URL(targetValues[0]), requestUrl.hostname);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("url must be an absolute URL");
  }

  const clientKey = request.headers.get("cf-connecting-ip") ?? "local";
  const limit = await env.RATE_LIMITER.limit({
    key: `${clientKey}:${target.hostname}`,
  });
  if (!limit.success) {
    throw new ApiError("Too many proxy requests", { "Retry-After": "60" });
  }

  const upstream = await fetchWithValidatedRedirects(
    target,
    requestUrl.hostname,
    createUpstreamHeaders(request),
  );
  return createProxyResponse(upstream);
};
