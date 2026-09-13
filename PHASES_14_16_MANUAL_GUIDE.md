# PAMANA — Manual Integration Guide for Phases 14–16 + OpenAI

This package keeps the existing PAMANA Strapi backend intact and only upgrades the Phase 14–16 AI area.

## What was changed

Only these Phase 14–16 files were added or updated:

- `src/services/pamana-ai/wait-time.js` — Phase 14 wait-time baseline
- `src/services/pamana-ai/demand.js` — Phase 15 demand baseline + prediction storage
- `src/services/pamana-ai/supply-demand.js` — Phase 16 capacity/shortage analysis
- `src/services/pamana-ai/openai.js` — OpenAI explanation helper
- `src/api/pamana-ai/controllers/pamana-ai.js` — connects the three phases to the existing endpoints
- `.env.example` — adds OpenAI variables
- `tests/pamana-ai.test.js` — validation test cases
- `package.json` — adds only the `test:pamana-ai` script

No frontend, authentication, roles, maps, unrelated content types, or database configuration were changed.

---

# 1. OpenAI setup

Open your local `.env` file and add:

```env
OPENAI_API_KEY=YOUR_REAL_OPENAI_API_KEY
OPENAI_MODEL=gpt-5.6-luna
OPENAI_EXPLANATIONS=true
OPENAI_TIMEOUT_MS=8000
```

Do not put the real key in `.env.example` and do not commit `.env` to GitHub.

The numeric wait-time, demand, and shortage calculations do not depend on OpenAI. The OpenAI API is used only to turn the computed result into a short human-readable explanation. This prevents the model from inventing transport numbers.

---

# 2. Phase 14 — Vehicle Wait-Time Prediction

Endpoint:

```text
GET /api/pamana-ai/wait-time
```

Optional query parameters:

```text
route=<route documentId>
hour=7
```

If `route` is omitted, the prototype first looks for the pilot route code `SL-SF-01`.

The baseline uses:

1. Historical completed-trip intervals.
2. The requested/current hour.
3. Number of active trips/vehicles.
4. Fresh GPS positions recorded in the last 10 minutes.
5. A 15-minute fallback frequency if there is not enough trip history.

Example output shape:

```json
{
  "data": {
    "predicted_wait_minutes": { "low": 7, "high": 11 },
    "availability_class": "Medium",
    "confidence": 0.63,
    "active_vehicles": 1,
    "latest_positions": {
      "fresh_position_vehicles": 1
    },
    "ai_explanation": "..."
  }
}
```

Availability rules:

- `High`: predicted midpoint 0–10 minutes, with usable confidence and an active vehicle.
- `Medium`: predicted midpoint 11–25 minutes.
- `Low`: long wait, no active vehicle, or low confidence.

---

# 3. Phase 15 — Passenger Demand Prediction

Endpoint:

```text
GET /api/pamana-ai/demand
```

Useful query parameters:

```text
route=<route documentId>
stop=<route-stop documentId>
hour=7
target_date=2026-09-14
weather=rain
school_day=true
holiday=false
local_event=false
traffic=normal
```

Only `route`/pilot route data is necessary. The extra context parameters are optional.

The baseline model uses:

1. Route and stop.
2. Hour/time slot.
3. Day of week.
4. Historical passenger-demand observations.
5. Crowdsourced observations.
6. Optional weather/school/holiday/event/traffic context.

Source weighting is intentionally transparent:

- observed = strongest weight
- crowdsourced = slightly lower weight
- simulation = lowest weight

Demand classes:

- `LOW`: 0–14
- `MODERATE`: 15–29
- `HIGH`: 30–44
- `CRITICAL`: 45+

Every successful demand prediction with data is also stored in the existing `Prediction` content type with:

- `prediction_type = demand`
- predicted passenger value
- confidence
- prediction time
- target time
- model version
- route and optional stop

If there are no observations for the requested route/stop/time slot, the endpoint returns `expected_passengers: null` instead of pretending it has enough data.

---

# 4. Phase 16 — Supply and Demand Analysis

Endpoint:

```text
GET /api/pamana-ai/supply-demand
```

It accepts the same demand context parameters as Phase 15.

Supply calculation:

```text
available seats = vehicle capacity - current occupancy
```

Only vehicles assigned to the route with status `available` or `in_transit` are counted as usable supply.

Shortage calculation:

```text
shortage = max(0, expected passengers - expected available seats)
```

Status rules:

- `ADEQUATE`: supply is comfortably higher than demand.
- `MONITOR`: demand is approximately equal to supply (within about 10%).
- `SHORTAGE`: demand is greater than supply.
- `UNKNOWN`: there is not enough demand data.

---

# 5. Validate the code

From the backend folder run:

```bash
npm run test:pamana-ai
```

You should see six passing tests covering:

- Phase 14 availability classification
- Phase 14 time-of-day adjustment
- Phase 15 demand classification
- Phase 15 optional feature adjustment
- Phase 16 available-seat calculation
- Phase 16 shortage status

Then start Strapi:

```bash
npm run develop
```

---

# 6. Important: your current SQLite database is empty

The uploaded `.tmp/data.db` currently has no routes, trips, vehicles, vehicle locations, demand observations, or predictions. The endpoints therefore cannot demonstrate meaningful predictions until you add pilot data.

Because your existing seed scripts are PostgreSQL-specific, do not run those scripts against SQLite as-is.

For the safest prototype setup, add the pilot records through Strapi Admin while using SQLite:

1. Create the route `SL-SF-01`.
2. Create its route stops.
3. Create at least one vehicle assigned to the route with capacity and occupancy.
4. Create trips for the route; mark historical examples `completed` and one demo trip `active`.
5. Add vehicle-location records for the active trip if you want live-position confidence.
6. Add passenger-demand-observation records for the route/stop/time slots you want to demonstrate.

For Phase 15, use `source = simulation` for demo-only generated observations, so your prototype remains honest about synthetic data.

---

# 7. Suggested Postman checks

Phase 14:

```text
GET http://localhost:1337/api/pamana-ai/wait-time?hour=7
```

Phase 15:

```text
GET http://localhost:1337/api/pamana-ai/demand?hour=7&weather=normal&school_day=true
```

Phase 16:

```text
GET http://localhost:1337/api/pamana-ai/supply-demand?hour=7&weather=normal&school_day=true
```

If the route is not found, first create the pilot route with route code `SL-SF-01`, or pass a valid route `documentId` using `?route=...`.

If `ai_status` is `not_configured`, check that `OPENAI_API_KEY` exists in `.env` and restart Strapi.

---

# 8. Why OpenAI is used this way

For a transportation prototype, the safest design is:

- deterministic code calculates waits, passenger demand, capacity, and shortages;
- OpenAI explains the calculated result in natural language;
- the endpoint still works when OpenAI is unavailable;
- confidence and source information remain visible.

That gives your prototype a real OpenAI integration without allowing an LLM to fabricate operational transport data.
