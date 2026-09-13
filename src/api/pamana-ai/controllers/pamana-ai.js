'use strict';

/**
 * PAMANA AI controller - Phases 14 to 16.
 */

const { predictWaitTime } = require('../../../services/pamana-ai/wait-time');
const {
  predictDemand,
  storeDemandPrediction,
} = require('../../../services/pamana-ai/demand');
const { analyzeSupplyDemand } = require('../../../services/pamana-ai/supply-demand');
const { generateTransportExplanation } = require('../../../services/pamana-ai/openai');

async function resolveRouteId(strapi, routeParam) {
  if (routeParam) {
    const route = await strapi.documents('api::route.route').findFirst({
      filters: { documentId: routeParam },
      fields: ['id'],
    });
    return route ? route.id : null;
  }

  const pilotRoute = await strapi.documents('api::route.route').findFirst({
    filters: { route_code: 'SL-SF-01', route_status: 'active' },
    fields: ['id'],
  });
  if (pilotRoute) return pilotRoute.id;

  const anyActiveRoute = await strapi.documents('api::route.route').findFirst({
    filters: { route_status: 'active' },
    sort: ['id:asc'],
    fields: ['id'],
  });
  return anyActiveRoute ? anyActiveRoute.id : null;
}

async function resolveStopId(strapi, stopParam) {
  if (!stopParam) return null;
  const stop = await strapi.documents('api::route-stop.route-stop').findFirst({
    filters: { documentId: stopParam },
    fields: ['id'],
  });
  return stop ? stop.id : null;
}

function parseHour(value) {
  if (value === undefined) return undefined;
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function predictionOptions(ctx, routeId, stopId = null) {
  return {
    routeId,
    stopId,
    hour: parseHour(ctx.query.hour),
    targetDate: ctx.query.target_date || undefined,
    weather: ctx.query.weather || 'normal',
    schoolDay: ctx.query.school_day,
    holiday: ctx.query.holiday,
    localEvent: ctx.query.local_event,
    traffic: ctx.query.traffic || 'normal',
  };
}

async function withOpenAI(kind, result) {
  const explanation = await generateTransportExplanation(kind, result);
  return {
    ...result,
    ai_explanation: explanation.text,
    ai_status: explanation.status,
    ai_model: explanation.model,
  };
}

module.exports = {
  async waitTime(ctx) {
    const routeId = await resolveRouteId(strapi, ctx.query.route);
    if (!routeId) return ctx.badRequest('"route" (documentId) is required and must exist.');

    const hour = parseHour(ctx.query.hour);
    if (ctx.query.hour !== undefined && hour === null) {
      return ctx.badRequest('"hour" must be an integer from 0 to 23.');
    }

    const result = await predictWaitTime(strapi, { routeId, hour });
    ctx.body = { data: await withOpenAI('wait_time', result) };
  },

  async demand(ctx) {
    const routeId = await resolveRouteId(strapi, ctx.query.route);
    if (!routeId) return ctx.badRequest('"route" (documentId) is required and must exist.');

    const stopId = await resolveStopId(strapi, ctx.query.stop);
    if (ctx.query.stop && !stopId) return ctx.badRequest('"stop" must be a valid documentId.');

    const hour = parseHour(ctx.query.hour);
    if (ctx.query.hour !== undefined && hour === null) {
      return ctx.badRequest('"hour" must be an integer from 0 to 23.');
    }

    const options = predictionOptions(ctx, routeId, stopId);
    const result = await predictDemand(strapi, options);

    let storedPredictionId = null;
    try {
      const stored = await storeDemandPrediction(strapi, result, {
        routeId,
        stopId,
        hour: options.hour,
      });
      storedPredictionId = stored?.id || null;
    } catch (error) {
      strapi.log.warn(`Phase 15 prediction storage failed: ${error.message}`);
    }

    const enriched = await withOpenAI('passenger_demand', {
      ...result,
      stored_prediction_id: storedPredictionId,
    });

    ctx.body = { data: enriched };
  },

  async supplyDemand(ctx) {
    const routeId = await resolveRouteId(strapi, ctx.query.route);
    if (!routeId) return ctx.badRequest('"route" (documentId) is required and must exist.');

    const stopId = await resolveStopId(strapi, ctx.query.stop);
    if (ctx.query.stop && !stopId) return ctx.badRequest('"stop" must be a valid documentId.');

    const hour = parseHour(ctx.query.hour);
    if (ctx.query.hour !== undefined && hour === null) {
      return ctx.badRequest('"hour" must be an integer from 0 to 23.');
    }

    const result = await analyzeSupplyDemand(strapi, predictionOptions(ctx, routeId, stopId));
    ctx.body = { data: await withOpenAI('supply_demand', result) };
  },

  // Existing dashboard route is kept for compatibility. It now uses the
  // upgraded Phase 14-16 services without changing the frontend contract.
  async dashboardSummary(ctx) {
    const routeId = await resolveRouteId(strapi, ctx.query.route);
    if (!routeId) return ctx.badRequest('"route" (documentId) is required and must exist.');

    const hour = parseHour(ctx.query.hour);
    if (ctx.query.hour !== undefined && hour === null) {
      return ctx.badRequest('"hour" must be an integer from 0 to 23.');
    }

    const stops = await strapi.documents('api::route-stop.route-stop').findMany({
      filters: { route: { id: routeId } },
      sort: ['sequence:asc'],
      fields: ['id', 'documentId', 'name', 'sequence'],
    });

    const waitTime = await predictWaitTime(strapi, { routeId, hour });
    const baseOptions = predictionOptions(ctx, routeId);

    const perStop = await Promise.all(
      stops.map(async (stop) => {
        const analysis = await analyzeSupplyDemand(strapi, {
          ...baseOptions,
          stopId: stop.id,
        });
        return {
          stop_id: stop.documentId,
          stop_name: stop.name,
          ...analysis,
        };
      })
    );

    const shortages = perStop.filter((stop) => stop.status === 'SHORTAGE');
    const recommendations = shortages.map((stop) => {
      const typicalVehicleCapacity = 20;
      const extraVehicles = Math.max(1, Math.ceil(stop.shortage / typicalVehicleCapacity));
      return {
        stop_name: stop.stop_name,
        message: `Predicted shortage at ${stop.stop_name} (${stop.expected_passengers} passengers vs ${stop.expected_capacity} available seats). Recommend checking or dispatching approximately ${extraVehicles} additional vehicle${extraVehicles > 1 ? 's' : ''}.`,
      };
    });

    ctx.body = {
      data: {
        route_id: routeId,
        wait_time: waitTime,
        stops: perStop,
        shortage_count: shortages.length,
        recommendations,
      },
    };
  },
};
