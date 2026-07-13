export type CabinClass = "economy" | "premium_economy" | "business" | "first";

export interface SearchParams {
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD
  returnDate?: string; // YYYY-MM-DD, omit for one-way
  cabin: CabinClass;
  adults: number;
}

export interface FlightOption {
  id: string; // stable-ish id derived from the scraped fields, used to re-select later
  airline: string;
  flightNumbers: string[];
  departTime: string; // ISO-ish local time string as shown by Google Flights
  arriveTime: string;
  durationMinutes: number;
  stops: number;
  price: number;
  currency: string;
  cabin: CabinClass;
  isRefundable: boolean | null; // null = unknown, Google Flights doesn't always expose this
  bookingUrl: string | null; // deep link if Google Flights exposed one
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  raw: string; // raw scraped text for debugging when fields don't parse cleanly
}

export interface TravelerDetails {
  firstName: string;
  lastName: string;
  dateOfBirth?: string; // YYYY-MM-DD
  gender?: "M" | "F" | "X";
  email?: string;
  phone?: string;
  frequentFlyerNumber?: string;
  knownTravelerNumber?: string;
  passportNumber?: string;
  passportCountry?: string;
  passportExpiry?: string;
}

export interface PolicyViolation {
  rule: string;
  message: string;
  severity: "block" | "warn";
}

export interface PolicyEvaluation {
  compliant: boolean;
  requiresApproval: boolean;
  violations: PolicyViolation[];
  flight: FlightOption;
}
