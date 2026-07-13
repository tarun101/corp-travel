import { extractDepartMinutesOfDay, parseTimeToMinutes } from "./policy.js";
import type { Preferences } from "./preferences.js";
import type { FlightOption, PolicyEvaluation } from "./types.js";

// Not exhaustive — covers the major carriers likely to show up on US-origin
// searches. A flight operated by an airline not listed here simply gets no
// alliance credit either way, rather than being penalized.
const STAR_ALLIANCE = new Set([
  "United", "Lufthansa", "Air Canada", "Singapore Airlines", "ANA",
  "All Nippon Airways", "Turkish Airlines", "Air India", "Air New Zealand",
  "Asiana Airlines", "Austrian", "Avianca", "Brussels Airlines",
  "Copa Airlines", "Croatia Airlines", "EGYPTAIR", "Ethiopian Airlines",
  "EVA Air", "LOT Polish Airlines", "SAS", "Scandinavian Airlines",
  "Shenzhen Airlines", "South African Airways", "Swiss", "TAP Air Portugal",
  "Thai Airways",
]);

const SKYTEAM = new Set([
  "Delta", "Air France", "KLM", "Korean Air", "China Eastern",
  "China Southern", "Aeroflot", "Aeromexico", "Air Europa", "Alitalia",
  "ITA Airways", "China Airlines", "Czech Airlines", "Garuda Indonesia",
  "Kenya Airways", "Middle East Airlines", "Saudia", "Tarom",
  "Vietnam Airlines", "Xiamen Airlines",
]);

const ONEWORLD = new Set([
  "American", "British Airways", "Cathay Pacific", "Japan Airlines",
  "Qantas", "Qatar Airways", "Finnair", "Iberia", "Malaysia Airlines",
  "Royal Air Maroc", "Royal Jordanian", "SriLankan Airlines",
  "Alaska Airlines", "Alaska",
]);

const ALLIANCE_SETS: Record<string, Set<string>> = {
  star_alliance: STAR_ALLIANCE,
  skyteam: SKYTEAM,
  oneworld: ONEWORLD,
};

// Google reports codeshare/multi-carrier itineraries as e.g. "Delta and KLM".
function splitCarriers(airline: string): string[] {
  return airline.split(/\s+and\s+|,\s*/).map((s) => s.trim()).filter(Boolean);
}

function allianceMatch(airline: string, alliance: string): "full" | "partial" | "none" {
  const set = ALLIANCE_SETS[alliance];
  if (!set) return "none";
  const carriers = splitCarriers(airline);
  const matches = carriers.filter((c) => set.has(c));
  if (matches.length === 0) return "none";
  return matches.length === carriers.length ? "full" : "partial";
}

export interface ScoreBreakdownItem {
  label: string;
  delta: number;
}

export interface RankedFlight {
  flight: FlightOption;
  policyCompliant: boolean;
  requiresApproval: boolean;
  policyViolations: PolicyEvaluation["violations"];
  score: number;
  labels: string[];
  breakdown: ScoreBreakdownItem[];
}

function isWithinWindow(minutesOfDay: number, startHHMM: string, endHHMM: string): boolean {
  const start = parseTimeToMinutes(startHHMM);
  const end = parseTimeToMinutes(endHHMM);
  // Red-eye windows typically wrap past midnight (e.g. 22:00-05:00).
  if (start > end) return minutesOfDay >= start || minutesOfDay <= end;
  return minutesOfDay >= start && minutesOfDay <= end;
}

function normalizedWeight(value: number, min: number, max: number, weight: number): number {
  if (max === min) return weight; // every candidate is identical on this axis
  return (1 - (value - min) / (max - min)) * weight;
}

const OPTIMIZE_WEIGHTS: Record<Preferences["optimizeFor"], { price: number; duration: number }> = {
  cheapest: { price: 40, duration: 5 },
  fastest: { price: 5, duration: 40 },
  balanced: { price: 20, duration: 20 },
};

/**
 * Scores and labels one flight against a policy evaluation + preferences.
 * The breakdown is returned alongside the total so the ranking is auditable
 * rather than a black box — useful both for debugging and for demonstrating
 * to a user why a flight ranked where it did.
 */
export function scoreFlight(
  evaluation: PolicyEvaluation,
  prefs: Preferences,
  priceRange: { min: number; max: number },
  durationRange: { min: number; max: number },
): RankedFlight {
  const flight = evaluation.flight;
  const breakdown: ScoreBreakdownItem[] = [];
  const labels: string[] = [];

  const blockingViolations = evaluation.violations.filter((v) => v.severity === "block");
  if (evaluation.compliant) {
    breakdown.push({ label: "In policy", delta: 40 });
    labels.push("✅ In Policy");
  } else {
    breakdown.push({ label: `Out of policy (${blockingViolations.length} violation(s))`, delta: -80 });
    labels.push("🚫 Out of Policy");
  }
  if (evaluation.requiresApproval) {
    breakdown.push({ label: "Requires approval", delta: -10 });
    labels.push("⚠️ Needs Approval");
  }

  if (prefs.preferNonstop) {
    if (flight.stops === 0) {
      breakdown.push({ label: "Nonstop", delta: 20 });
      labels.push("✈️ Nonstop");
    } else {
      breakdown.push({ label: `${flight.stops} stop(s)`, delta: -8 * flight.stops });
      labels.push(`🔁 ${flight.stops} stop${flight.stops > 1 ? "s" : ""}`);
    }
  } else if (flight.stops === 0) {
    labels.push("✈️ Nonstop");
  }

  if (prefs.preferredAlliance) {
    const match = allianceMatch(flight.airline, prefs.preferredAlliance);
    if (match === "full") {
      breakdown.push({ label: `${prefs.preferredAlliance} match`, delta: 15 });
      labels.push(`⭐ ${prefs.preferredAlliance.replace("_", " ")}`);
    } else if (match === "partial") {
      breakdown.push({ label: `${prefs.preferredAlliance} partial match`, delta: 7 });
      labels.push(`⭐ ${prefs.preferredAlliance.replace("_", " ")} (partial)`);
    }
  }

  const departMinutes = extractDepartMinutesOfDay(flight.departTime);
  if (departMinutes !== null) {
    const isRedEye = isWithinWindow(departMinutes, prefs.redEyeWindow.departAfter, prefs.redEyeWindow.departBefore);
    if (isRedEye) {
      labels.push("🌙 Red-eye");
      if (prefs.avoidRedEye) {
        breakdown.push({ label: "Red-eye departure", delta: -15 });
      }
    }

    if (prefs.preferEarlyMorning) {
      const isEarlyMorning = isWithinWindow(departMinutes, prefs.earlyMorningWindow.start, prefs.earlyMorningWindow.end);
      if (isEarlyMorning) {
        breakdown.push({ label: "Early morning departure", delta: 10 });
        labels.push("🌅 Early Morning");
      }
    }
  }

  const weights = OPTIMIZE_WEIGHTS[prefs.optimizeFor];
  const priceScore = normalizedWeight(flight.price, priceRange.min, priceRange.max, weights.price);
  breakdown.push({ label: `Price $${flight.price} (of $${priceRange.min}-$${priceRange.max} range)`, delta: Math.round(priceScore * 10) / 10 });
  const durationScore = normalizedWeight(flight.durationMinutes, durationRange.min, durationRange.max, weights.duration);
  breakdown.push({ label: `Duration ${flight.durationMinutes}min (of ${durationRange.min}-${durationRange.max} range)`, delta: Math.round(durationScore * 10) / 10 });

  const score = Math.round(breakdown.reduce((sum, b) => sum + b.delta, 0) * 10) / 10;

  return {
    flight,
    policyCompliant: evaluation.compliant,
    requiresApproval: evaluation.requiresApproval,
    policyViolations: evaluation.violations,
    score,
    labels,
    breakdown,
  };
}

export function rankFlights(evaluations: PolicyEvaluation[], prefs: Preferences): RankedFlight[] {
  if (evaluations.length === 0) return [];
  const prices = evaluations.map((e) => e.flight.price);
  const durations = evaluations.map((e) => e.flight.durationMinutes);
  const priceRange = { min: Math.min(...prices), max: Math.max(...prices) };
  const durationRange = { min: Math.min(...durations), max: Math.max(...durations) };

  const ranked = evaluations.map((e) => scoreFlight(e, prefs, priceRange, durationRange));
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    ranked[0].labels.unshift("🏆 Best Match");
  }
  return ranked;
}
