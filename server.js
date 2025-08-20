// Simple backend for the HappyRobot inbound carrier sales POC

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- config ----------
const PORT = Number(process.env.PORT || 8080);
const FMCSA_WEBKEY = process.env.FMCSA_WEBKEY || "";
const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";

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
function containsIgnoreCase(hay, needle) {
  if (!needle) return true;
  if (!hay) return false;
  return hay.toLowerCase().includes(String(needle).toLowerCase());
}
function toNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- routes ----------

app.get("/health", (req, res) => {
  return res.json({ ok: true, status: "up", version: "1.1.0" });
});

/**
 * GET /carrier/eligibility?mc=123456
 * Looks up FMCSA QCMobile by docket (MC). If FMCSA is unreachable or missing,
 * returns a safe fallback so the demo can proceed.
 */
app.get("/carrier/eligibility", async (req, res) => {
  const mc = onlyDigits(req.query.mc);
  if (!mc) return res.status(400).json({ ok: false, error: "mc required" });

  // No webKey -> soft pass for demo
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
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/${mc}?webKey=${encodeURIComponent(
      FMCSA_WEBKEY
    )}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`FMCSA ${r.status}`);
    const data = await r.json();

    // Your sample shows: { content: [ { carrier: { ... } } ] }
    const content = Array.isArray(data?.content)
      ? data.content[0]
      : data?.content || data;

    const c = content?.carrier || content || {};

    const legalName = c.legalName || c.dbaName || null;
    const dotNumber = c.dotNumber || c.usdot || null;

    // Map authority. StatusCode "A" = active, "I" = inactive.
    const statusCode = String(c.statusCode || "").toUpperCase();
    const authority =
      statusCode === "A"
        ? "active"
        : statusCode === "I"
        ? "inactive"
        : statusCode || null;

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
 * Returns top 3 by board rate.
 */
app.post("/loads/search", (req, res) => {
  const { origin, destination, pickup_datetime, equipment_type } = req.body || {};
  const loads = readLoads();

  const filtered = loads
    .filter(
      (l) =>
        containsIgnoreCase(l.origin, origin) &&
        containsIgnoreCase(l.destination, destination) &&
        (!equipment_type ||
          String(l.equipment_type).toLowerCase() ===
            String(equipment_type).toLowerCase())
    )
    .sort((a, b) => toNumber(b.loadboard_rate) - toNumber(a.loadboard_rate))
    .slice(0, 3);

  return res.json({ ok: true, results: filtered });
});

/**
 * POST /negotiate
 * Body: { load_id, carrier_offer_usd }
 * Returns { decision, price, notes }
 */
app.post("/negotiate", (req, res) => {
  const { load_id, carrier_offer_usd } = req.body || {};
  if (!load_id) return res.status(400).json({ ok: false, error: "load_id required" });

  const loads = readLoads();
  const load = loads.find((l) => l.load_id === load_id);
  if (!load) return res.status(404).json({ ok: false, error: "load not found" });

  const board = toNumber(load.loadboard_rate, 0);
  const offer = toNumber(carrier_offer_usd, 0);

  // Simple pricing rules
  const minAccept = Math.round(board * 0.95);  // accept if >= 95% of board
  const walkAway = Math.round(board * 0.88);   // reject below this
  let decision = "counter";
  let price = Math.max(minAccept, Math.round((board + offer) / 2));

  if (offer >= minAccept) {
    decision = "accept";
    price = offer;
  } else if (offer < walkAway) {
    decision = "reject";
    price = walkAway;
  }

  return res.json({
    ok: true,
    decision,
    price,
    notes: { board, minAccept, walkAway }
  });
});

/**
 * POST /call/callback
 * Body: full payload from your workflow
 * Stores payload for metrics
 */
app.post("/call/callback", (req, res) => {
  const payload = req.body || {};
  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    source: "happyrobot",
    ...payload
  };
  const count = pushCallback(record);
  return res.json({ ok: true, stored: true, count, id: record.id });
});

/**
 * POST /notify/rep
 * Body: { room_name, summary, agreed_price }
 * No Slack. Just logs for demo.
 */
app.post("/notify/rep", (req, res) => {
  const { room_name, summary, agreed_price } = req.body || {};
  console.log("[Notify Rep]", { room_name, agreed_price, summary });
  return res.json({ ok: true, sent: false, message: "Logged locally." });
});

/**
 * GET /metrics/local
 * Simple stats from stored callbacks
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