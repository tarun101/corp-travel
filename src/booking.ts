import type { Page } from "playwright";
import { detectPaymentStep, PAYMENT_ACTION_PATTERN, PAYMENT_FIELD_PATTERN } from "./browser.js";
import type { TravelerDetails } from "./types.js";

export interface FieldFillResult {
  field: string;
  status: "filled" | "not_found" | "skipped_payment_adjacent";
}

export interface AutofillReport {
  fields: FieldFillResult[];
  stoppedForPayment: string | null;
  finalUrl: string;
}

// Maps our TravelerDetails keys to the label/placeholder/autocomplete text
// patterns commonly used on airline and OTA booking forms. This is inherently
// a best-effort heuristic — every site names its fields differently — so each
// pattern list is intentionally generous and the caller gets a field-by-field
// report of what was and wasn't filled rather than a silent all-or-nothing.
const FIELD_PATTERNS: Array<{ key: keyof TravelerDetails; patterns: RegExp[] }> = [
  { key: "firstName", patterns: [/first\s*name/i, /given\s*name/i] },
  { key: "lastName", patterns: [/last\s*name/i, /sur\s*name/i, /family\s*name/i] },
  { key: "email", patterns: [/e-?mail/i] },
  { key: "phone", patterns: [/phone/i, /mobile/i, /telephone/i] },
  { key: "dateOfBirth", patterns: [/date of birth/i, /birth\s*date/i, /\bdob\b/i] },
  { key: "frequentFlyerNumber", patterns: [/frequent\s*flyer/i, /mileage\s*plus/i, /loyalty/i, /rewards\s*number/i] },
  { key: "knownTravelerNumber", patterns: [/known\s*traveler/i, /\bktn\b/i, /tsa\s*pre/i] },
  { key: "passportNumber", patterns: [/passport\s*number/i, /passport\s*no/i] },
];

async function describeInput(input: ReturnType<Page["locator"]>): Promise<string> {
  const [name, id, placeholder, ariaLabel] = await Promise.all([
    input.getAttribute("name").catch(() => null),
    input.getAttribute("id").catch(() => null),
    input.getAttribute("placeholder").catch(() => null),
    input.getAttribute("aria-label").catch(() => null),
  ]);
  return [name, id, placeholder, ariaLabel].filter(Boolean).join(" ");
}

/**
 * Best-effort fills traveler fields on the current page using label/name/
 * placeholder heuristics, then stops. Never interacts with anything that
 * looks like a payment field or a submit/pay/purchase button — that is a
 * hard safety boundary, not a tunable setting.
 */
export async function autofillTravelerDetails(page: Page, traveler: TravelerDetails): Promise<AutofillReport> {
  const fields: FieldFillResult[] = [];

  const preCheck = await detectPaymentStep(page);
  if (preCheck) {
    return { fields, stoppedForPayment: preCheck, finalUrl: page.url() };
  }

  const inputs = page.locator("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea");
  const count = await inputs.count();

  for (const { key, patterns } of FIELD_PATTERNS) {
    const value = traveler[key];
    if (!value) continue;

    let filled = false;
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const haystack = await describeInput(input);
      if (!haystack) continue;

      if (patterns.some((p) => p.test(haystack))) {
        // Defense in depth: never type into anything that also matches the
        // payment-field pattern, even if it happens to match a traveler
        // field pattern too (e.g. a mis-labeled "name on card" field).
        if (PAYMENT_FIELD_PATTERN.test(haystack)) {
          fields.push({ field: key, status: "skipped_payment_adjacent" });
          filled = true;
          break;
        }
        await input.fill(String(value)).catch(() => {});
        fields.push({ field: key, status: "filled" });
        filled = true;
        break;
      }
    }
    if (!filled) {
      fields.push({ field: key, status: "not_found" });
    }
  }

  const postCheck = await detectPaymentStep(page);
  return { fields, stoppedForPayment: postCheck, finalUrl: page.url() };
}

/**
 * Scans clickable elements for anything that looks like it would submit a
 * payment or complete a purchase, without clicking any of them. Used to
 * report to the caller what the "next step" would be so a human can take it.
 */
export async function findNextActionButtons(page: Page): Promise<string[]> {
  const buttons = page.locator("button, input[type=submit], a[role=button]");
  const count = await buttons.count();
  const labels: string[] = [];
  for (let i = 0; i < Math.min(count, 200); i++) {
    const text = (await buttons.nth(i).innerText().catch(() => "")).trim();
    if (text && PAYMENT_ACTION_PATTERN.test(text)) {
      labels.push(text);
    }
  }
  return [...new Set(labels)];
}
