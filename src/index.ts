#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { browserSession, detectPaymentStep } from "./browser.js";
import { continueToBookingOption, searchGoogleFlights, selectFlightForBooking } from "./googleFlights.js";
import { evaluateFlightAgainstPolicy, loadPolicy } from "./policy.js";
import { autofillTravelerDetails, findNextActionButtons } from "./booking.js";
import type { FlightOption, TravelerDetails } from "./types.js";

const server = new McpServer({
  name: "google-flights-policy-booking",
  version: "0.1.0",
});

// In-memory cache of the last search's results, keyed by flight id, so
// check_policy / find_compliant_flights / start_booking can refer back to
// them without re-scraping or requiring the caller to pass whole objects.
const lastSearchResults = new Map<string, FlightOption>();

const searchParamsShape = {
  origin: z.string().describe("Origin city or airport, e.g. 'New York' or 'JFK'"),
  destination: z.string().describe("Destination city or airport, e.g. 'Los Angeles' or 'LAX'"),
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date, YYYY-MM-DD"),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Return date, YYYY-MM-DD. Omit for one-way"),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
  adults: z.number().int().min(1).max(9).default(1),
};

server.registerTool(
  "search_flights",
  {
    title: "Search Google Flights",
    description:
      "Searches Google Flights for a route and returns structured flight options (airline, times, stops, price). Does not check policy or book anything.",
    inputSchema: searchParamsShape,
  },
  async (params) => {
    const page = await browserSession.getPage();
    const flights = await searchGoogleFlights(page, params);
    lastSearchResults.clear();
    for (const f of flights) lastSearchResults.set(f.id, f);

    return {
      content: [{ type: "text", text: JSON.stringify({ count: flights.length, flights }, null, 2) }],
    };
  },
);

server.registerTool(
  "check_policy",
  {
    title: "Check a flight against a travel policy",
    description:
      "Evaluates a specific flight (by id from the last search_flights call) against a policy JSON file and returns compliance, violations, and whether it needs approval.",
    inputSchema: {
      flightId: z.string().describe("A flight id returned by search_flights"),
      policyPath: z.string().default("./policy.json").describe("Path to the policy JSON file"),
    },
  },
  async ({ flightId, policyPath }) => {
    const flight = lastSearchResults.get(flightId);
    if (!flight) {
      return {
        content: [{ type: "text", text: `No cached flight with id ${flightId}. Run search_flights first.` }],
        isError: true,
      };
    }
    const policy = loadPolicy(resolve(policyPath));
    const evaluation = evaluateFlightAgainstPolicy(flight, policy);
    return { content: [{ type: "text", text: JSON.stringify(evaluation, null, 2) }] };
  },
);

server.registerTool(
  "find_compliant_flights",
  {
    title: "Search and filter by policy in one step",
    description:
      "Searches Google Flights and evaluates every result against a policy file, returning only compliant options (plus a summary of how many were rejected and why), sorted by price.",
    inputSchema: { ...searchParamsShape, policyPath: z.string().default("./policy.json") },
  },
  async ({ policyPath, ...params }) => {
    const page = await browserSession.getPage();
    const flights = await searchGoogleFlights(page, params);
    lastSearchResults.clear();
    for (const f of flights) lastSearchResults.set(f.id, f);

    const policy = loadPolicy(resolve(policyPath));
    const evaluations = flights.map((f) => evaluateFlightAgainstPolicy(f, policy));
    const compliant = evaluations.filter((e) => e.compliant).sort((a, b) => a.flight.price - b.flight.price);
    const rejected = evaluations.filter((e) => !e.compliant);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              totalFound: flights.length,
              compliantCount: compliant.length,
              rejectedCount: rejected.length,
              compliant,
              rejectedSummary: rejected.map((e) => ({
                flightId: e.flight.id,
                airline: e.flight.airline,
                price: e.flight.price,
                reasons: e.violations.filter((v) => v.severity === "block").map((v) => v.message),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "start_booking",
  {
    title: "Start booking a flight (stops before payment)",
    description:
      "Re-validates the chosen flight against policy, then drives Google Flights through fare selection to the airline/OTA site and best-effort fills traveler details. " +
      "ALWAYS stops before any payment field or purchase button — it never enters payment info or completes a purchase. Returns a report of what was filled, what wasn't, " +
      "and the URL/screenshot where a human needs to take over. If the flight is out of policy, booking is refused unless acknowledgeOutOfPolicy is explicitly set to true.",
    inputSchema: {
      flightId: z.string().describe("A flight id returned by search_flights"),
      policyPath: z.string().default("./policy.json"),
      traveler: z.object({
        firstName: z.string(),
        lastName: z.string(),
        dateOfBirth: z.string().optional(),
        gender: z.enum(["M", "F", "X"]).optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        frequentFlyerNumber: z.string().optional(),
        knownTravelerNumber: z.string().optional(),
        passportNumber: z.string().optional(),
        passportCountry: z.string().optional(),
        passportExpiry: z.string().optional(),
      }),
      fareChoice: z
        .enum(["cheapest", "match_policy_price"])
        .default("cheapest")
        .describe("Which fare tile to pick on the airline's booking-options panel"),
      acknowledgeOutOfPolicy: z
        .boolean()
        .default(false)
        .describe("Must be explicitly true to proceed with a flight that fails policy checks"),
    },
  },
  async ({ flightId, policyPath, traveler, fareChoice, acknowledgeOutOfPolicy }) => {
    const flight = lastSearchResults.get(flightId);
    if (!flight) {
      return {
        content: [{ type: "text", text: `No cached flight with id ${flightId}. Run search_flights first.` }],
        isError: true,
      };
    }

    const policy = loadPolicy(resolve(policyPath));
    const evaluation = evaluateFlightAgainstPolicy(flight, policy);
    if (!evaluation.compliant && !acknowledgeOutOfPolicy) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "OUT_OF_POLICY",
                message: "This flight fails policy checks. Re-call with acknowledgeOutOfPolicy: true to proceed anyway.",
                violations: evaluation.violations,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const page = await browserSession.getPage();
    const searchParams = {
      origin: flight.origin,
      destination: flight.destination,
      departDate: flight.departDate,
      returnDate: flight.returnDate,
      cabin: flight.cabin,
      adults: 1,
    };

    const bookingOptions = await selectFlightForBooking(page, searchParams, flightId);
    if (bookingOptions.length === 0) {
      const screenshot = await browserSession.screenshot("no-booking-options");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "STOPPED",
                reason: "No booking options were found on the fare-selection panel — the page may have changed.",
                screenshot,
                url: page.url(),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const chosen =
      fareChoice === "match_policy_price"
        ? bookingOptions.reduce((a, b) => (Math.abs(a.price - flight.price) <= Math.abs(b.price - flight.price) ? a : b))
        : bookingOptions.reduce((a, b) => (a.price <= b.price ? a : b));

    const bookingPage = await continueToBookingOption(page, chosen.buttonLabel);

    const paymentDetected = await detectPaymentStep(bookingPage);
    if (paymentDetected) {
      const screenshot = await browserSession.screenshot("stopped-at-payment");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "STOPPED_AT_PAYMENT",
                reason: paymentDetected,
                chosenFare: chosen,
                url: bookingPage.url(),
                screenshot,
                message: "Traveler details were not attempted because the destination page already shows a payment step. Complete this booking yourself.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const report = await autofillTravelerDetails(bookingPage, traveler as TravelerDetails);
    const nextActions = await findNextActionButtons(bookingPage);
    const screenshot = await browserSession.screenshot("traveler-details-filled");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: report.stoppedForPayment ? "STOPPED_AT_PAYMENT" : "TRAVELER_DETAILS_ATTEMPTED",
              chosenFare: chosen,
              fieldsFilled: report.fields,
              stoppedForPayment: report.stoppedForPayment,
              likelyNextActionButtons: nextActions,
              url: bookingPage.url(),
              screenshot,
              message:
                "Stopped before payment. Review the filled fields, complete anything marked not_found, and finish checkout (including payment) yourself in the browser window.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "close_browser",
  {
    title: "Close the browser session",
    description: "Closes the Playwright browser opened by this server. Call when done with a booking session.",
    inputSchema: {},
  },
  async () => {
    await browserSession.close();
    return { content: [{ type: "text", text: "Browser closed." }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
