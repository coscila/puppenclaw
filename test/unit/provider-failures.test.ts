import { describe, expect, it } from "vitest";

import { classifyProviderFailure } from "../../src/shared/provider-failures.js";

const refreshBusyMessage = "Internal error: Failed to refresh OAuth token: Another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again.";

describe("provider failure classification", () => {
  it.each([
    { message: refreshBusyMessage },
    { message: refreshBusyMessage.replace("Another", "[redacted]") },
    { code: "AUTHENTICATION_ERROR", message: refreshBusyMessage },
    { code: "OAUTH_ERROR", message: refreshBusyMessage },
    { code: "PROVIDER_AUTHENTICATION_BUSY", message: "Safe adapter refresh contention signal" },
    { message: "Failed to refresh OAuth token: Timed out waiting for the OAuth refresh lock." }
  ])("recognizes transient Claude refresh contention without requiring login: %j", (error) => {
    expect(classifyProviderFailure({ agent: "claude", ...error })).toEqual({
      code: "PROVIDER_AUTHENTICATION_BUSY",
      message: "Claude credentials are temporarily locked while another process refreshes them. Please retry shortly.",
      retryable: true
    });
  });

  it.each([
    { code: "401", message: refreshBusyMessage },
    { code: "403", message: refreshBusyMessage },
    { code: "INVALID_GRANT", message: refreshBusyMessage },
    { code: "TOKEN_REVOKED", message: refreshBusyMessage },
    { code: "PROVIDER_AUTHENTICATION_REQUIRED", message: refreshBusyMessage },
    { code: "PROVIDER_AUTHENTICATION_BUSY", message: "invalid_grant" },
    { code: "PROVIDER_AUTHENTICATION_BUSY", message: "Refresh token revoked" },
    { message: `${refreshBusyMessage} HTTP 401` },
    { message: "Failed to refresh OAuth token: invalid_grant" }
  ])("does not retry definitive authentication rejection: %j", (error) => {
    expect(classifyProviderFailure({ agent: "claude", ...error }))
      .toMatchObject({ code: "PROVIDER_AUTHENTICATION_REQUIRED", retryable: false });
  });

  it("does not infer refresh contention from generic failures or other providers", () => {
    expect(classifyProviderFailure({ agent: "claude", message: "Failed to refresh OAuth token: unspecified failure" })).toBeNull();
    expect(classifyProviderFailure({ agent: "claude", message: "Another process is refreshing a data cache" })).toBeNull();
    expect(classifyProviderFailure({ agent: "codex", message: refreshBusyMessage })).toBeNull();
  });

  it("recognizes narrow Claude authentication and connection failures", () => {
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "AUTHENTICATION_ERROR",
        message: "OAuth access token expired"
      })
    ).toMatchObject({ code: "PROVIDER_AUTHENTICATION_REQUIRED", retryable: false });
    expect(
      classifyProviderFailure({
        agent: "claude",
        message: "request failed with HTTP 401"
      })
    ).toMatchObject({ code: "PROVIDER_AUTHENTICATION_REQUIRED", retryable: false });
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "ECONNRESET",
        message: "socket closed"
      })
    ).toMatchObject({ code: "PROVIDER_CONNECTION_FAILED", retryable: true });
  });

  it("does not turn permission, rate-limit, or non-Claude auth failures into Claude OAuth expiry", () => {
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "PERMISSION_DENIED",
        message: "permission denied for this tool"
      })
    ).toBeNull();
    expect(
      classifyProviderFailure({
        agent: "claude",
        code: "RATE_LIMITED",
        message: "rate limit exceeded",
        retryable: true
      })
    ).toBeNull();
    expect(
      classifyProviderFailure({
        agent: "codex",
        code: "401",
        message: "HTTP 401"
      })
    ).toBeNull();
  });
});
