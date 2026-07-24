# Local server (stdio)

Runs on your machine, opens a real visible browser window, and best-effort
autofills traveler details on the airline/OTA site — **always stopping
before payment**.

It never enters card details, never clicks pay/purchase/submit buttons, and
never completes a booking. Completing checkout (including payment) is always
left to a human in the browser window this server opens.

Source lives at [../src/index.ts](../src/index.ts) (entry point),
[../src/booking.ts](../src/booking.ts) (traveler-detail autofill),
[../src/browser.ts](../src/browser.ts) (payment-detection safety boundary),
plus the shared [../src/googleFlights.ts](../src/googleFlights.ts) and
[../src/policy.ts](../src/policy.ts) also used by the remote server. For the
headless HTTP server with policy + preference scoring and no booking
capability at all, see the [root README](../README.md).

## How it works

1. `search_flights` — searches Google Flights for a route and returns
   structured flight options (airline, times, stops, price).
2. `check_policy` / `find_compliant_flights` — evaluates flights against a
   policy JSON file (fare caps, cabin class, stops, airlines, advance
   purchase, refundability, departure time window, approval threshold). See
   [docs/advanced-usage.md](../docs/advanced-usage.md#policy-file-schema) for
   the full schema.
3. `start_booking` — re-validates the chosen flight against policy, clicks it
   through Google Flights' outbound → return → "Booking options" flow, picks
   a fare tile, follows the handoff to the airline/OTA site, and best-effort
   fills traveler fields (name, DOB, email, phone, frequent flyer, etc.) using
   label-heuristic matching. **Stops the instant it detects a payment field
   or a pay/purchase button** and hands back a screenshot + URL for you to
   finish yourself.
4. `close_browser` — closes the Playwright session.

## Setup

From the repo root:

```bash
npm install
npm run install-browser   # downloads a Chromium build for Playwright
npm run build
```

Copy `policy.example.json` to `policy.json` and adjust it for your
organization (see the schema link above). Copy `traveler.example.json` to
`traveler.json` (or just pass traveler details inline) as a template.

## Using it from Claude Code / an MCP client

Add to your MCP config:

```json
{
  "mcpServers": {
    "corp-travel-local": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/this/repo"
    }
  }
}
```

The browser window it opens (`headless: false` by default, in
[../src/browser.ts](../src/browser.ts)) is intentional — you should be able
to see and take over the session at the point it stops.

## Example

> "Find flights DC to LA next Friday to Sunday, then book the cheapest
> in-policy nonstop."

The assistant calls `find_compliant_flights`, picks the top nonstop result,
then `start_booking` — which drives the browser to the airline's fare
selection and traveler-detail form, fills what it can, and stops with a
screenshot + URL the moment a payment field appears. You take it from there
in that same browser window.

## Known limitations

- **The airline/OTA handoff is the least stable step.** Every airline's
  booking page is different, and Google's deep link occasionally 404s outside
  a fully-cookied real browser session (observed directly while building
  this). `autofillTravelerDetails` reports per-field what it could and
  couldn't fill (`filled` / `not_found` / `skipped_payment_adjacent`) rather
  than assuming success.
- **Round trips always take the top-ranked return flight.** There's currently
  no way to request a specific outbound+return pairing other than "cheapest"
  / "best" on each leg.

Shared Google Flights scraping limitations (selector fragility, refundability
being unknown at search time, no flight numbers) are covered in
[docs/advanced-usage.md](../docs/advanced-usage.md#known-limitations-read-before-relying-on-this).

## Safety boundary

Not a tunable setting — hardcoded in [../src/browser.ts](../src/browser.ts)
(`detectPaymentStep`, `PAYMENT_FIELD_PATTERN`, `PAYMENT_ACTION_PATTERN`) and
enforced in [../src/booking.ts](../src/booking.ts) and the `start_booking`
tool in [../src/index.ts](../src/index.ts):

- Before attempting any autofill, the page is scanned for payment-related
  text/fields. If found, autofill is skipped entirely.
- Every field fill is checked against the payment-field pattern first, even
  if it also matches a traveler-field pattern (e.g. a mislabeled "name on
  card" field won't get your traveler's name typed into it).
- After autofill, the page is scanned again, and any pay/purchase/submit
  buttons found are listed (not clicked) so you know what's next.
- The tool never calls `.click()` on anything matching `PAYMENT_ACTION_PATTERN`.
