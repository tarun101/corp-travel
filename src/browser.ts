import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCREENSHOT_DIR = join(process.cwd(), ".booking-screenshots");

// Patterns that identify a payment step. If any of these show up in the page's
// visible text, or in a field's name/label/placeholder/autocomplete attribute,
// the booking flow must stop and hand control back to a human. This is a hard
// safety boundary, not a heuristic to be tuned away.
export const PAYMENT_FIELD_PATTERN =
  /card ?number|credit ?card|debit ?card|cvv|cvc|security ?code|expir|card ?holder|billing ?address|routing ?number|account ?number|iban|swift/i;

export const PAYMENT_ACTION_PATTERN =
  /\bpay\b|purchase|place order|buy now|complete booking|confirm (and )?pay|submit payment|checkout/i;

class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    if (!this.browser) {
      this.browser = await chromium.launch({ headless: false });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1400, height: 1000 },
      });
    }
    this.page = await this.context.newPage();
    return this.page;
  }

  async screenshot(label: string): Promise<string> {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const page = await this.getPage();
    const path = join(SCREENSHOT_DIR, `${Date.now()}-${label}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

export const browserSession = new BrowserSession();

/**
 * Scans the current page for a payment step. Returns a reason string if one is
 * detected, otherwise null. Callers must stop and never click/type further once
 * this returns non-null.
 */
export async function detectPaymentStep(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (PAYMENT_FIELD_PATTERN.test(bodyText)) {
    const match = bodyText.match(PAYMENT_FIELD_PATTERN);
    return `Page text mentions a payment field ("${match?.[0]}")`;
  }

  const inputs = await page
    .locator("input")
    .evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute("name") ?? "",
        id: el.id ?? "",
        placeholder: el.getAttribute("placeholder") ?? "",
        autocomplete: el.getAttribute("autocomplete") ?? "",
        type: (el as HTMLInputElement).type ?? "",
      })),
    )
    .catch(() => []);

  for (const input of inputs) {
    const haystack = `${input.name} ${input.id} ${input.placeholder} ${input.autocomplete}`;
    if (PAYMENT_FIELD_PATTERN.test(haystack) || input.type === "credit-card" || input.autocomplete.startsWith("cc-")) {
      return `Found a form field that looks like a payment field: ${JSON.stringify(input)}`;
    }
  }

  return null;
}
