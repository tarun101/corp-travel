# Google Flights Policy-Checked Booking (MCP servers)

Two MCP servers live in this repo, both built on the same Google Flights
scraping and policy-evaluation core ([src/googleFlights.ts](src/googleFlights.ts),
[src/policy.ts](src/policy.ts)):

- **Local (stdio)** — [src/index.ts](src/index.ts). Runs on your machine,
  opens a real visible browser window, and can drive a flight all the way to
  the airline's site with best-effort traveler-detail autofill, stopping
  before payment so you can finish in that same window. See "Local server"
  below.
- **Remote (HTTP)** — [src/remoteServer.ts](src/remoteServer.ts). Runs
  headless on a server, reachable from claude.ai or any MCP HTTP client.
  Since there's no local screen to hand control back to, it deliberately
  does **less**: it searches, labels every result in-policy/out-of-policy,
  scores and ranks by your travel preferences, and gives you a Google Flights
  link to finish the booking yourself — it never visits an airline/OTA site
  or touches traveler PII. Built as a technology demonstration of
  policy-aware recommendations. See "Remote server" below.

## Usage

Once either server is connected (Claude Code / Cowork for the local one,
claude.ai custom connectors for the remote one), there's no special syntax —
just ask in plain language and the model calls the right tool:

> "Find me a flight from DC to Delhi, Aug 1st to Aug 8th, economy"

The remote server's response looks like this (trimmed):

```json
{
  "route": "Washington, D.C. → Delhi",
  "policyUsed": "Routespring Standard Travel Policy",
  "googleFlightsUrl": "https://www.google.com/travel/flights/search?tfs=...",
  "totalFound": 11,
  "compliantCount": 5,
  "flights": [
    {
      "flight": { "airline": "United", "price": 1807, "stops": 1, "durationMinutes": 1085, ... },
      "policyCompliant": true,
      "requiresApproval": true,
      "score": 57.2,
      "labels": ["🏆 Best Match", "✅ In Policy", "⚠️ Needs Approval", "🔁 1 stop", "⭐ star alliance"],
      "scoreBreakdown": [
        { "label": "In policy", "delta": 40 },
        { "label": "Requires approval", "delta": -10 },
        { "label": "star_alliance match", "delta": 15 },
        { "label": "Duration 1085min (of 1085-1688 range)", "delta": 20 }
      ]
    }
  ]
}
```

Every flight carries a plain-English label set and a numeric `scoreBreakdown`
— you can see exactly why the top result ranked where it did, not just trust
a black-box order. Out-of-policy flights are still returned (heavily
penalized, not hidden), so you can see what got filtered and why. The
`googleFlightsUrl` reproduces the exact search on Google Flights for you to
actually complete the booking — neither server ever visits an airline site
on the remote path, and the local server always stops before payment.

Other things worth asking for:

- **"What policy is this using?"** → calls `get_active_config` (remote) to
  show the fare caps, cabin rules, and preferences currently in effect.
- **"Use my own policy for this"** → if you keep a personal `policy.json` /
  `user_preferences.json`, mention it and the assistant will read it and pass
  it as `policyOverride`/`preferencesOverride` for that call — see "Multiple
  colleagues, different policies" below.
- **"Book the United flight"** (local server only) → drives Google Flights
  through fare selection to the airline's site, best-effort fills traveler
  details, and stops the moment it detects a payment field — you finish
  checkout yourself in the browser window it opens.

## Local server

Opens a real visible browser window, and best-effort autofills traveler
details on the airline/OTA site — **always stopping before payment**.

It never enters card details, never clicks pay/purchase/submit buttons, and
never completes a booking. Completing checkout (including payment) is always
left to a human in the browser window this server opens.

### How it works

1. `search_flights` — searches Google Flights for a route and returns
   structured flight options (airline, times, stops, price).
2. `check_policy` / `find_compliant_flights` — evaluates flights against a
   policy JSON file (fare caps, cabin class, stops, airlines, advance
   purchase, refundability, departure time window, approval threshold).
3. `start_booking` — re-validates the chosen flight against policy, clicks it
   through Google Flights' outbound → return → "Booking options" flow, picks
   a fare tile, follows the handoff to the airline/OTA site, and best-effort
   fills traveler fields (name, DOB, email, phone, frequent flyer, etc.) using
   label-heuristic matching. **Stops the instant it detects a payment field
   or a pay/purchase button** and hands back a screenshot + URL for you to
   finish yourself.
4. `close_browser` — closes the Playwright session.

### Setup

```bash
npm install
npm run install-browser   # downloads a Chromium build for Playwright
npm run build
```

Copy `policy.example.json` to `policy.json` and adjust it for your
organization (see schema below). Copy `traveler.example.json` to
`traveler.json` (or just pass traveler details inline) as a template.

### Using it from Claude Code / an MCP client

Add to your MCP config:

```json
{
  "mcpServers": {
    "google-flights-policy-booking": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/this/repo"
    }
  }
}
```

The browser window it opens (`headless: false` by default, in
[src/browser.ts](src/browser.ts)) is intentional — you should be able to see
and take over the session at the point it stops.

## Remote server

A single tool, `search_and_recommend_flights`, plus a read-only
`get_active_config`. No airline-site visits, no traveler PII, no booking —
just a ranked, labeled recommendation and a link.

### Config: policy + preferences

The remote server layers a **preferences** file on top of the same policy
file the local server uses. Policy defines hard/soft rules (fare caps, cabin,
blocked airlines); preferences define personal taste used to rank the
in-policy field. See [user_preferences.example.json](user_preferences.example.json):

- `optimizeFor` — `"cheapest"` / `"fastest"` / `"balanced"` — how much price
  vs. duration matters in the score when nothing else distinguishes flights.
- `preferNonstop` — rewards 0-stop flights, penalizes each connection.
- `preferredAlliance` — `"star_alliance"` / `"skyteam"` / `"oneworld"`;
  rewards flights fully or partially operated within it (see the carrier
  lists in [src/scoring.ts](src/scoring.ts) — not exhaustive).
- `avoidRedEye` / `redEyeWindow` — penalizes departures inside the window
  (wraps past midnight, e.g. `22:00`–`05:00`).
- `preferEarlyMorning` / `earlyMorningWindow` — rewards departures inside
  the window.

Every flight in the response carries `policyCompliant`, `labels` (e.g. `✅ In
Policy`, `🏆 Best Match`, `✈️ Nonstop`, `🌙 Red-eye`), a numeric `score`, and
a `scoreBreakdown` showing exactly which factors added or subtracted what —
the ranking is meant to be auditable, not a black box. Out-of-policy flights
are still returned (heavily penalized, not excluded) so you can see what was
filtered and why. Either config can be overridden per-call via the tool's
`policyOverride` / `preferencesOverride` params without touching the server's
files — handy for demoing "what if the policy were stricter."

#### Multiple colleagues, different policies

The `POLICY_JSON`/`PREFERENCES_JSON` env vars set **one shared default for
the whole deployed service** — not a per-user setting. If several colleagues
each redeploy with their own policy as the env var, they overwrite each
other's default; last deploy wins, silently, for everyone hitting the
service. Don't use that as a per-person mechanism.

Instead, each colleague keeps their own `policy.json` / `user_preferences.json`
wherever they work locally, and passes it as `policyOverride` /
`preferencesOverride` on each call — no shared state, nothing to step on.
The tool description tells any calling assistant to do this automatically:
check for the user's local policy/preferences files, read them, and pass
their parsed contents as the override params, rather than relying on the
server's shared default. This works today with the deployed server as-is —
no server-side change needed per colleague.

If you want a persistent distinct *default* per team without repeating
overrides on every call, deploy separate Cloud Run services instead (e.g.
`corp-travel-mcp-sales`, `corp-travel-mcp-eng`), each with its own baked-in
env var. Still cheap — each scales to zero independently.

### Run it locally

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

### Deploying

Built as a standard Docker container ([Dockerfile](Dockerfile)) — this runs
on any container host: **Fly.io, Render, Google Cloud Run, AWS App Runner/
Fargate**, or a small VPS. All of these have cheap-enough tiers for
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
version always matches the `playwright` npm package), but I wasn't able to
build-test it in this session — Docker was installed but the daemon wasn't
running. Build it yourself before deploying to catch anything environment-
specific.

**Cloudflare Workers caveat:** you mentioned Cloudflare has MCP
infrastructure — true, but it's built around Workers' V8-isolate runtime,
which cannot run a standard Node `playwright` browser process. Cloudflare's
own headless-browser product (`@cloudflare/puppeteer` / Browser Rendering)
uses a different, more limited API and would need a real port of
[src/googleFlights.ts](src/googleFlights.ts), not just a redeploy. Fly.io,
Render, or Cloud Run are the fastest path with the code as written.

### Adding it as a claude.ai / Claude for Work connector

Once deployed, add it in claude.ai's connector settings with the server's
public `https://.../mcp` URL. I can't do this step for you — it requires
your claude.ai account. claude.ai's custom-connector UI offers two auth
choices, both supported by this server:

- **Username/password** — any username, password = the `MCP_BEARER_TOKEN`
  value (sent as HTTP Basic Auth). Fastest to set up.
- **OAuth** — real per-person "Sign in with Google," restricted to an email
  domain allowlist. More setup (below), but each colleague gets their own
  login instead of sharing one secret token.

### Google OAuth (per-person sign-in)

Only activates when `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
and `PUBLIC_BASE_URL` are all set — otherwise the server silently falls back
to username/password only, so this is safe to leave unconfigured.

**What it does:** claude.ai redirects the user to this server's `/authorize`,
which redirects again to Google's real consent screen. After the user signs
in, Google redirects back to this server's callback, which checks
`email_verified` and the email's domain against `ALLOWED_EMAIL_DOMAINS`
(default `routespring.com,gallop.ai`), then issues its own opaque access
token to claude.ai. Google is used purely to authenticate the human — no
Google API access is requested beyond basic sign-in (`openid email profile`),
and this server never sees the user's Google password.

**One-time setup you need to do yourself** (Google account credential
creation isn't something I should drive on your behalf):

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
   Secret is sensitive, treat it like a password (e.g. a secrets manager, not
   a plaintext env var, if your platform supports it — see the Cloud Run
   example using Secret Manager in the gcloud snippet below).

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
[src/googleOAuth.ts](src/googleOAuth.ts)) with no refresh — after that,
claude.ai will prompt the user to sign in again. No state survives a
container restart (all in-memory), so a redeploy also forces re-login.

## Policy file schema

See [policy.example.json](policy.example.json). Fields:

- `maxFare.domestic` / `maxFare.international` — fare caps in `currency`.
- `allowedCabin.domestic` / `allowedCabin.international` — allowed cabin
  classes per route type. `longHaulBusinessThresholdHours` optionally allows
  business/first on international flights past a duration threshold even if
  not otherwise listed.
- `maxStops` — max connections allowed.
- `minAdvancePurchaseDays` — how many days out a booking must be made.
- `preferredAirlines` — soft warning (not a block) if the airline isn't on
  this list.
- `blockedAirlines` — hard block.
- `refundableRequired` — block non-refundable fares (refundability is only
  known once you reach the fare-selection step, not from the initial search
  list — see Known limitations).
- `departureTimeWindow` — soft warning if departure falls outside `earliest`/
  `latest` (24h `HH:MM`).
- `requireApprovalAboveFare` — flags `requiresApproval: true` above this fare,
  independent of whether the flight is otherwise compliant.

Domestic vs. international is determined by a small built-in list of major US
airport codes (see `US_AIRPORTS` in [src/policy.ts](src/policy.ts)) — treat
this as a reasonable default for US-based travel, not exhaustive worldwide
coverage. An unrecognized code is treated as international (the stricter
default) rather than silently skipping domestic rules.

## Known limitations (read before relying on this)

Google Flights has no public API. This automates the actual web UI with
Playwright, which means:

- **Selectors can break** whenever Google changes their markup. The scraping
  targets Google's own accessibility labels (`aria-label`) rather than CSS
  classes where possible, since those are more stable, but this is inherently
  fragile compared to a real API.
- **The Search click occasionally doesn't register** on Google's end — this
  is retried up to 3 times with real waits between attempts; if it still
  fails, `search_flights` throws rather than silently returning an empty
  (and misleading) list of "zero flights."
- **Refundability (`isRefundable`) is `null`** at the search-list stage —
  Google only exposes it once you're on the per-airline fare-selection panel.
  A policy with `refundableRequired: true` will treat unknown as
  non-compliant (fails closed, not open).
- **Flight numbers aren't scraped** (empty array) — Google doesn't expose them
  in the result-row accessibility label; only after opening flight details.
- **The airline/OTA handoff is the least stable step.** Every airline's
  booking page is different, and Google's deep link occasionally 404s outside
  a fully-cookied real browser session (observed directly while building
  this). `autofillTravelerDetails` reports per-field what it could and
  couldn't fill (`filled` / `not_found` / `skipped_payment_adjacent`) rather
  than assuming success.
- **Round trips always take the top-ranked return flight.** There's currently
  no way to request a specific outbound+return pairing other than "cheapest"
  / "best" on each leg. Applies to the local server only (the remote server
  never selects a specific outbound/return pairing at all).

Remote-server-specific:

- **No session/state across calls.** Each `search_and_recommend_flights`
  call launches and tears down its own headless Chromium — simpler and more
  isolated than a shared long-lived browser, but means every call pays a
  ~1-2s browser-startup cost.
- **Shared-IP rate-limiting risk.** All calls to a given deployment hit
  Google Flights from the same server IP. Under real (non-demo) load this is
  more likely to trip Google's bot detection than the local version, where
  each user's traffic comes from their own residential/office IP.
- **`googleFlightsUrl` is a shared search link, not a per-flight deep link.**
  It reproduces the exact search on Google Flights; you still pick the
  specific flight there. Per-flight airline booking links aren't available
  without visiting the airline's booking-options panel, which this server
  deliberately never does.

## Safety boundary

**Local server** — not a tunable setting, hardcoded in
[src/browser.ts](src/browser.ts) (`detectPaymentStep`, `PAYMENT_FIELD_PATTERN`,
`PAYMENT_ACTION_PATTERN`) and enforced in [src/booking.ts](src/booking.ts) and
the `start_booking` tool in [src/index.ts](src/index.ts):

- Before attempting any autofill, the page is scanned for payment-related
  text/fields. If found, autofill is skipped entirely.
- Every field fill is checked against the payment-field pattern first, even
  if it also matches a traveler-field pattern (e.g. a mislabeled "name on
  card" field won't get your traveler's name typed into it).
- After autofill, the page is scanned again, and any pay/purchase/submit
  buttons found are listed (not clicked) so you know what's next.
- The tool never calls `.click()` on anything matching `PAYMENT_ACTION_PATTERN`.

**Remote server** — a stronger, structural boundary rather than a runtime
check: [src/remoteServer.ts](src/remoteServer.ts) never imports or calls
`selectFlightForBooking` / `continueToBookingOption` / `autofillTravelerDetails`
at all. It has no code path that can reach an airline site, a traveler-detail
form, or a payment field — not because a check blocks it, but because the
capability isn't wired in.
