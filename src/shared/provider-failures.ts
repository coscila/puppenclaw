import type { AgentKind } from "./types.js";

export type ProviderFailure = {
  code: "PROVIDER_AUTHENTICATION_REQUIRED" | "PROVIDER_CONNECTION_FAILED" | "PROVIDER_AUTHENTICATION_BUSY" | "PROVIDER_PAUSED";
  message: string;
  retryable: boolean;
};

const CLAUDE_AUTH_MESSAGE =
  "Claude OAuth credentials have expired or are invalid. Contact the system administrator to sign in to Claude again.";
const CLAUDE_CONNECTION_MESSAGE =
  "Claude is temporarily unreachable because of a network or provider outage. Please retry.";
const CLAUDE_AUTH_BUSY_MESSAGE =
  "Claude credentials are temporarily locked while another process refreshes them. Please retry shortly.";
const CLAUDE_PAUSED_MESSAGE =
  "The Claude broker paused this turn after a provider error. This does not establish that your saved login has expired. Retry after the provider issue is resolved.";

function isBrokerPause(code: string, message: string): boolean {
  if (code === "PROVIDER_PAUSED") return true;
  // ACP wraps the broker's typed response in its generic internal-error event.
  // Read that exact envelope before interpreting an earlier HTTP status quoted
  // inside it. Arbitrary prose mentioning PROVIDER_PAUSED is not a contract.
  const match = /^(?:Internal error:\s*)?API Error:\s*409\s+(\{[\s\S]*\})$/u.exec(message);
  if (!match) return false;
  try {
    const body: unknown = JSON.parse(match[1]!);
    return body !== null && typeof body === "object" && !Array.isArray(body) &&
      (body as Record<string, unknown>).code === "PROVIDER_PAUSED";
  } catch { return false; }
}

export function classifyProviderFailure(params: {
  agent: AgentKind;
  code?: string;
  message: string;
  retryable?: boolean;
}): ProviderFailure | null {
  const code = params.code?.trim().toUpperCase() ?? "";
  const message = params.message.trim();
  if (isBrokerPause(code, message)) {
    return {
      code: "PROVIDER_PAUSED",
      message: params.agent === "claude" ? CLAUDE_PAUSED_MESSAGE : "The model broker paused this turn after a provider error. Retry after the provider issue is resolved.",
      retryable: true
    };
  }
  if (params.agent === "claude") {
    const structuredAuth =
      /^(?:PROVIDER_AUTHENTICATION_REQUIRED|INVALID_GRANT|401|403|AUTH(?:ENTICATION)?(?:_ERROR|_FAILED|_REQUIRED)?|OAUTH(?:_ERROR|_EXPIRED|_INVALID)?|UNAUTHENTICATED|UNAUTHORIZED|TOKEN_(?:EXPIRED|INVALID|REVOKED)|CREDENTIALS?_(?:EXPIRED|INVALID|REVOKED))$/u.test(
        code
      );
    const signalledAuth =
      /(?:oauth|access token|refresh token|credentials?).{0,80}(?:expired|invalid|revoked|missing|login|log in|authenticate|authentication required)|(?:expired|invalid|revoked|missing).{0,80}(?:oauth|access token|refresh token|credentials?)|(?:invalid_grant|not logged in|not authenticated|authentication required|please (?:run|use).{0,40}(?:login|log in)|unauthorized|\b(?:http\s*)?(?:401|403)\b)/iu.test(
        message
      );
    // The native CLI can wrap a refresh-lock timeout in a generic OAuth
    // error. Recognize only its specific contention diagnostic; a revoked
    // token or rejected grant remains terminal even alongside that prose.
    const refreshBusy = code === "PROVIDER_AUTHENTICATION_BUSY" || (
      /Failed to refresh OAuth token:/iu.test(message) &&
      /(?:Claude Code process is refreshing it or exited mid-refresh|timed out waiting for (?:the )?(?:OAuth (?:token )?)?refresh lock)/iu.test(message)
    );
    const definitiveAuthCode = structuredAuth && !/^(?:AUTH(?:ENTICATION)?(?:_ERROR|_FAILED)?|OAUTH(?:_ERROR)?)$/u.test(code);
    if (signalledAuth || definitiveAuthCode || (structuredAuth && !refreshBusy)) {
      return {
        code: "PROVIDER_AUTHENTICATION_REQUIRED",
        message: CLAUDE_AUTH_MESSAGE,
        retryable: false
      };
    }
    if (refreshBusy) {
      return {
        code: "PROVIDER_AUTHENTICATION_BUSY",
        message: CLAUDE_AUTH_BUSY_MESSAGE,
        retryable: true
      };
    }
  }

  const structuredConnection =
    /^(?:CONNECTION_(?:ERROR|FAILED|REFUSED|RESET|TIMEOUT)|NETWORK_(?:ERROR|UNREACHABLE)|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UPSTREAM_UNAVAILABLE)$/u.test(
      code
    );
  const signalledConnection =
    /(?:econnrefused|econnreset|enetunreach|enotfound|etimedout|eai_again|socket hang up|connection (?:refused|reset|timed out)|network (?:error|unreachable)|fetch failed|upstream (?:unavailable|connection)|tls handshake)/iu.test(
      message
    );
  if (structuredConnection || signalledConnection) {
    return {
      code: "PROVIDER_CONNECTION_FAILED",
      message: params.agent === "claude" ? CLAUDE_CONNECTION_MESSAGE : "The model provider is temporarily unreachable. Please retry.",
      retryable: true
    };
  }
  return null;
}
