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

The live deployment:

```
https://corp-travel-mcp-508362522869.us-central1.run.app/mcp
```

1. In claude.ai, go to **Settings → Connectors → Add custom connector**.
2. **URL**: paste the URL above.
3. **Auth**: choose **OAuth**. Leave the Client ID / Client Secret fields
   **blank** — this server supports dynamic client registration, so
   claude.ai registers itself automatically; nothing to fill in by hand.
4. Save. claude.ai will prompt you to connect — sign in with your
   **`@routespring.com`** (or `@gallop.ai`) Google account. Any other
   domain is rejected.
5. Try asking it to find a flight (see [docs/examples.md](docs/examples.md)).

Running your own separate deployment instead? See
[docs/advanced-build.md](docs/advanced-build.md) for deploying it (Docker,
Fly.io/Render/Cloud Run) and setting up your own Google OAuth client — or
use the simpler username/password (Basic Auth) option claude.ai also offers,
where the password is the deployment's `MCP_BEARER_TOKEN`.

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
