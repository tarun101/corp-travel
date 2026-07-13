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

## Install

```bash
npm install
npm run install-browser   # downloads a Chromium build for Playwright
npm run build
cp policy.example.json policy.json
cp user_preferences.example.json user_preferences.json
MCP_BEARER_TOKEN=some-long-random-secret npm run start:remote
```

The server refuses to start without `MCP_BEARER_TOKEN` — there's no
unauthenticated mode. It listens on `PORT` (default `8080`) at `POST /mcp`.

To connect it from claude.ai (or deploy it first — Docker, Cloud Run, Google
OAuth for per-person sign-in), see
[docs/advanced-build.md](docs/advanced-build.md).

## Usage

No special syntax — just ask in plain language and the model calls the right
tool.

**Example 1:**

> "Find me a flight from DC to Delhi, Aug 1st to Aug 8th, economy"

```json
{
  "route": "Washington, D.C. → Delhi",
  "policyUsed": "Routespring Standard Travel Policy",
  "googleFlightsUrl": "https://www.google.com/travel/flights/search?tfs=...",
  "totalFound": 11,
  "compliantCount": 5,
  "flights": [
    {
      "flight": { "airline": "United", "price": 1807, "stops": 1, "durationMinutes": 1085, "...": "..." },
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
actually complete the booking — this server never visits an airline site
itself.

**Example 2:**

> "What policy is this using?"

Calls `get_active_config` and returns the fare caps, cabin rules, and
preferences currently in effect — useful before trusting a result, or before
handing this to someone else to try.

**Bring your own policy:** if you keep a personal `policy.json` /
`user_preferences.json` (different fare caps, different airline
preferences), mention it and the assistant will read it and pass it as
`policyOverride`/`preferencesOverride` for that call — this is also how
multiple colleagues use the same deployed server with different policies
without stepping on each other. See
[docs/advanced-usage.md](docs/advanced-usage.md) for the full schema and
pattern.

## Safety boundary

This server has no code path that can reach an airline site, a
traveler-detail form, or a payment field — `selectFlightForBooking` /
`continueToBookingOption` / `autofillTravelerDetails` aren't imported here at
all. Not a runtime check to bypass; the capability simply isn't wired in.
Details in [docs/advanced-usage.md](docs/advanced-usage.md#safety-boundary-remote-server).

## More

- [local-server/README.md](local-server/README.md) — the browser-driven
  server that can autofill a booking up to payment.
- [docs/advanced-build.md](docs/advanced-build.md) — deploying (Docker,
  Fly.io/Render/Cloud Run), Google OAuth for per-person sign-in.
- [docs/advanced-usage.md](docs/advanced-usage.md) — full policy/preferences
  schema, the multi-colleague pattern, known limitations.
