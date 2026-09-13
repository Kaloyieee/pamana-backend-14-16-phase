'use strict';

/**
 * Phase 15 - Passenger Demand Prediction
 *
 * Baseline inputs:
 * - route / stop
 * - time and day
 * - historical passenger-demand observations
 * - crowdsourced observations
 *
 * Optional Phase 15.2 context:
 * - weather
 * - school day
 * - holiday
 * - local event
 * - traffic
 *
 * The model is intentionally explainable and deterministic. OpenAI only
 * produces a human-readable explanation of the result in the controller.
 */

const { timeSlotForHour } = require('./time-slots');

const DEMAND_LOOKBACK_DAYS = 60;
const MODEL_VERSION = 'phase15-baseline-v1';

const SOURCE_WEIGHT = {
  observed: 1,
  crowdsourced: 0.85,
  simulation: 0.65,
};

function classifyDemand(value) {
  if (value >= 45) return 'CRITICAL';
  if (value >= 30) return 'HIGH';
  if (value >= 15) return 'MODERATE';
  return 'LOW';
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return null;
}

function featureMultiplier({ weather, schoolDay, holiday, localEvent, traffic, hour }) {
  let multiplier = 1;
  const applied = [];

  const normalizedWeather = String(weather || 'normal').toLowerCase();
  if (normalizedWeather === 'rain') {
    multiplier *= 1.08;
    applied.push({ feature: 'weather', value: 'rain', multiplier: 1.08 });
  } else if (['heavy_rain', 'storm'].includes(normalizedWeather)) {
    multiplier *= 1.15;
    applied.push({ feature: 'weather', value: normalizedWeather, multiplier: 1.15 });
  }

  if (schoolDay === true && ((hour >= 6 && hour <= 9) || (hour >= 15 && hour <= 18))) {
    multiplier *= 1.08;
    applied.push({ feature: 'school_day', value: true, multiplier: 1.08 });
  }

  if (holiday === true) {
    multiplier *= 0.88;
    applied.push({ feature: 'holiday', value: true, multiplier: 0.88 });
  }

  if (localEvent === true) {
    multiplier *= 1.15;
    applied.push({ feature: 'local_event', value: true, multiplier: 1.15 });
  }

  const normalizedTraffic = String(traffic || 'normal').toLowerCase();
  if (normalizedTraffic === 'heavy') {
    multiplier *= 1.05;
    applied.push({ feature: 'traffic', value: 'heavy', multiplier: 1.05 });
  }

  return { multiplier, applied };
}

function demandConfidence(observations) {
  if (!observations.length) return 0;

  const sourceScore = observations.reduce(
    (sum, observation) => sum + (SOURCE_WEIGHT[observation.source] || 0.5),
    0
  ) / observations.length;

  const sampleScore = Math.min(1, observations.length / 12);
  return Number(Math.min(0.95, 0.15 + sampleScore * 0.5 + sourceScore * 0.3).toFixed(2));
}

async function predictDemand(
  strapi,
  {
    routeId,
    stopId = null,
    hour = new Date().getHours(),
    targetDate = new Date().toISOString().slice(0, 10),
    weather = 'normal',
    schoolDay = null,
    holiday = null,
    localEvent = null,
    traffic = 'normal',
  }
) {
  const numericHour = Number(hour);
  const safeHour = Number.isInteger(numericHour) && numericHour >= 0 && numericHour <= 23
    ? numericHour
    : new Date().getHours();

  const timeSlot = timeSlotForHour(safeHour);
  const since = new Date(Date.now() - DEMAND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const filters = {
    route: { id: routeId },
    time_slot: timeSlot,
    date: { $gte: since },
  };
  if (stopId) filters.stop = { id: stopId };

  const observations = await strapi
    .documents('api::passenger-demand-observation.passenger-demand-observation')
    .findMany({
      filters,
      fields: ['waiting_passengers', 'source', 'date'],
      limit: 500,
    });

  const sources = { observed: 0, crowdsourced: 0, simulation: 0 };
  for (const observation of observations) {
    if (Object.prototype.hasOwnProperty.call(sources, observation.source)) {
      sources[observation.source] += 1;
    }
  }

  if (observations.length === 0) {
    return {
      route_id: routeId,
      stop_id: stopId,
      target_date: targetDate,
      time_slot: timeSlot,
      expected_passengers: null,
      demand_class: null,
      confidence: 0,
      sample_count: 0,
      sources,
      model_version: MODEL_VERSION,
      note: 'No demand observations for this route/stop/time slot yet.',
    };
  }

  const targetWeekday = new Date(`${targetDate}T00:00:00Z`).getUTCDay();
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const observation of observations) {
    const sourceWeight = SOURCE_WEIGHT[observation.source] || 0.5;
    const observationWeekday = new Date(`${observation.date}T00:00:00Z`).getUTCDay();
    const dayWeight = observationWeekday === targetWeekday ? 1.2 : 1;
    const weight = sourceWeight * dayWeight;

    weightedTotal += Number(observation.waiting_passengers || 0) * weight;
    totalWeight += weight;
  }

  const baseline = totalWeight > 0 ? weightedTotal / totalWeight : 0;
  const context = featureMultiplier({
    weather,
    schoolDay: parseBoolean(schoolDay),
    holiday: parseBoolean(holiday),
    localEvent: parseBoolean(localEvent),
    traffic,
    hour: safeHour,
  });

  const expected = Math.max(0, Math.round(baseline * context.multiplier));

  return {
    route_id: routeId,
    stop_id: stopId,
    target_date: targetDate,
    time_slot: timeSlot,
    expected_passengers: expected,
    baseline_passengers: Math.round(baseline),
    demand_class: classifyDemand(expected),
    confidence: demandConfidence(observations),
    sample_count: observations.length,
    sources,
    context_adjustments: context.applied,
    model_version: MODEL_VERSION,
  };
}

async function storeDemandPrediction(strapi, result, { routeId, stopId = null, hour }) {
  if (result.expected_passengers === null) return null;

  const targetHour = Number.isInteger(Number(hour)) ? Number(hour) : new Date().getHours();
  const targetTime = new Date(
    `${result.target_date}T${String(targetHour).padStart(2, '0')}:00:00+08:00`
  ).toISOString();

  return strapi.db.query('api::prediction.prediction').create({
    data: {
      prediction_type: 'demand',
      predicted_value: result.expected_passengers,
      confidence: result.confidence,
      prediction_time: new Date().toISOString(),
      target_time: targetTime,
      model_version: result.model_version,
      route: routeId,
      ...(stopId ? { stop: stopId } : {}),
    },
  });
}

module.exports = {
  predictDemand,
  storeDemandPrediction,
  classify: classifyDemand,
  classifyDemand,
  featureMultiplier,
  demandConfidence,
  MODEL_VERSION,
};
