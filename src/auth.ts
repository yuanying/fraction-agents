import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** The audience of the tokens callers send to agents, kept apart from the apiserver's own (ADR 0003). */
export const A2A_AUDIENCE = "a2a";

export interface TokenReviewResult {
  authenticated: boolean;
  username?: string;
  audiences?: string[];
}

/** Asks whether a bearer token is genuine. The Kubernetes TokenReview in production, a fake in tests. */
export interface TokenReviewer {
  review(token: string, audiences: string[]): Promise<TokenReviewResult>;
}

export type AuthResult =
  | { ok: true; caller: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

/**
 * Checks an `Authorization` header: the token must pass a TokenReview for the `a2a` audience and belong to one of
 * the allowed ServiceAccounts. The ServiceAccount's full name becomes the caller.
 */
export async function authenticate(
  authorization: string | undefined,
  reviewer: TokenReviewer,
  allowedCallers: readonly string[],
): Promise<AuthResult> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!match) return { ok: false, status: 401, reason: "missing bearer token" };
  let result: TokenReviewResult;
  try {
    result = await reviewer.review(match[1]!, [A2A_AUDIENCE]);
  } catch (error) {
    console.error(`token review failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, status: 503, reason: "token review unavailable" };
  }
  if (!result.authenticated || !result.username || !result.audiences?.includes(A2A_AUDIENCE)) {
    return { ok: false, status: 401, reason: "invalid token" };
  }
  if (!allowedCallers.includes(result.username)) return { ok: false, status: 403, reason: "caller not allowed" };
  return { ok: true, caller: result.username };
}

export interface KubernetesTokenReviewerOptions {
  /** Base URL of the apiserver, e.g. `https://10.0.0.1:443`. */
  apiServer: string;
  /** This agent's own ServiceAccount token. Read on every review, since the kubelet rotates it. */
  tokenFile: string;
  /** CA bundle for the apiserver's certificate. */
  caFile?: string;
}

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Posts TokenReviews to the Kubernetes API. The agent's ServiceAccount needs `system:auth-delegator`. */
export class KubernetesTokenReviewer implements TokenReviewer {
  readonly #options: KubernetesTokenReviewerOptions;

  constructor(options: KubernetesTokenReviewerOptions) {
    this.#options = options;
  }

  /** Uses the Pod's ServiceAccount token, CA and the apiserver address Kubernetes puts in the environment. */
  static inCluster(): KubernetesTokenReviewer {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT;
    if (!host || !port) throw new Error("not running in a Kubernetes cluster: KUBERNETES_SERVICE_HOST is not set");
    return new KubernetesTokenReviewer({
      apiServer: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
      tokenFile: `${SERVICE_ACCOUNT_DIR}/token`,
      caFile: `${SERVICE_ACCOUNT_DIR}/ca.crt`,
    });
  }

  async review(token: string, audiences: string[]): Promise<TokenReviewResult> {
    const body = JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token, audiences },
    });
    const own = readFileSync(this.#options.tokenFile, "utf8").trim();
    const url = new URL("/apis/authentication.k8s.io/v1/tokenreviews", this.#options.apiServer);
    const { status, text } = await post(url, body, {
      authorization: `Bearer ${own}`,
      ...(this.#options.caFile ? { ca: readFileSync(this.#options.caFile) } : {}),
    });
    if (status < 200 || status >= 300) throw new Error(`TokenReview returned HTTP ${status}`);
    const review = JSON.parse(text) as {
      status?: { authenticated?: boolean; user?: { username?: string }; audiences?: string[] };
    };
    if (review.status?.authenticated !== true) return { authenticated: false };
    return {
      authenticated: true,
      ...(review.status.user?.username ? { username: review.status.user.username } : {}),
      ...(review.status.audiences ? { audiences: review.status.audiences } : {}),
    };
  }
}

function post(
  url: URL,
  body: string,
  options: { authorization: string; ca?: Buffer },
): Promise<{ status: number; text: string }> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          authorization: options.authorization,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
        },
        ...(options.ca ? { ca: options.ca } : {}),
        timeout: 10_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("TokenReview timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
