'use strict';

/**
 * Phase 16 - Supply and Demand Analysis
 *
 * Supply = expected seats from route-assigned vehicles that are currently
 * available or in transit. Current occupancy is subtracted from capacity.
 */

const { predictDemand } = require('./demand');

function classifySupplyDemand(expectedPassengers, expectedCapacity) {
  if (expectedPassengers === null || expectedPassengers === undefined) return 'UNKNOWN';
  if (expectedPassengers > expectedCapacity) return 'SHORTAGE';

  const tolerance = Math.max(2, Math.round(expectedCapacity * 0.1));
  if (Math.abs(expectedCapacity - expectedPassengers) <= tolerance) return 'MONITOR';
  return 'ADEQUATE';
}

function availableSeats(vehicle) {
  if (!['available', 'in_transit'].includes(vehicle.vehicle_status)) return 0;
  const capacity = Number(vehicle.capacity || 0);
  const occupancy = Number(vehicle.current_occupancy || 0);
  return Math.max(0, capacity - occupancy);
}

async function analyzeSupplyDemand(strapi, options) {
  const { routeId } = options;
  const demand = await predictDemand(strapi, options);

  const vehicles = await strapi.documents('api::vehicle.vehicle').findMany({
    filters: { route: { id: routeId } },
    fields: ['capacity', 'current_occupancy', 'vehicle_status'],
    limit: 200,
  });

  const serviceVehicles = vehicles.filter((vehicle) =>
    ['available', 'in_transit'].includes(vehicle.vehicle_status)
  );

  const expectedCapacity = serviceVehicles.reduce(
    (sum, vehicle) => sum + availableSeats(vehicle),
    0
  );

  if (demand.expected_passengers === null) {
    return {
      ...demand,
      expected_capacity: expectedCapacity,
      vehicle_count: serviceVehicles.length,
      shortage: null,
      status: 'UNKNOWN',
    };
  }

  const shortage = Math.max(0, demand.expected_passengers - expectedCapacity);

  return {
    ...demand,
    expected_capacity: expectedCapacity,
    vehicle_count: serviceVehicles.length,
    shortage,
    status: classifySupplyDemand(demand.expected_passengers, expectedCapacity),
  };
}

module.exports = {
  analyzeSupplyDemand,
  classifySupplyDemand,
  availableSeats,
};
