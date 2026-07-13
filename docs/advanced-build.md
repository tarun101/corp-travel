# Advanced build & deployment (remote server)

Running the remote server locally in more detail, deploying it, and setting
up per-person Google OAuth. See the [root README](../README.md) for a
quickstart.

## Run it locally

```bash
npm install
npm run install-browser
npm run build
cp policy.example.json policy.json
cp user_preferences.example.json user_preferences.json
MCP_BEARER_TOKEN=some-long-random-secret npm run start:remote
```

The server refuses to start without `MCP_BEARER_TOKEN` — there's no
unauthenticated mode. It listens on `PORT` (default `8080`) at `POST /mcp`,
with `GET /status` for platform health checks (not `/healthz` — that exact
path is intercepted by Google Cloud's edge infrastructure before it reaches
the container, observed directly while deploying this to Cloud Run).

## Deploying

Built as a standard Docker container ([Dockerfile](../Dockerfile)) — this
runs on any container host: **Fly.io, Render, Google Cloud Run, AWS App
Runner/Fargate**, or a small VPS. All of these have cheap-enough tiers for
low-traffic use.

```bash
docker build -t google-flights-recommender .
docker run -p 8080:8080 \
  -e MCP_BEARER_TOKEN=some-long-random-secret \
  google-flights-recommender
```

To use a custom policy/preferences without rebuilding the image, pass them as
raw JSON via env vars instead of files — every container platform makes env
vars easy, file mounts much less so:

```bash
docker run -p 8080:8080 \
  -e MCP_BEARER_TOKEN=some-long-random-secret \
  -e POLICY_JSON="$(cat policy.json)" \
  -e PREFERENCES_JSON="$(cat user_preferences.json)" \
  google-flights-recommender
```

Other env vars: `MAX_CONCURRENT_SEARCHES` (default `3`, caps simultaneous
Chromium instances), `SEARCH_TIMEOUT_MS` (default `45000`), `ALLOWED_HOSTS`
(comma-separated, for the SDK's DNS-rebinding protection if you bind to
`0.0.0.0` behind a known hostname).

**Note on Docker build verification:** the Dockerfile follows the standard
Playwright-in-Docker pattern (install the browser at build time so its
version always matches the `playwright` npm package). Build and run it
yourself before deploying to catch anything environment-specific.

**Cloudflare Workers caveat:** Cloudflare has MCP infrastructure, but it's
built around Workers' V8-isolate runtime, which cannot run a standard Node
`playwright` browser process. Cloudflare's own headless-browser product
(`@cloudflare/puppeteer` / Browser Rendering) uses a different, more limited
API and would need a real port of [src/googleFlights.ts](../src/googleFlights.ts),
not just a redeploy. Fly.io, Render, or Cloud Run are the fastest path with
the code as written.

## Adding it as a claude.ai / Claude for Work connector

Once deployed, add it in claude.ai's connector settings with the server's
public `https://.../mcp` URL. This step requires your claude.ai account —
claude.ai's custom-connector UI offers two auth choices, both supported by
this server:

- **Username/password** — any username, password = the `MCP_BEARER_TOKEN`
  value (sent as HTTP Basic Auth). Fastest to set up.
- **OAuth** — real per-person "Sign in with Google," restricted to an email
  domain allowlist. More setup (below), but each colleague gets their own
  login instead of sharing one secret token.

## Google OAuth (per-person sign-in)

Only activates when `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
and `PUBLIC_BASE_URL` are all set — otherwise the server falls back to
username/password only, so this is safe to leave unconfigured.

**What it does:** claude.ai redirects the user to this server's `/authorize`,
which redirects again to Google's real consent screen. After the user signs
in, Google redirects back to this server's callback, which checks
`email_verified` and the email's domain against `ALLOWED_EMAIL_DOMAINS`
(comma-separated, e.g. `routespring.com,gallop.ai`), then issues its own
opaque access token to claude.ai. Google is used purely to authenticate the
human — no Google API access is requested beyond basic sign-in (`openid
email profile`), and this server never sees the user's Google password.

**One-time setup, done in Google Cloud Console** (this requires your own
Google account — it's your credential to create, not something an assistant
should do on your behalf):

1. Go to Google Cloud Console → APIs & Services → OAuth consent screen
   (`https://console.cloud.google.com/apis/credentials/consent?project=<your-project-id>`).
   - User type: **External** (required if you need more than one Workspace
     domain allowed — Internal only works for a single org).
   - App name, support email: whatever fits.
   - Scopes: leave at the non-sensitive defaults (`openid`, `email`,
     `profile`) — nothing more is requested.
   - Publish to **Production** (these are non-sensitive scopes, so Google
     shouldn't require manual verification) — this avoids having to
     individually allowlist every colleague as a "test user."
2. Go to Credentials → Create Credentials → OAuth client ID
   (`https://console.cloud.google.com/apis/credentials?project=<your-project-id>`).
   - Application type: **Web application**.
   - Authorized redirect URIs: add exactly
     `https://<your-service-url>/oauth/google/callback`
     (must match `PUBLIC_BASE_URL` + `/oauth/google/callback` exactly, or
     Google will reject the callback).
3. Store the generated **Client ID** and **Client Secret** — the Client
   Secret is sensitive, treat it like a password. Prefer your platform's
   secrets manager over a plaintext env var if it has one (example below
   uses Google Secret Manager).

Then set on your deployed service, e.g. for Cloud Run:

```bash
gcloud secrets create google-oauth-client-secret --data-file=- <<< "<client-secret>"
gcloud secrets add-iam-policy-binding google-oauth-client-secret \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud run services update <your-service-name> --region <your-region> \
  --update-env-vars="^;^GOOGLE_OAUTH_CLIENT_ID=<client-id>;PUBLIC_BASE_URL=https://<your-service-url>;ALLOWED_EMAIL_DOMAINS=routespring.com,gallop.ai" \
  --set-secrets "GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:latest"
```

**Session length:** issued tokens last 1 week (`ACCESS_TOKEN_TTL_SECONDS` in
[src/googleOAuth.ts](../src/googleOAuth.ts)) with no refresh — after that,
claude.ai will prompt the user to sign in again. No state survives a
container restart (all in-memory), so a redeploy also forces re-login.
