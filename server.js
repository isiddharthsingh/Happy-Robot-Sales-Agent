// server.js
// Simple backend for the HappyRobot inbound carrier sales POC

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { fileURLToPath } from "url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- config ----------
const PORT = Number(process.env.PORT || 8080);
const FMCSA_WEBKEY = process.env.FMCSA_WEBKEY || "";
const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";

// API keys (comma separated)
const API_KEYS = (process.env.API_KEYS || process.env.API_KEY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

// ---------- file helpers ----------
const DATA_DIR = path.join(__dirname, "data");
const LOADS_FILE = path.join(DATA_DIR, "loads.json");
const CALLBACKS_FILE = path.join(DATA_DIR, "callbacks.json");

// Ensure data dir
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Seed loads file if missing
if (!fs.existsSync(LOADS_FILE)) {
  const seed = path.join(DATA_DIR, "loads.sample.json");
  if (!fs.existsSync(seed)) {
    fs.writeFileSync(
      seed,
      JSON.stringify(
        [
          {
            load_id: "L-1001",
            origin: "Dallas, TX",
            destination: "Atlanta, GA",
            pickup_datetime: "2025-08-22T09:00:00-05:00",
            delivery_datetime: "2025-08-23T17:00:00-04:00",
            equipment_type: "Dry Van",
            loadboard_rate: 2200,
            notes: "No pallets exchange",
            weight: "38000 lb",
            commodity_type: "Paper goods"
          }
        ],
        null,
        2
      )
    );
  }
  fs.copyFileSync(seed, LOADS_FILE);
}

// Create callbacks file if missing
if (!fs.existsSync(CALLBACKS_FILE)) {
  fs.writeFileSync(CALLBACKS_FILE, "[]");
}

function readLoads() {
  return JSON.parse(fs.readFileSync(LOADS_FILE, "utf8"));
}
function pushCallback(rec) {
  const arr = JSON.parse(fs.readFileSync(CALLBACKS_FILE, "utf8"));
  arr.push(rec);
  fs.writeFileSync(CALLBACKS_FILE, JSON.stringify(arr, null, 2));
  return arr.length;
}

// ---------- utils ----------
function onlyDigits(s = "") {
  return String(s || "").replace(/\D/g, "");
}
function toNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// Map full state names to two letter codes
const STATE_MAP = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY"
};

// Normalize places like "Dallas, Texas" -> "dallas tx"
function normalizePlace(s = "") {
  let x = String(s).toLowerCase().trim();
  x = x.replace(/[.,]/g, " ");
  x = x.replace(/\s+/g, " ");
  for (const [name, abbr] of Object.entries(STATE_MAP)) {
    x = x.replace(new RegExp(`\\b${name}\\b`, "g"), abbr.toLowerCase());
  }
  return x;
}
// Use the city token to help match "Dallas" vs "Dallas, TX"
function cityToken(s = "") {
  return String(s).split(",")[0].trim().toLowerCase();
}
function placeMatch(a = "", b = "") {
  if (!b) return true;
  const na = normalizePlace(a);
  const nb = normalizePlace(b);
  if (na === nb) return true;
  const ca = cityToken(a), cb = cityToken(b);
  return ca === cb || na.includes(cb) || nb.includes(ca);
}
function equipMatch(a = "", b = "") {
  if (!b) return true;
  const map = { "dry van": "dry van", van: "dry van", reefer: "reefer", refrigerated: "reefer", flatbed: "flatbed" };
  const na = map[String(a || "").toLowerCase()] || String(a || "").toLowerCase();
  const nb = map[String(b || "").toLowerCase()] || String(b || "").toLowerCase();
  return na === nb;
}

// ---------- API key auth middleware ----------
function extractApiKey(req) {
  const h = req.headers || {};
  if (h["x-api-key"]) return String(h["x-api-key"]);
  if (h.authorization && /^bearer\s+/i.test(h.authorization)) {
    return h.authorization.replace(/^bearer\s+/i, "").trim();
  }
  if (req.query?.api_key) return String(req.query.api_key);
  return "";
}
function safeEqual(a, b) {
  try {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
function requireApiKey(req, res, next) {
  const key = extractApiKey(req);
  if (!API_KEYS.length) {
    return res.status(500).json({ ok: false, error: "server not configured with API_KEYS" });
  }
  const ok = API_KEYS.some((k) => safeEqual(k, key));
  if (!ok) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// Apply auth to every route
app.use(requireApiKey);

// ---------- routes ----------

app.get("/health", (req, res) => {
  return res.json({ ok: true, status: "up", version: "1.4.0" });
});

/**
 * GET /carrier/eligibility?mc=123456
 * Accepts mc or mc_number. Calls FMCSA QCMobile.
 */
app.get("/carrier/eligibility", async (req, res) => {
  const mc = onlyDigits(
    req.query.mc || req.query.mc_number || req.body?.mc || req.body?.mc_number
  );
  if (!mc) return res.status(400).json({ ok: false, error: "mc required" });

  if (!FMCSA_WEBKEY) {
    return res.json({
      ok: true,
      eligible: true,
      mc_number: mc,
      usdot: null,
      carrier_name: null,
      authority: "unknown",
      oos: false,
      fallback: true
    });
  }

  try {
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/${mc}?webKey=${encodeURIComponent(FMCSA_WEBKEY)}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`FMCSA ${r.status}`);
    const data = await r.json();

    // QCMobile sample shape: { content: [ { carrier: {...} } ] }
    const content = Array.isArray(data?.content) ? data.content[0] : data?.content || data;
    const c = content?.carrier || content || {};

    const legalName = c.legalName || c.dbaName || null;
    const dotNumber = c.dotNumber || c.usdot || null;

    const statusCode = String(c.statusCode || "").toUpperCase();
    const authority =
      statusCode === "A" ? "active" :
      statusCode === "I" ? "inactive" :
      statusCode || null;

    const allowed = String(c.allowedToOperate || "").toUpperCase() === "Y";
    const oos =
      !!c.oosDate ||
      String(c.oosStatus || "").toUpperCase() === "Y" ||
      /out\s*of\s*service/i.test(String(c.safetyRating || ""));

    const eligible = allowed && authority === "active" && !oos;

    const resp = {
      ok: true,
      eligible,
      mc_number: mc,
      usdot: dotNumber ? String(dotNumber) : null,
      carrier_name: legalName,
      authority,
      oos
    };
    if (DEBUG) resp.raw = c;
    return res.json(resp);
  } catch (err) {
    console.error("FMCSA error:", err.message);
    return res.json({
      ok: true,
      eligible: true,
      mc_number: mc,
      usdot: null,
      carrier_name: null,
      authority: "unknown",
      oos: false,
      fallback: true,
      error: err.message
    });
  }
});

/**
 * POST /loads/search
 * Body: { origin, destination, pickup_datetime, equipment_type }
 * Fuzzy match cities and state names vs abbreviations.
 */
app.post("/loads/search", (req, res) => {
  const { origin, destination, pickup_datetime, equipment_type } = req.body || {};
  const loads = readLoads();

  const filtered = loads
    .filter(l =>
      placeMatch(l.origin, origin) &&
      placeMatch(l.destination, destination) &&
      equipMatch(l.equipment_type, equipment_type)
      // If you want to force same pickup date, uncomment:
      // && (!pickup_datetime || String(l.pickup_datetime).slice(0,10) === String(pickup_datetime).slice(0,10))
    )
    .sort((a, b) => toNumber(b.loadboard_rate) - toNumber(a.loadboard_rate))
    .slice(0, 3);

  return res.json({ ok: true, results: filtered });
});

/**
 * Normalize ASR price errors like "20100" when board is ~2200.
 * If board is in a typical range and offer/10 is close to board, snap to offer/10.
 */
function normalizeOffer(offer, board) {
  if (!Number.isFinite(offer) || !Number.isFinite(board)) return offer;
  if (board >= 800 && board <= 6000 && offer >= 10000) {
    const tenX = Math.round(offer / 10);
    const withinRange = Math.abs(tenX - board) <= board * 0.5; // within ±50% of board
    if (withinRange) return tenX;
  }
  return offer;
}

/**
 * POST /negotiate
 * Body: { load_id, carrier_offer_usd }
 */
app.post("/negotiate", (req, res) => {
  const { load_id, carrier_offer_usd } = req.body || {};
  if (!load_id) return res.status(400).json({ ok: false, error: "load_id required" });

  const loads = readLoads();
  const load = loads.find(l => l.load_id === load_id);
  if (!load) return res.status(404).json({ ok: false, error: "load not found" });

  const board = toNumber(load.loadboard_rate, 0);
  const rawOffer = toNumber(carrier_offer_usd, 0);
  const offer = normalizeOffer(rawOffer, board);

  const minAccept = Math.round(board * 0.95);
  const walkAway = Math.round(board * 0.88);
  let decision = "counter";
  let price = Math.max(minAccept, Math.round((board + offer) / 2));

  if (offer >= minAccept) {
    decision = "accept";
    price = offer;
  } else if (offer < walkAway) {
    decision = "reject";
    price = walkAway;
  }

  return res.json({ ok: true, decision, price, notes: { board, minAccept, walkAway, rawOffer } });
});

/**
 * POST /call/callback
 * Stores payload for metrics. Parses transcript if it is a string.
 */
app.post("/call/callback", (req, res) => {
  const payload = req.body || {};
  let transcript = payload.transcript;
  try { if (typeof transcript === "string") transcript = JSON.parse(transcript); } catch {}
  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    source: "happyrobot",
    ...payload,
    transcript
  };
  const count = pushCallback(record);
  return res.json({ ok: true, stored: true, count, id: record.id });
});

/**
 * POST /notify/rep
 * Demo logger
 */
app.post("/notify/rep", (req, res) => {
  const { room_name, summary, agreed_price } = req.body || {};
  console.log("[Notify Rep]", { room_name, agreed_price, summary });
  return res.json({ ok: true, sent: false, message: "Logged locally." });
});

/**
 * GET /metrics/local
 */
app.get("/metrics/local", (req, res) => {
  const arr = JSON.parse(fs.readFileSync(CALLBACKS_FILE, "utf8"));
  const totals = { calls: arr.length };

  const byOutcome = {};
  const bySentiment = {};
  for (const c of arr) {
    const outcome = c.outcome || c.classification?.tag || c.classification || "Unknown";
    const sentiment = c.sentiment || c.sentiment_class || "Unknown";
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
    bySentiment[sentiment] = (bySentiment[sentiment] || 0) + 1;
  }

  return res.json({
    ok: true,
    totals,
    byOutcome,
    bySentiment,
    last10: arr.slice(-10)
  });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Carrier Sales API on :${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});