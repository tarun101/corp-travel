# Usage examples

No special syntax — once connected (see the [root README](../README.md)),
just ask in plain language and the model calls the right tool.

## Example 1: a search

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

## Example 2: comparing every weekend in a month

> "Search for the same flights for every weekend to weekend in next month
> and find me the cheapest option"

There's no built-in "scan a date range" tool — the assistant handles this by
enumerating each weekend-to-weekend pairing in the target month itself (e.g.
every Friday→Sunday or Saturday→Saturday), calling
`search_and_recommend_flights` once per pairing with the same origin,
destination, and cabin, then comparing the cheapest result across all of
them. You get back a single overall answer (which weekend, which flight,
what it costs) rather than a pile of raw per-call output — worth knowing
this costs one Google Flights search per weekend under the hood, so a
four-weekend month means four calls, each with its own ~1-2s browser-startup
cost (see [advanced-usage.md](advanced-usage.md#known-limitations-read-before-relying-on-this)).

## Example 3: checking what's active

> "What policy is this using?"

Calls `get_active_config` and returns the fare caps, cabin rules, and
preferences currently in effect — useful before trusting a result, or before
handing this to someone else to try.

## Example 4: using your own policy for one call

> "Use my policy.json for this search instead"

If you keep a personal `policy.json` / `user_preferences.json` (different
fare caps, different airline preferences), mention it and the assistant will
read it and pass it as `policyOverride`/`preferencesOverride` for that call
— the deployed server's default is untouched. This is also how multiple
colleagues share one deployed server without stepping on each other's
config; see [advanced-usage.md](advanced-usage.md) for the full schema and
pattern.

## Example 5: booking (local server only)

> "Book the United flight"

The [local server](../local-server/README.md) drives Google Flights through
fare selection to the airline's site, best-effort fills traveler details,
and stops the moment it detects a payment field — you finish checkout
yourself in the browser window it opens.
