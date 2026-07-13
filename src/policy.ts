import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CabinClass, FlightOption, PolicyEvaluation, PolicyViolation } from "./types.js";

const CabinClassSchema = z.enum(["economy", "premium_economy", "business", "first"]);

export const PolicySchema = z.object({
  name: z.string(),
  currency: z.string().default("USD"),
  maxFare: z
    .object({
      domestic: z.number().positive().optional(),
      international: z.number().positive().optional(),
    })
    .optional(),
  allowedCabin: z
    .object({
      domestic: z.array(CabinClassSchema).default(["economy", "premium_economy"]),
      international: z.array(CabinClassSchema).default(["economy", "premium_economy", "business"]),
      // above this flight duration, a higher cabin listed in `allowedCabin.international`
      // is allowed even if it wouldn't otherwise be for a shorter flight
      longHaulBusinessThresholdHours: z.number().positive().optional(),
    })
    .optional(),
  maxStops: z.number().int().min(0).default(2),
  minAdvancePurchaseDays: z.number().int().min(0).default(0),
  preferredAirlines: z.array(z.string()).default([]),
  blockedAirlines: z.array(z.string()).default([]),
  refundableRequired: z.boolean().default(false),
  departureTimeWindow: z
    .object({
      earliest: z.string().regex(/^\d{2}:\d{2}$/), // "05:00"
      latest: z.string().regex(/^\d{2}:\d{2}$/), // "23:00"
    })
    .optional(),
  requireApprovalAboveFare: z.number().positive().optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(path: string): Policy {
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return PolicySchema.parse(json);
}

// Pragmatic domestic/international check: a small list of major US airport codes.
// This is NOT exhaustive. Unknown codes are treated as international (the safer
// default, since international policy caps are usually equal or looser but cabin
// rules are usually stricter) so an unrecognized code never silently escapes the
// stricter domestic checks.
const US_AIRPORTS = new Set([
  "ATL", "LAX", "ORD", "DFW", "DEN", "JFK", "SFO", "SEA", "LAS", "MCO",
  "EWR", "CLT", "PHX", "IAH", "MIA", "BOS", "MSP", "FLL", "DTW", "PHL",
  "LGA", "BWI", "SLC", "SAN", "IAD", "DCA", "MDW", "TPA", "PDX", "HNL",
  "STL", "AUS", "OAK", "MSY", "SJC", "SMF", "SNA", "RDU", "SAT", "DAL",
]);

function isDomestic(flight: FlightOption): boolean {
  return US_AIRPORTS.has(flight.origin.toUpperCase()) && US_AIRPORTS.has(flight.destination.toUpperCase());
}

export function parseTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Parses Google's 12-hour "9:10 AM" / "6:20 PM" departTime strings into
// minutes-since-midnight. The AM/PM suffix matters — without it, 6:20 AM and
// 6:20 PM are indistinguishable, which would silently misjudge every
// afternoon/evening departure against a departure-time-window policy.
export function extractDepartMinutesOfDay(departTime: string): number | null {
  const match = departTime.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

export function evaluateFlightAgainstPolicy(
  flight: FlightOption,
  policy: Policy,
  bookingDate: Date = new Date(),
): PolicyEvaluation {
  const violations: PolicyViolation[] = [];
  const domestic = isDomestic(flight);

  // 1. Fare cap
  const cap = domestic ? policy.maxFare?.domestic : policy.maxFare?.international;
  if (cap !== undefined && flight.price > cap) {
    violations.push({
      rule: "maxFare",
      message: `Fare ${flight.currency} ${flight.price} exceeds ${domestic ? "domestic" : "international"} cap of ${policy.currency} ${cap}`,
      severity: "block",
    });
  }

  // 2. Cabin class
  const defaultDomesticCabins: CabinClass[] = ["economy", "premium_economy"];
  const defaultIntlCabins: CabinClass[] = ["economy", "premium_economy", "business"];
  const allowedCabins: CabinClass[] = domestic
    ? (policy.allowedCabin?.domestic ?? defaultDomesticCabins)
    : (policy.allowedCabin?.international ?? defaultIntlCabins);
  const longHaulThreshold = policy.allowedCabin?.longHaulBusinessThresholdHours;
  const longHaulOk =
    !domestic &&
    longHaulThreshold !== undefined &&
    flight.durationMinutes / 60 >= longHaulThreshold &&
    (flight.cabin === "business" || flight.cabin === "first");
  if (!allowedCabins.includes(flight.cabin) && !longHaulOk) {
    violations.push({
      rule: "cabinClass",
      message: `Cabin '${flight.cabin}' is not allowed for this route (allowed: ${allowedCabins.join(", ")})`,
      severity: "block",
    });
  }

  // 3. Stops
  if (flight.stops > policy.maxStops) {
    violations.push({
      rule: "maxStops",
      message: `${flight.stops} stop(s) exceeds policy max of ${policy.maxStops}`,
      severity: "block",
    });
  }

  // 4. Blocked airlines
  if (policy.blockedAirlines.some((a) => a.toLowerCase() === flight.airline.toLowerCase())) {
    violations.push({
      rule: "blockedAirline",
      message: `${flight.airline} is on the blocked airline list`,
      severity: "block",
    });
  }

  // 5. Preferred airlines (soft warning, not a block)
  if (
    policy.preferredAirlines.length > 0 &&
    !policy.preferredAirlines.some((a) => a.toLowerCase() === flight.airline.toLowerCase())
  ) {
    violations.push({
      rule: "preferredAirline",
      message: `${flight.airline} is not on the preferred airline list (${policy.preferredAirlines.join(", ")})`,
      severity: "warn",
    });
  }

  // 6. Advance purchase window
  if (policy.minAdvancePurchaseDays > 0) {
    const departDate = new Date(flight.departDate);
    const daysOut = Math.floor((departDate.getTime() - bookingDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysOut < policy.minAdvancePurchaseDays) {
      violations.push({
        rule: "minAdvancePurchaseDays",
        message: `Booking ${daysOut} day(s) before departure is inside the required ${policy.minAdvancePurchaseDays}-day advance-purchase window`,
        severity: "block",
      });
    }
  }

  // 7. Refundable requirement
  if (policy.refundableRequired && flight.isRefundable !== true) {
    violations.push({
      rule: "refundableRequired",
      message:
        flight.isRefundable === null
          ? "Refundability could not be determined from Google Flights and policy requires refundable fares"
          : "Fare is non-refundable but policy requires refundable fares",
      severity: "block",
    });
  }

  // 8. Departure time window
  if (policy.departureTimeWindow) {
    const minutesOfDay = extractDepartMinutesOfDay(flight.departTime);
    if (minutesOfDay !== null) {
      const earliest = parseTimeToMinutes(policy.departureTimeWindow.earliest);
      const latest = parseTimeToMinutes(policy.departureTimeWindow.latest);
      if (minutesOfDay < earliest || minutesOfDay > latest) {
        violations.push({
          rule: "departureTimeWindow",
          message: `Departure time ${flight.departTime} falls outside allowed window ${policy.departureTimeWindow.earliest}–${policy.departureTimeWindow.latest}`,
          severity: "warn",
        });
      }
    }
  }

  const blockingViolations = violations.filter((v) => v.severity === "block");
  const requiresApproval =
    policy.requireApprovalAboveFare !== undefined && flight.price > policy.requireApprovalAboveFare;

  return {
    compliant: blockingViolations.length === 0,
    requiresApproval,
    violations,
    flight,
  };
}
