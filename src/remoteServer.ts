#!/usr/bin/env node
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { z } from "zod";
import { resolve } from "node:path";
import type { Request, Response } from "express";
import { searchGoogleFlights } from "./googleFlights.js";
import { evaluateFlightAgainstPolicy, loadPolicy, PolicySchema, type Policy } from "./policy.js";
import { loadPreferences, parsePreferences, PreferencesSchema, type Preferences } from "./preferences.js";
import { rankFlights, type RankedFlight } from "./scoring.js";
import { GoogleOAuthProvider, mountGoogleOAuthCallback } from "./googleOAuth.js";

const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;
if (!BEARER_TOKEN) {
  console.error("FATAL: MCP_BEARER_TOKEN is not set. Refusing to start an unauthenticated remote server.");
  process.exit(1);
}

const POLICY_PATH = resolve(process.env.POLICY_PATH ?? "./policy.json");
const PREFERENCES_PATH = resolve(process.env.PREFERENCES_PATH ?? "./user_preferences.json");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim());
const MAX_CONCURRENT_SEARCHES = Number(process.env.MAX_CONCURRENT_SEARCHES ?? 3);
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 45_000);

// --- optional Google OAuth ------------------------------------------------
// Only activates if all three are set, so the server still works with just
// MCP_BEARER_TOKEN (Bearer/Basic) when Google credentials haven't been
// configured yet. GOOGLE_OAUTH_CALLBACK_PATH must exactly match a redirect
// URI registered on the Google OAuth client in Cloud Console.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback";
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS ?? "routespring.com,gallop.ai")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const googleOAuthProvider =
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && PUBLIC_BASE_URL
    ? new GoogleOAuthProvider({
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackUrl: new URL(GOOGLE_OAUTH_CALLBACK_PATH, PUBLIC_BASE_URL).toString(),
        allowedEmailDomains: ALLOWED_EMAIL_DOMAINS,
      })
    : null;

if (!googleOAuthProvider) {
  console.error(
    "Google OAuth not configured (set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, PUBLIC_BASE_URL to enable) " +
      "— falling back to MCP_BEARER_TOKEN only.",
  );
}

// --- tiny concurrency limiter -------------------------------------------
// A cheap host running a tech demo shouldn't fall over if a handful of
// requests land at once, each spawning a real Chromium process. This is a
// simple counting semaphore, not a queue with fairness guarantees — good
// enough for "not much load."
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolveWait) => this.waiters.push(resolveWait));
    this.available--;
    return () => this.release();
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const searchSlots = new Semaphore(MAX_CONCURRENT_SEARCHES);

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// --- config loading -------------------------------------------------------
// POLICY_JSON / PREFERENCES_JSON (raw JSON in an env var) take precedence
// over the file paths — most cheap container platforms (Cloud Run, Fly,
// Render) make env vars trivial to set but file mounts a hassle, so this is
// the easiest way to configure a real deployment without rebuilding the
// image. Falls back to reading the file fresh on every call (not cached) so
// policy.json / user_preferences.json can be tweaked live during a local
// demo without a restart.
function loadDefaultPolicy(): Policy {
  if (process.env.POLICY_JSON) {
    return PolicySchema.parse(JSON.parse(process.env.POLICY_JSON));
  }
  return loadPolicy(POLICY_PATH);
}

function loadDefaultPreferences(): Preferences {
  if (process.env.PREFERENCES_JSON) {
    return parsePreferences(JSON.parse(process.env.PREFERENCES_JSON));
  }
  return loadPreferences(PREFERENCES_PATH);
}

const searchParamsShape = {
  origin: z.string().describe("Origin city or airport, e.g. 'New York' or 'JFK'"),
  destination: z.string().describe("Destination city or airport, e.g. 'Los Angeles' or 'LAX'"),
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date, YYYY-MM-DD"),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Return date, YYYY-MM-DD. Omit for one-way"),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
  adults: z.number().int().min(1).max(9).default(1),
  policyOverride: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Optional inline policy JSON (same shape as policy.json) to use instead of the server's default policy, for this call only. " +
        "This server has no access to the caller's local filesystem — if the user has their own policy.json, the calling assistant " +
        "must read that file itself and pass its parsed contents here. This is the recommended way for different colleagues/teams " +
        "to use their own policy without changing the shared server default.",
    ),
  preferencesOverride: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Optional inline preferences JSON (same shape as user_preferences.json) to use instead of the server's default preferences, " +
        "for this call only. Same rule as policyOverride: the calling assistant must read the user's local user_preferences.json " +
        "itself and pass its parsed contents here — the server cannot read local files.",
    ),
};

function trimRankedFlight(r: RankedFlight) {
  const { raw, ...flight } = r.flight;
  return {
    flight,
    policyCompliant: r.policyCompliant,
    requiresApproval: r.requiresApproval,
    policyViolations: r.policyViolations,
    score: r.score,
    labels: r.labels,
    scoreBreakdown: r.breakdown,
  };
}

function getServer(): McpServer {
  const server = new McpServer({
    name: "corp-travel",
    version: "0.1.0",
  });

  server.registerTool(
    "search_and_recommend_flights",
    {
      title: "Search Google Flights and rank by policy + preferences",
      description:
        "Searches Google Flights for a route, labels every result as in-policy or out-of-policy, scores and ranks them by your travel preferences " +
        "(nonstop, alliance, red-eye avoidance, cheapest/fastest/balanced), and returns them best-match-first. Does NOT visit any airline or OTA " +
        "site and does not attempt to book anything — it returns a Google Flights results link for you to complete the booking yourself. " +
        "This is a technology demonstration of policy-aware flight recommendations, not a production booking agent. " +
        "Before calling this without policyOverride/preferencesOverride, check whether the user has their own local policy.json and/or " +
        "user_preferences.json (e.g. in their home directory or a project folder they mention) — if so, read it and pass its contents via " +
        "policyOverride/preferencesOverride so results reflect their personal policy rather than this shared server's default. This is the " +
        "intended way for different users to bring their own policy without changing the server for everyone else.",
      inputSchema: searchParamsShape,
    },
    async ({ policyOverride, preferencesOverride, ...params }) => {
      const release = await searchSlots.acquire();
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

        const policy = policyOverride ? PolicySchema.parse(policyOverride) : loadDefaultPolicy();
        const preferences = preferencesOverride ? parsePreferences(preferencesOverride) : loadDefaultPreferences();

        const flights = await withTimeout(searchGoogleFlights(page, params), SEARCH_TIMEOUT_MS, "Flight search");
        const googleFlightsUrl = page.url();

        const evaluations = flights.map((f) => evaluateFlightAgainstPolicy(f, policy));
        const ranked = rankFlights(evaluations, preferences);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  route: `${params.origin} → ${params.destination}`,
                  searchParams: params,
                  policyUsed: policy.name,
                  preferencesUsed: preferences.name,
                  googleFlightsUrl,
                  bookingNote:
                    "This link reproduces the exact search on Google Flights. Pick your flight there to complete the actual booking — " +
                    "this server does not visit airline sites or handle payment.",
                  totalFound: ranked.length,
                  compliantCount: ranked.filter((r) => r.policyCompliant).length,
                  flights: ranked.map(trimRankedFlight),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      } finally {
        await browser.close().catch(() => {});
        release();
      }
    },
  );

  server.registerTool(
    "get_active_config",
    {
      title: "Show the default policy and preferences currently in effect",
      description:
        "Returns the server's default travel policy and preference config (the same ones search_and_recommend_flights uses when no override is passed). Useful for showing what's driving the recommendations.",
      inputSchema: {},
    },
    async () => {
      try {
        const policy = loadDefaultPolicy();
        const preferences = loadDefaultPreferences();
        return { content: [{ type: "text", text: JSON.stringify({ policy, preferences }, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Could not load config: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// Three ways in, checked in order:
//   1. Authorization: Bearer <MCP_BEARER_TOKEN>       — static shared secret
//   2. Authorization: Basic base64(<any user>:<MCP_BEARER_TOKEN>) — same secret,
//      exposed as username/password since that's what claude.ai's custom-
//      connector UI offers alongside OAuth (no raw bearer-token field)
//   3. Authorization: Bearer <token issued by GoogleOAuthProvider>  — real
//      per-person sign-in, only active when Google OAuth is configured
async function checkAuth(req: Request, res: Response): Promise<boolean> {
  const header = req.header("authorization") ?? "";
  const [scheme, credential] = header.split(" ");

  let ok = false;
  if (scheme === "Bearer" && credential === BEARER_TOKEN) {
    ok = true;
  } else if (scheme === "Basic" && credential) {
    const decoded = Buffer.from(credential, "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");
    const password = separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
    ok = password === BEARER_TOKEN;
  } else if (scheme === "Bearer" && credential && googleOAuthProvider) {
    ok = await googleOAuthProvider
      .verifyAccessToken(credential)
      .then(() => true)
      .catch(() => false);
  }

  if (!ok) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid credentials" },
      id: null,
    });
    return false;
  }
  return true;
}

const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });

if (googleOAuthProvider && PUBLIC_BASE_URL) {
  app.use(
    mcpAuthRouter({
      provider: googleOAuthProvider,
      issuerUrl: new URL(PUBLIC_BASE_URL),
      resourceName: "Corp Travel Flight Recommender",
      scopesSupported: [],
    }),
  );
  mountGoogleOAuthCallback(app, GOOGLE_OAUTH_CALLBACK_PATH, googleOAuthProvider);
}

// Not named /healthz — that exact path gets intercepted by Google Cloud's
// own edge infrastructure before it reaches this container (observed
// directly on Cloud Run: /healthz 404s with none of our/Express's headers,
// while every other path, including typos of it, reaches the app fine).
app.get("/status", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  if (!(await checkAuth(req, res))) return;

  const server = getServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.delete("/mcp", async (req, res) => {
  if (!(await checkAuth(req, res))) return;
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.listen(PORT, HOST, () => {
  console.error(`google-flights-recommender remote MCP server listening on http://${HOST}:${PORT}/mcp`);
});
