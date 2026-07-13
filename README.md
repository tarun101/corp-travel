# Google Flights Policy Recommender (MCP)

A remote MCP server that searches Google Flights, labels every result
in-policy or out-of-policy against a travel policy file, and ranks them by
your travel preferences — nonstop, airline alliance, red-eye avoidance,
cheapest/fastest/balanced. It never visits an airline or OTA site and never
attempts to book anything: it hands you a ranked, labeled list and a Google
Flights link to complete the booking yourself.

Built as a technology demonstration of policy-aware flight recommendations.

There's also a local, browser-driven server in this repo that *can* drive a
booking up to (but never through) payment — see
[local-server/README.md](local-server/README.md).

## Connect it to claude.ai

You need a running instance first — either one a colleague/admin already
deployed (get the URL and credentials from them), or your own: see
[docs/advanced-build.md](docs/advanced-build.md) for deploying (Docker,
Fly.io/Render/Cloud Run).

Once you have a URL:

1. In claude.ai, go to **Settings → Connectors → Add custom connector**.
2. **URL**: `https://<your-deployment>/mcp`
3. **Auth** — claude.ai offers two options, both supported:
   - **Username/password**: any username, password = the deployment's
     `MCP_BEARER_TOKEN`. Fastest to set up, one shared secret for everyone.
   - **OAuth**: real per-person "Sign in with Google," restricted to an
     email domain allowlist — each colleague gets their own login instead
     of sharing a secret. Requires one-time setup in Google Cloud Console;
     see [docs/advanced-build.md](docs/advanced-build.md#google-oauth-per-person-sign-in).
4. Save. claude.ai should confirm the connection — try asking it to find a
   flight (see [docs/examples.md](docs/examples.md)).

## Change the default policy & config

Two files drive every recommendation: **policy** (hard/soft rules — fare
caps, cabin class, blocked airlines) and **preferences** (personal taste —
nonstop, alliance, cheapest vs. fastest). Full schema for both:
[docs/advanced-usage.md](docs/advanced-usage.md).

- **Change the deployment's default** — edit `policy.json` /
  `user_preferences.json` and redeploy, or set the `POLICY_JSON` /
  `PREFERENCES_JSON` env vars directly (no rebuild needed). This changes
  results for *everyone* using that deployment — see
  [docs/advanced-build.md](docs/advanced-build.md#deploying) for exact
  commands.
- **Use your own policy without changing the shared default** — keep a
  personal `policy.json` / `user_preferences.json` and just mention it
  ("use my policy for this"); the assistant reads it and passes it in for
  that call only. This is also how multiple colleagues share one deployment
  with different policies — see
  [docs/advanced-usage.md](docs/advanced-usage.md#multiple-colleagues-different-policies).

## More

- [docs/examples.md](docs/examples.md) — worked examples: a search, checking
  the active policy, bringing your own policy, booking.
- [local-server/README.md](local-server/README.md) — the browser-driven
  server that can autofill a booking up to payment.
- [docs/advanced-build.md](docs/advanced-build.md) — deploying, Google OAuth
  setup, running it locally.
- [docs/advanced-usage.md](docs/advanced-usage.md) — full policy/preferences
  schema, the multi-colleague pattern, known limitations, safety boundary.
