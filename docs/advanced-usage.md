# Advanced usage

Policy and preferences schemas, the multi-colleague pattern, and known
limitations for both servers. See the [root README](../README.md) for a
quickstart, or [local-server/README.md](../local-server/README.md) for the
browser-driven booking server.

## Policy file schema

See [policy.example.json](../policy.example.json). Fields:

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
  list — see Known limitations below).
- `departureTimeWindow` — soft warning if departure falls outside `earliest`/
  `latest` (24h `HH:MM`).
- `requireApprovalAboveFare` — flags `requiresApproval: true` above this fare,
  independent of whether the flight is otherwise compliant.

Domestic vs. international is determined by a small built-in list of major US
airport codes (see `US_AIRPORTS` in [src/policy.ts](../src/policy.ts)) — treat
this as a reasonable default for US-based travel, not exhaustive worldwide
coverage. An unrecognized code is treated as international (the stricter
default) rather than silently skipping domestic rules.

## Preferences file schema (remote server only)

See [user_preferences.example.json](../user_preferences.example.json).
Preferences layer personal taste on top of policy's hard/soft rules, used to
score and rank the in-policy field:

- `optimizeFor` — `"cheapest"` / `"fastest"` / `"balanced"` — how much price
  vs. duration matters in the score when nothing else distinguishes flights.
- `preferNonstop` — rewards 0-stop flights, penalizes each connection.
- `preferredAlliance` — `"star_alliance"` / `"skyteam"` / `"oneworld"`;
  rewards flights fully or partially operated within it (see the carrier
  lists in [src/scoring.ts](../src/scoring.ts) — not exhaustive).
- `avoidRedEye` / `redEyeWindow` — penalizes departures inside the window
  (wraps past midnight, e.g. `22:00`–`05:00`).
- `preferEarlyMorning` / `earlyMorningWindow` — rewards departures inside
  the window.

Every flight in the response carries `policyCompliant`, `labels` (e.g. `✅ In
Policy`, `🏆 Best Match`, `✈️ Nonstop`, `🌙 Red-eye`), a numeric `score`, and
a `scoreBreakdown` showing exactly which factors added or subtracted what —
the ranking is meant to be auditable, not a black box. Out-of-policy flights
are still returned (heavily penalized, not excluded) so you can see what was
filtered and why.

Either config can be overridden per-call via the tool's `policyOverride` /
`preferencesOverride` params without touching the server's files — handy for
demoing "what if the policy were stricter," and it's also the mechanism for
the multi-colleague pattern below.

## Multiple colleagues, different policies

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
overrides on every call, deploy separate instances instead (e.g.
`<service>-sales`, `<service>-eng`), each with its own baked-in env var.
On a scale-to-zero host this stays cheap — each instance costs nothing when
idle.

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

Local-server-specific limitations are covered in
[local-server/README.md](../local-server/README.md#known-limitations).

## Safety boundary (remote server)

A stronger, structural boundary rather than a runtime check:
[src/remoteServer.ts](../src/remoteServer.ts) never imports or calls
`selectFlightForBooking` / `continueToBookingOption` / `autofillTravelerDetails`
at all. It has no code path that can reach an airline site, a traveler-detail
form, or a payment field — not because a check blocks it, but because the
capability isn't wired in.

The local server's safety boundary (which *does* reach airline sites, with a
runtime payment-detection check) is covered in
[local-server/README.md](../local-server/README.md#safety-boundary).
