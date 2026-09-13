'use strict';

/**
 * Phase 14 - Vehicle Wait-Time Prediction
 *
 * Baseline inputs:
 * - historical completed-trip intervals
 * - time of day
 * - active vehicles
 * - latest known GPS positions
 *
 * This is intentionally a transparent baseline model for a prototype.
 * OpenAI is NOT used to invent the numeric ETA; OpenAI only explains the
 * deterministic result in the controller layer.
 */

const DEFAULT_FREQUENCY_MINUTES = 15;
const MIN_GAP_MINUTES = 2;
const MAX_PLAUSIBLE_GAP_MINUTES = 60;
const GPS_FRESH_MINUTES = 10;

function circularHourDistance(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 24 - diff);
}

function timeOfDayFactor(hour) {
  if ((hour >= 6 && hour <= 9) || (hour >= 16 && hour <= 19)) return 0.9;
  if (hour >= 22 || hour <= 4) return 1.25;
  return 1;
}

function classifyAvailability(midpointMinutes, confidence, activeVehicles) {
  if (activeVehicles <= 0 || confidence < 0.3) return 'Low';
  if (midpointMinutes <= 10) return 'High';
  if (midpointMinutes <= 25) return 'Medium';
  return 'Low';
}

function buildHistoricalIntervals(trips, targetHour) {
  const byDate = new Map();

  for (const trip of trips) {
    if (!trip.started_at) continue;
    const date = new Date(trip.started_at);
    if (Number.isNaN(date.getTime())) continue;

    // Prefer history around the same time of day. With very little data,
    // the caller can fall back to all usable intervals.
    const item = { timestamp: date.getTime(), hour: date.getHours() };
    const key = date.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(item);
  }

  const all = [];
  const nearTargetHour = [];

  for (const dayTrips of byDate.values()) {
    dayTrips.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < dayTrips.length; i += 1) {
      const previous = dayTrips[i - 1];
      const current = dayTrips[i];
      const gap = (current.timestamp - previous.timestamp) / 60000;
      if (gap < MIN_GAP_MINUTES || gap > MAX_PLAUSIBLE_GAP_MINUTES) continue;

      all.push(gap);
      if (
        circularHourDistance(previous.hour, targetHour) <= 2 ||
        circularHourDistance(current.hour, targetHour) <= 2
      ) {
        nearTargetHour.push(gap);
      }
    }
  }

  return nearTargetHour.length >= 2 ? nearTargetHour : all;
}

async function getFreshGpsSummary(strapi, routeId) {
  const locations = await strapi.documents('api::vehicle-location.vehicle-location').findMany({
    filters: { trip: { route: { id: routeId }, trip_status: 'active' } },
    sort: ['recorded_at:desc'],
    fields: ['recorded_at'],
    populate: { vehicle: { fields: ['id'] } },
    limit: 100,
  });

  const latestByVehicle = new Map();
  for (const location of locations) {
    const vehicleId = location.vehicle?.id;
    if (!vehicleId || latestByVehicle.has(vehicleId) || !location.recorded_at) continue;
    latestByVehicle.set(vehicleId, new Date(location.recorded_at));
  }

  const now = Date.now();
  const freshVehicles = [...latestByVehicle.values()].filter((date) => {
    const ageMinutes = (now - date.getTime()) / 60000;
    return ageMinutes >= 0 && ageMinutes <= GPS_FRESH_MINUTES;
  }).length;

  const latest = [...latestByVehicle.values()].sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    vehicles_with_positions: latestByVehicle.size,
    fresh_position_vehicles: freshVehicles,
    latest_position_at: latest ? latest.toISOString() : null,
  };
}

async function predictWaitTime(strapi, { routeId, hour = new Date().getHours() }) {
  const numericHour = Number(hour);
  const safeHour = Number.isInteger(numericHour) && numericHour >= 0 && numericHour <= 23
    ? numericHour
    : new Date().getHours();

  const trips = await strapi.documents('api::trip.trip').findMany({
    filters: { route: { id: routeId }, trip_status: 'completed' },
    sort: ['started_at:asc'],
    fields: ['started_at'],
    limit: 300,
  });

  const intervals = buildHistoricalIntervals(trips, safeHour);
  const usingRealHistory = intervals.length > 0;
  const historicalAverage = usingRealHistory
    ? intervals.reduce((sum, gap) => sum + gap, 0) / intervals.length
    : DEFAULT_FREQUENCY_MINUTES;

  const activeTrips = await strapi.documents('api::trip.trip').findMany({
    filters: { route: { id: routeId }, trip_status: 'active' },
    fields: ['id'],
    limit: 100,
  });

  const activeVehicles = activeTrips.length;
  const gps = await getFreshGpsSummary(strapi, routeId);

  const activeVehicleFactor = activeVehicles >= 3 ? 0.7 : activeVehicles === 2 ? 0.82 : 1;
  const adjustedAverage = historicalAverage * timeOfDayFactor(safeHour) * activeVehicleFactor;

  const low = Math.max(1, Math.round(adjustedAverage * 0.75));
  const high = Math.max(low + 1, Math.round(adjustedAverage * 1.25));
  const midpoint = Math.round((low + high) / 2);

  let confidence = 0.2;
  confidence += Math.min(intervals.length, 8) * 0.055;
  if (activeVehicles > 0) confidence += 0.12;
  if (gps.fresh_position_vehicles > 0) confidence += 0.14;
  confidence = Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2))));

  return {
    route_id: routeId,
    target_hour: safeHour,
    predicted_wait_minutes: { low, high },
    predicted_wait_midpoint: midpoint,
    availability_class: classifyAvailability(midpoint, confidence, activeVehicles),
    confidence,
    active_vehicles: activeVehicles,
    historical_sample_count: intervals.length,
    latest_positions: gps,
    basis: usingRealHistory
      ? 'historical_trip_intervals + time_of_day + active_vehicles + latest_positions'
      : 'default_frequency + time_of_day + active_vehicles + latest_positions',
  };
}

module.exports = {
  predictWaitTime,
  DEFAULT_FREQUENCY_MINUTES,
  classifyAvailability,
  timeOfDayFactor,
  buildHistoricalIntervals,
};
