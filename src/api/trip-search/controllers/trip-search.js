'use strict';

/**
 * trip-search controller
 *
 * Matches a passenger's origin/destination search against active routes and
 * returns three genuinely distinct comparison options - cheapest, fastest,
 * and most reliable - with one of the three additionally flagged as the
 * overall recommendation. Phase 17 (Dynamic Route Recommendation Engine):
 * scores candidates on fare, total journey time, predicted wait, transfers,
 * and reliability (src/services/pamana-ai/wait-time) - a formula, not a
 * trained model, per the guide's own baseline scope.
 *
 * A "trip option" is a (route, direction, vehicle) combination, not just a
 * Route record - the same corridor can have several vehicles, or an
 * alternate routing (a transfer route), each a distinct real candidate. This
 * is what lets the three categories actually differ instead of all landing
 * on the same single candidate.
 */

const { predictWaitTime } = require('../../../services/pamana-ai/wait-time');

// Assumed overhead (wait + walk between legs) added to total journey time
// for every transfer in a candidate's route - not real headway data, a
// simulated placeholder like the rest of this pilot's predictions.
const TRANSFER_TIME_PENALTY_MINUTES = 12;

// Reliability points deducted per transfer: an extra leg is an extra point
// of failure (missed connection, tricycle availability), so a transfer
// route is modeled as inherently less reliable than a direct one.
const TRANSFER_RELIABILITY_PENALTY = 15;

const VEHICLE_STATUS_RELIABILITY = {
  available: 25,
  in_transit: 15,
  full: 0,
  offline: 0,
};

const OCCUPANCY_RELIABILITY = {
  empty: 15,
  low: 12,
  moderate: 8,
  near_full: 4,
  full: 0,
};

// Bidirectional, case-insensitive substring match done in memory rather
// than via $containsi: a location picker can send a more specific string
// than what's stored (e.g. "San Luis, Pampanga" vs. the stored "San
// Luis") - $containsi only ever checks one direction, so a more specific
// search string could never match. Fine at this pilot's route count.
const matches = (storedValue, searchValue) => {
  const stored = String(storedValue).toLowerCase().trim();
  const search = String(searchValue).toLowerCase().trim();
  return stored.includes(search) || search.includes(stored);
};

const normalize = (values) => {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));

  if (nums.length === 0) {
    return () => null;
  }

  const min = Math.min(...nums);
  const max = Math.max(...nums);

  if (min === max) {
    return (v) => (typeof v === 'number' ? 0 : null);
  }

  return (v) => (typeof v === 'number' ? (v - min) / (max - min) : null);
};

// Drops the ", Pampanga" suffix and "City of " prefix the seeded route data
// uses for full place names, so a service name reads "San Luis - San
// Fernando Jeepney" instead of "San Luis, Pampanga - City of San Fernando,
// Pampanga Jeepney".
const shortenPlaceName = (name) =>
  String(name)
    .replace(/^City of\s+/i, '')
    .replace(/,\s*Pampanga\s*$/i, '')
    .trim();

const buildServiceName = (originLabel, destinationLabel, transferStopName) => {
  const from = shortenPlaceName(originLabel);
  const to = shortenPlaceName(destinationLabel);

  if (transferStopName) {
    return `${from} - ${to} Jeepney (via ${transferStopName})`;
  }

  return `${from} - ${to} Jeepney`;
};

const reliabilityScoreFor = (waitConfidence, vehicle, transferCount) => {
  let score = waitConfidence * 60;

  if (vehicle) {
    score += VEHICLE_STATUS_RELIABILITY[vehicle.vehicle_status] ?? 0;
    score += OCCUPANCY_RELIABILITY[vehicle.occupancy_level] ?? 8;
  } else {
    score += 8; // no specific vehicle assigned yet - modest default, not zero
  }

  score -= transferCount * TRANSFER_RELIABILITY_PENALTY;

  return Math.max(0, Math.min(100, Math.round(score)));
};

const formatStop = (stop) =>
  stop
    ? {
        id: stop.id,
        documentId: stop.documentId,
        name: stop.name,
        sequence: stop.sequence,
        latitude: stop.latitude,
        longitude: stop.longitude,
        stop_type: stop.stop_type ?? null,
      }
    : null;

const formatVehicle = (vehicle) =>
  vehicle
    ? {
        id: vehicle.id,
        documentId: vehicle.documentId,
        vehicle_number: vehicle.vehicle_number,
        plate_number: vehicle.plate_number ?? null,
        vehicle_type: vehicle.vehicle_type,
        vehicle_status: vehicle.vehicle_status,
        occupancy_level: vehicle.occupancy_level ?? null,
      }
    : null;

// Detects a transfer leg from the stop name the demo data uses ("...Transfer
// Point") rather than a dedicated schema field - route/route-stop have no
// "transfer" concept, and adding one is out of scope for this fix. See
// scripts/seed-trip-planner-demo.js.
const findTransferStop = (stops) => stops.find((stop) => /transfer/i.test(stop.name)) ?? null;

async function buildCandidates(strapi, routes, searchOrigin, searchDestination) {
  const waitTimeCache = new Map();
  const candidates = [];

  for (const route of routes) {
    const isReverse = matches(route.destination, searchOrigin) && matches(route.origin, searchDestination);
    const direction = isReverse ? 'inbound' : 'outbound';
    const displayOrigin = isReverse ? route.destination : route.origin;
    const displayDestination = isReverse ? route.origin : route.destination;

    let sortedStops = (route.route_stops || []).slice().sort((a, b) => a.sequence - b.sequence);
    if (isReverse) sortedStops = sortedStops.slice().reverse();

    const transferStop = findTransferStop(sortedStops);
    const transferCount = transferStop ? 1 : 0;

    if (!waitTimeCache.has(route.id)) {
      waitTimeCache.set(route.id, await predictWaitTime(strapi, { routeId: route.id }));
    }
    const waitTime = waitTimeCache.get(route.id);

    const eligibleVehicles = (route.vehicles || []).filter((v) => v.vehicle_status !== 'offline');
    const vehicleCandidates = eligibleVehicles.length > 0 ? eligibleVehicles : [null];

    for (const vehicle of vehicleCandidates) {
      const fare = route.base_fare != null ? Number(route.base_fare) : null;
      const estimatedTravelMinutes = route.estimated_travel_time ?? null;
      const reliability_score = reliabilityScoreFor(waitTime.confidence, vehicle, transferCount);
      const totalJourneyMinutes =
        (waitTime.predicted_wait_minutes?.high ?? 0) +
        (estimatedTravelMinutes ?? 0) +
        transferCount * TRANSFER_TIME_PENALTY_MINUTES;

      candidates.push({
        id: `${route.documentId}:${direction}:${vehicle ? vehicle.documentId : 'unassigned'}`,
        route,
        direction,
        origin: displayOrigin,
        destination: displayDestination,
        service_name: buildServiceName(
          displayOrigin,
          displayDestination,
          transferStop ? transferStop.name.replace(/\s*Transfer Point$/i, '') : null
        ),
        vehicle,
        pickup_stop: sortedStops[0] ?? null,
        dropoff_stop: sortedStops[sortedStops.length - 1] ?? null,
        stops: sortedStops,
        fare,
        estimated_travel_minutes: estimatedTravelMinutes,
        predicted_wait_minutes: waitTime.predicted_wait_minutes,
        confidence: waitTime.confidence,
        data_source: waitTime.basis === 'historical_trip_intervals' ? 'observed' : 'simulation',
        transfer_count: transferCount,
        reliability_score,
        total_journey_minutes: totalJourneyMinutes,
      });
    }
  }

  return candidates;
}

// Picks the best candidate by compareFn, preferring ones not already used
// for another category so the three cards describe different real options
// whenever the data supports it - only collapsing onto a repeat pick when
// there truly isn't another candidate left (e.g. a single-vehicle route).
const pickBest = (candidates, compareFn, exclude = new Set()) => {
  const pool = candidates.filter((c) => !exclude.has(c.id));
  const searchSpace = pool.length > 0 ? pool : candidates;

  return searchSpace.reduce((best, candidate) => (!best || compareFn(candidate, best) < 0 ? candidate : best), null);
};

const byId = (a, b) => a.id.localeCompare(b.id);

const reasonFor = (option, isRecommended) => {
  const parts = [];

  if (option.category === 'cheapest') {
    parts.push(`Lowest fare on this corridor at ₱${option.fare}.`);
  } else if (option.category === 'fastest') {
    parts.push(
      `Fastest total journey at about ${option.total_journey_minutes} min, including predicted wait${
        option.transfer_count ? ' and transfer time' : ''
      }.`
    );
  } else if (option.category === 'most_reliable') {
    parts.push(
      `Most reliable pick based on vehicle availability and ${Math.round(option.confidence * 100)}% prediction confidence${
        option.transfer_count ? '' : ', with no transfers'
      }.`
    );
  }

  if (isRecommended) {
    parts.push('Recommended overall for the best balance of fare, travel time, wait, transfers, and reliability.');
  }

  return parts.join(' ');
};

module.exports = {
  async search(ctx) {
    const { origin, destination } = ctx.query;

    if (!origin || !destination) {
      return ctx.badRequest('Both "origin" and "destination" query parameters are required.');
    }

    const allActiveRoutes = await strapi.documents('api::route.route').findMany({
      filters: { route_status: 'active' },
      populate: {
        route_stops: true,
        vehicles: true,
      },
    });

    const matchedRoutes = allActiveRoutes.filter(
      (route) =>
        (matches(route.origin, origin) && matches(route.destination, destination)) ||
        (matches(route.origin, destination) && matches(route.destination, origin))
    );

    const candidates = await buildCandidates(strapi, matchedRoutes, origin, destination);

    if (candidates.length === 0) {
      ctx.body = {
        data: {
          origin,
          destination,
          options: [],
          recommended_option_id: null,
        },
      };
      return;
    }

    const cheapest = pickBest(
      candidates,
      (a, b) => (a.fare ?? Infinity) - (b.fare ?? Infinity) || a.total_journey_minutes - b.total_journey_minutes || byId(a, b)
    );

    const fastest = pickBest(
      candidates,
      (a, b) => a.total_journey_minutes - b.total_journey_minutes || (a.fare ?? Infinity) - (b.fare ?? Infinity) || byId(a, b),
      new Set([cheapest.id])
    );

    const mostReliable = pickBest(
      candidates,
      (a, b) => b.reliability_score - a.reliability_score || a.total_journey_minutes - b.total_journey_minutes || byId(a, b),
      new Set([cheapest.id, fastest.id])
    );

    const finalists = [
      { ...cheapest, category: 'cheapest' },
      { ...fastest, category: 'fastest' },
      { ...mostReliable, category: 'most_reliable' },
    ];

    // Recommended is computed only among the three finalists (never a
    // fourth option) using the existing weighted-normalization approach,
    // extended to also weigh reliability and transfers alongside fare,
    // travel time, and predicted wait.
    const normalizeFare = normalize(finalists.map((f) => f.fare));
    const normalizeTime = normalize(finalists.map((f) => f.total_journey_minutes));
    const normalizeWait = normalize(finalists.map((f) => f.predicted_wait_minutes?.high ?? null));
    const normalizeReliability = normalize(finalists.map((f) => 100 - f.reliability_score));
    const normalizeTransfers = normalize(finalists.map((f) => f.transfer_count));

    const scored = finalists.map((option) => {
      const parts = [
        normalizeFare(option.fare),
        normalizeTime(option.total_journey_minutes),
        normalizeWait(option.predicted_wait_minutes?.high ?? null),
        normalizeReliability(100 - option.reliability_score),
        normalizeTransfers(option.transfer_count),
      ].filter((value) => typeof value === 'number');

      const recommended_score = parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) / parts.length : null;

      return { ...option, recommended_score };
    });

    const recommended = scored.reduce(
      (best, option) =>
        !best || (option.recommended_score ?? Infinity) < (best.recommended_score ?? Infinity) ? option : best,
      null
    );

    const options = scored.map((option) => {
      const isRecommended = option.id === recommended.id;

      return {
        id: option.id,
        category: option.category,
        route_code: option.route.route_code,
        route_name: option.route.route_name,
        direction: option.direction,
        origin: option.origin,
        destination: option.destination,
        service_name: option.service_name,
        vehicle: formatVehicle(option.vehicle),
        pickup_stop: formatStop(option.pickup_stop),
        dropoff_stop: formatStop(option.dropoff_stop),
        fare: option.fare,
        estimated_travel_minutes: option.estimated_travel_minutes,
        predicted_wait_minutes: option.predicted_wait_minutes,
        reliability_score: option.reliability_score,
        confidence: option.confidence,
        transfer_count: option.transfer_count,
        total_journey_minutes: option.total_journey_minutes,
        stops: option.stops.map(formatStop),
        is_recommended: isRecommended,
        reason: reasonFor(option, isRecommended),
        data_source: option.data_source,
      };
    });

    ctx.body = {
      data: {
        origin,
        destination,
        options,
        recommended_option_id: recommended.id,
      },
    };
  },
};
