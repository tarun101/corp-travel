import type { Page } from "playwright";
import { createHash } from "node:crypto";
import type { CabinClass, FlightOption, SearchParams } from "./types.js";

const CABIN_LABEL: Record<CabinClass, string> = {
  economy: "Economy (include Basic)",
  premium_economy: "Premium economy",
  business: "Business",
  first: "First",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatMonthDay(dateStr: string): { month: string; day: number; year: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { month: MONTHS[m - 1], day: d, year: y };
}

async function fillAirport(page: Page, fieldLabelPattern: RegExp, query: string): Promise<void> {
  const input = page.getByRole("combobox", { name: fieldLabelPattern }).first();
  await input.click();
  // Google's autocomplete is a React-controlled input that only reacts to
  // real key events, not a programmatic value set — so clear any existing
  // value and type it out character by character rather than using fill().
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await input.pressSequentially(query, { delay: 40 });
  // Google Flights renders a listbox of matching airports/cities; prefer an
  // exact "(XXX)" airport match over a city-level entry so we land on a
  // concrete airport rather than "all airports near X".
  const listbox = page.getByRole("listbox").last();
  await listbox.getByRole("option").first().waitFor({ state: "visible", timeout: 10_000 });
  // The top-level city match renders first; airport-level sub-options stream
  // in slightly after. Without this buffer we'd race the DOM and usually
  // fall back to the ambiguous city entry instead of a specific airport.
  await page.waitForTimeout(400);
  const airportOption = listbox.getByRole("option", { name: /\([A-Z]{3}\)/ }).first();
  if (await airportOption.count()) {
    await airportOption.click();
  } else {
    await listbox.getByRole("option").first().click();
  }
}

async function pickDate(page: Page, dateStr: string): Promise<void> {
  const { month, day, year } = formatMonthDay(dateStr);
  const target = page.getByRole("button", { name: new RegExp(`, ${month} ${day}, ${year}`) }).first();
  // The calendar may need paging forward if the requested month isn't visible yet.
  for (let i = 0; i < 12 && !(await target.count()); i++) {
    const next = page.getByRole("button", { name: "Next" }).last();
    await next.click();
    await page.waitForTimeout(200);
  }
  await target.click();
}

export async function searchGoogleFlights(page: Page, params: SearchParams): Promise<FlightOption[]> {
  // Force the US edition + USD regardless of the server's IP geolocation. Without gl=us,
  // an India-based IP gets the India edition (button labelled "Explore" not "Search", so
  // the selectors below never match) and prices come back in INR, silently breaking the
  // USD policy fare-cap comparison.
  await page.goto("https://www.google.com/travel/flights?hl=en&gl=us&curr=USD", { waitUntil: "domcontentloaded" });

  // Trip type: Round trip is the default; switch to One way when no return date given.
  if (!params.returnDate) {
    const tripTypeCombo = page.getByRole("combobox").filter({ hasText: "Round trip" }).first();
    await tripTypeCombo.click();
    await page.getByRole("option", { name: "One way" }).click();
  }

  // Passengers
  if (params.adults > 1) {
    await page.getByRole("button", { name: /passenger/i }).click();
    const addAdult = page.getByRole("button", { name: "Add adult" });
    for (let i = 1; i < params.adults; i++) {
      await addAdult.click();
    }
    await page.getByRole("button", { name: "Done" }).first().click();
  }

  // Cabin class
  if (params.cabin !== "economy") {
    const cabinCombo = page.getByRole("combobox", { name: /seating class/i }).first();
    await cabinCombo.click();
    await page.getByRole("option", { name: CABIN_LABEL[params.cabin] }).click();
  }

  await fillAirport(page, /^Where from\?/, params.origin);
  await fillAirport(page, /^Where to\?/, params.destination);

  await page.getByPlaceholder("Departure").first().click();
  await pickDate(page, params.departDate);
  if (params.returnDate) {
    await pickDate(page, params.returnDate);
  }
  await page.getByRole("button", { name: /^Done\./ }).first().click();

  // Clicking Search is the flakiest step in this whole flow: Google's SPA
  // occasionally swallows the click (or is mid-render and misses it) without
  // any visible error, leaving the page on the search form indefinitely. We
  // retry a few times with real waits between attempts before giving up, and
  // raise loudly rather than returning an empty list — an empty list reads as
  // "no flights on this route," which is a very different, misleading claim.
  const searchButton = page.getByRole("button", { name: "Search" }).first();
  let resultsLoaded = false;
  for (let attempt = 0; attempt < 3 && !resultsLoaded; attempt++) {
    await searchButton.click();
    resultsLoaded = await page
      .waitForSelector("li.pIav2d", { timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!resultsLoaded) {
    throw new Error(
      "Google Flights did not render results after clicking Search (tried 3 times). This is usually transient " +
        "— Google's client-side app occasionally stalls or the request gets rate-limited under repeated automated " +
        "use. Wait a moment and retry search_flights.",
    );
  }

  await page.waitForTimeout(1000);
  return scrapeResults(page, params);
}

interface ParsedAriaLabel {
  price: number | null;
  stops: number | null;
  airline: string | null;
  departAirport: string | null;
  departTime: string | null;
  arriveAirport: string | null;
  arriveTime: string | null;
  durationMinutes: number | null;
}

function parseResultAriaLabel(label: string): ParsedAriaLabel {
  const priceMatch = label.match(/([\d,]+)\s*US dollars/);
  const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;

  const stopsMatch = label.match(/(Nonstop|1 stop|2 stops|3 stops|4 stops) flight with ([^.]+)\./);
  const stops = stopsMatch
    ? stopsMatch[1] === "Nonstop"
      ? 0
      : Number(stopsMatch[1].split(" ")[0])
    : null;
  const airline = stopsMatch ? stopsMatch[2].trim() : null;

  const departMatch = label.match(/Leaves ([^.]+?) at (\d{1,2}:\d{2}\s?[AP]M) on ([A-Za-z]+, [A-Za-z]+ \d{1,2})/);
  const arriveMatch = label.match(/arrives at ([^.]+?) at (\d{1,2}:\d{2}\s?[AP]M) on ([A-Za-z]+, [A-Za-z]+ \d{1,2})/);

  const durationMatch = label.match(/Total duration (\d+)\s*hr(?:\s*(\d+)\s*min)?/);
  const durationMinutes = durationMatch
    ? Number(durationMatch[1]) * 60 + (durationMatch[2] ? Number(durationMatch[2]) : 0)
    : null;

  return {
    price,
    stops,
    airline,
    departAirport: departMatch ? departMatch[1].trim() : null,
    departTime: departMatch ? departMatch[2].trim() : null,
    arriveAirport: arriveMatch ? arriveMatch[1].trim() : null,
    arriveTime: arriveMatch ? arriveMatch[2].trim() : null,
    durationMinutes,
  };
}

function makeId(parts: (string | number | null)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

async function scrapeResults(page: Page, params: SearchParams): Promise<FlightOption[]> {
  const rows = page.locator("li.pIav2d div[role='link']");
  const count = await rows.count();
  const results: FlightOption[] = [];

  // Google Flights often lists the same physical flight twice (once under
  // "Top departing flights", again under a later "Other flights" section) —
  // dedupe on the raw aria-label, which is identical for a true duplicate.
  const seenLabels = new Set<string>();

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const label = (await row.getAttribute("aria-label")) ?? "";
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);

    const parsed = parseResultAriaLabel(label);
    if (parsed.price === null) continue;

    const flight: FlightOption = {
      id: makeId([label]),
      airline: parsed.airline ?? "Unknown",
      flightNumbers: [],
      departTime: parsed.departTime ?? "",
      arriveTime: parsed.arriveTime ?? "",
      durationMinutes: parsed.durationMinutes ?? 0,
      stops: parsed.stops ?? 0,
      price: parsed.price,
      currency: "USD",
      cabin: params.cabin,
      isRefundable: null,
      bookingUrl: null,
      origin: params.origin,
      destination: params.destination,
      departDate: params.departDate,
      returnDate: params.returnDate,
      raw: label,
    };
    results.push(flight);
  }

  return results;
}

export interface BookingOption {
  provider: string; // e.g. "United", "Expedia"
  fareName: string; // e.g. "Basic Economy"
  price: number;
  buttonLabel: string; // full aria-label, used to re-locate the button
}

/**
 * Re-runs the same search and clicks into the row matching `flightId`. For a
 * round trip this clicks the outbound row, then the top-ranked return row
 * (Google Flights requires both legs to be picked before it will show booking
 * options — there is currently no way to request a specific return flight
 * pairing from this module). Leaves the page on the "Booking options" panel
 * and returns the list of fare options found there.
 */
export async function selectFlightForBooking(
  page: Page,
  params: SearchParams,
  flightId: string,
): Promise<BookingOption[]> {
  const flights = await searchGoogleFlights(page, params);
  const index = flights.findIndex((f) => f.id === flightId);
  if (index === -1) {
    throw new Error(
      `Flight ${flightId} was not found in a fresh search — prices/availability may have changed. Re-run search_flights and pick again.`,
    );
  }

  // force: true — a nested child (e.g. the duration label) or a transient
  // Google-nav overlay routinely sits at the click-point's geometric center
  // and fails Playwright's strict interception check, even though it shares
  // the same delegated jsaction handler as the row itself and a real click
  // there would work fine.
  const rows = page.locator("li.pIav2d div[role='link']");
  await rows.nth(index).click({ force: true });

  if (params.returnDate) {
    // Google now shows "Top returning flights" — pick the first (top-ranked) one.
    await page.waitForSelector("li.pIav2d div[role='link']", { timeout: 20_000 });
    await page.locator("li.pIav2d div[role='link']").first().click({ force: true });
  }

  await page.waitForSelector('button[aria-label^="Continue to book with"]', { timeout: 20_000 }).catch(() => {});
  return scrapeBookingOptions(page);
}

async function scrapeBookingOptions(page: Page): Promise<BookingOption[]> {
  const buttons = page.locator('button[aria-label^="Continue to book with"]');
  const count = await buttons.count();
  const options: BookingOption[] = [];
  for (let i = 0; i < count; i++) {
    const label = (await buttons.nth(i).getAttribute("aria-label")) ?? "";
    const match = label.match(/Continue to book with ([^,]+), (.+) for ([\d,]+) US dollars/);
    if (!match) continue;
    options.push({
      provider: match[1].trim(),
      fareName: match[2].trim(),
      price: Number(match[3].replace(/,/g, "")),
      buttonLabel: label,
    });
  }
  return options;
}

/**
 * Clicks the fare button matching `buttonLabel` (from BookingOption) and
 * follows the flow to wherever Google Flights sends the traveler next — an
 * airline or OTA site, sometimes in a new tab, sometimes via same-tab
 * navigation. This handoff is the least stable part of the pipeline: airline
 * sites vary, and Google's deep link occasionally 404s outside a fully
 * cookied browser session. Callers must treat the returned page defensively.
 */
export async function continueToBookingOption(page: Page, buttonLabel: string): Promise<Page> {
  const button = page.locator(`button[aria-label="${buttonLabel}"]`);
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null),
    button.click(),
  ]);

  const target = popup ?? page;
  await target.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
  return target;
}

// --- Google Flights deep-link (tfs) builder --------------------------------
// The `tfs` query param is a base64url-encoded protobuf describing the search.
// We construct it from the search params so the returned link is a clean,
// self-contained deep link that restores the FULL search on a cold page load.
//
// Do NOT reuse the live scraping page's URL for this. Mid-session, Google
// Flights carries ephemeral in-app state inside tfs (observed:
// field 16 { field 1 = 0xFFFFFFFFFFFFFFFF } plus other session flags) that a
// fresh, cookie-less load can't parse — so the link restores only the first
// leg's origin and silently drops the destination and both dates.

const SEAT_CODE: Record<CabinClass, number> = {
  economy: 1,
  premium_economy: 2,
  business: 3,
  first: 4,
};

function pbVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

function pbVarintField(field: number, value: number): Buffer {
  return Buffer.concat([pbVarint((field << 3) | 0), pbVarint(value)]);
}

function pbLenDelim(field: number, body: Buffer): Buffer {
  return Buffer.concat([pbVarint((field << 3) | 2), pbVarint(body.length), body]);
}

function pbString(field: number, value: string): Buffer {
  return pbLenDelim(field, Buffer.from(value, "utf-8"));
}

// A leg's endpoint: { field 1 = 1 (airport, not a broader city/region), field 2 = IATA code }
function tfsEndpoint(code: string): Buffer {
  return Buffer.concat([pbVarintField(1, 1), pbString(2, code)]);
}

// One flight leg: { field 2 = date, field 13 = from, field 14 = to }
function tfsLeg(date: string, from: string, to: string): Buffer {
  return Buffer.concat([pbString(2, date), pbLenDelim(13, tfsEndpoint(from)), pbLenDelim(14, tfsEndpoint(to))]);
}

/**
 * Builds a shareable Google Flights deep link for the given search. Round trip
 * emits two legs (outbound + reversed return); one-way emits a single leg and
 * flags the trip type accordingly. Verified to restore origin, destination,
 * both dates, passenger count, cabin and trip type on a cold load.
 */
export function buildGoogleFlightsUrl(params: SearchParams): string {
  const legs: Buffer[] = [pbLenDelim(3, tfsLeg(params.departDate, params.origin, params.destination))];
  if (params.returnDate) {
    legs.push(pbLenDelim(3, tfsLeg(params.returnDate, params.destination, params.origin)));
  }

  // field 8 is a repeated passenger enum (1 = adult); emit one per adult.
  const passengers: Buffer[] = [];
  for (let i = 0; i < Math.max(1, params.adults); i++) {
    passengers.push(pbVarintField(8, 1));
  }

  const tfs = Buffer.concat([
    pbVarintField(2, 2), // top-level constant, matches Google's own encoding
    ...legs, // field 3 (repeated): flight legs
    ...passengers, // field 8 (repeated): one per adult
    pbVarintField(9, SEAT_CODE[params.cabin]), // seat/cabin class
    pbVarintField(19, params.returnDate ? 1 : 2), // trip type: 1 = round trip, 2 = one way
  ]);

  // base64url chars (A-Za-z0-9-_) are all URL-safe, so no extra encoding needed.
  // hl/gl/curr force the US English + USD edition (see searchGoogleFlights).
  return `https://www.google.com/travel/flights/search?tfs=${tfs.toString("base64url")}&hl=en&gl=us&curr=USD`;
}
