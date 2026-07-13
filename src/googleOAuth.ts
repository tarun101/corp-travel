import { randomBytes } from "node:crypto";
import type { Request, Response, Express } from "express";
import {
  InvalidGrantError,
  InvalidClientError,
  InvalidTokenError,
  AccessDeniedError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 week — no refresh tokens issued, so this is the whole session length
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_GOOGLE_TTL_MS = 10 * 60 * 1000;

interface PendingGoogleAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: URL;
  clientState?: string;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: URL;
  email: string;
  createdAt: number;
}

interface IssuedToken extends AuthInfo {
  createdAt: number;
}

function randomId(): string {
  return randomBytes(32).toString("base64url");
}

function pruneExpired<T extends { createdAt: number }>(map: Map<string, T>, ttlMs: number): void {
  const now = Date.now();
  for (const [key, value] of map) {
    if (now - value.createdAt > ttlMs) map.delete(key);
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string; // must exactly match a redirect URI registered on the Google OAuth client
  allowedEmailDomains: string[];
}

/**
 * A from-scratch OAuthServerProvider (not the SDK's ProxyOAuthServerProvider —
 * that class proxies the *entire* OAuth flow 1:1 to an upstream server that
 * itself understands per-client redirect URIs and PKCE, which a consumer
 * Google OAuth client does not support). Instead, Google is used only to
 * authenticate the human during `authorize()`; this server issues its own
 * opaque access tokens afterward, scoped to an email-domain allowlist.
 *
 * Dynamic Client Registration (claude.ai registering itself with THIS
 * server) is fully local — it never touches Google, which doesn't support
 * DCR for consumer OAuth clients anyway.
 */
export class GoogleOAuthProvider implements OAuthServerProvider {
  private readonly config: GoogleOAuthConfig;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pendingGoogleAuth = new Map<string, PendingGoogleAuth>();
  private readonly issuedCodes = new Map<string, IssuedCode>();
  private readonly issuedTokens = new Map<string, IssuedToken>();

  constructor(config: GoogleOAuthConfig) {
    this.config = config;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    pruneExpired(this.pendingGoogleAuth, PENDING_GOOGLE_TTL_MS);
    const googleState = randomId();
    this.pendingGoogleAuth.set(googleState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource,
      clientState: params.state,
      createdAt: Date.now(),
    });

    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", this.config.clientId);
    googleUrl.searchParams.set("redirect_uri", this.config.callbackUrl);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email profile");
    googleUrl.searchParams.set("state", googleState);
    googleUrl.searchParams.set("prompt", "select_account");
    res.redirect(302, googleUrl.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.issuedCodes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }
    if (Date.now() - record.createdAt > AUTH_CODE_TTL_MS) {
      this.issuedCodes.delete(authorizationCode);
      throw new InvalidGrantError("Authorization code expired");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = this.issuedCodes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Unknown, expired, or already-used authorization code");
    }
    // RFC 6749 §4.1.3: the redirect_uri at token exchange must match the one
    // used when the code was issued, to prevent a code obtained via one
    // redirect_uri from being redeemed against another.
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the one used to obtain this code");
    }
    this.issuedCodes.delete(authorizationCode); // one-time use

    const token = randomId();
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    this.issuedTokens.set(token, {
      token,
      clientId: client.client_id,
      scopes: record.scopes,
      expiresAt,
      resource: record.resource,
      extra: { email: record.email },
      createdAt: Date.now(),
    });

    return {
      access_token: token,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: record.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("Refresh tokens are not supported — sign in again via Google when your session expires");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.issuedTokens.get(token);
    if (!record) throw new InvalidTokenError("Unknown access token");
    if (record.expiresAt !== undefined && record.expiresAt < Date.now() / 1000) {
      this.issuedTokens.delete(token);
      throw new InvalidTokenError("Access token expired");
    }
    return record;
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.issuedTokens.delete(request.token);
  }

  /** Handles Google's redirect back after the user authenticates. Mounted directly on the app, not via mcpAuthRouter. */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    pruneExpired(this.pendingGoogleAuth, PENDING_GOOGLE_TTL_MS);
    const { code, state, error: googleError } = req.query as Record<string, string | undefined>;

    if (!state || !this.pendingGoogleAuth.has(state)) {
      res.status(400).send("This sign-in link has expired or was already used. Please try connecting again.");
      return;
    }
    const pending = this.pendingGoogleAuth.get(state)!;
    this.pendingGoogleAuth.delete(state); // one-time use

    const failWithRedirect = (err: Error & { errorCode?: string }) => {
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set("error", err.errorCode ?? "server_error");
      redirectUrl.searchParams.set("error_description", err.message);
      if (pending.clientState) redirectUrl.searchParams.set("state", pending.clientState);
      res.redirect(302, redirectUrl.toString());
    };

    if (googleError) {
      failWithRedirect(new AccessDeniedError(`Google sign-in was not completed: ${googleError}`));
      return;
    }
    if (!code) {
      failWithRedirect(new ServerError("Google did not return an authorization code"));
      return;
    }

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.callbackUrl,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) {
        throw new ServerError(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
      }
      const googleTokens = (await tokenRes.json()) as { access_token: string };

      const userInfoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${googleTokens.access_token}` },
      });
      if (!userInfoRes.ok) {
        throw new ServerError(`Could not fetch Google user info: ${userInfoRes.status}`);
      }
      const userInfo = (await userInfoRes.json()) as { email?: string; email_verified?: boolean };

      const email = userInfo.email;
      const domain = email?.split("@")[1]?.toLowerCase();
      if (!email || !userInfo.email_verified || !domain || !this.config.allowedEmailDomains.includes(domain)) {
        failWithRedirect(
          new AccessDeniedError(
            `${email ?? "This Google account"} is not authorized to use this connector (allowed domains: ${this.config.allowedEmailDomains.join(", ")})`,
          ),
        );
        return;
      }

      const client = await this.clientsStore.getClient(pending.clientId);
      if (!client) {
        failWithRedirect(new InvalidClientError("The original client is no longer registered"));
        return;
      }

      const ourCode = randomId();
      this.issuedCodes.set(ourCode, {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scopes,
        resource: pending.resource,
        email,
        createdAt: Date.now(),
      });

      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set("code", ourCode);
      if (pending.clientState) redirectUrl.searchParams.set("state", pending.clientState);
      res.redirect(302, redirectUrl.toString());
    } catch (err) {
      failWithRedirect(err instanceof Error ? err : new ServerError(String(err)));
    }
  }
}

export function mountGoogleOAuthCallback(app: Express, path: string, provider: GoogleOAuthProvider): void {
  app.get(path, (req, res) => {
    provider.handleGoogleCallback(req, res).catch((err) => {
      console.error("Unhandled error in Google OAuth callback:", err);
      res.status(500).send("Internal error during Google sign-in.");
    });
  });
}
