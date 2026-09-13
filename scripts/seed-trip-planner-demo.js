'use strict';

/**
 * Trip Planner demo data - Passenger Trip Planner fix.
 *
 * The San Luis <-> City of San Fernando pilot corridor previously had exactly
 * one Route record and zero Vehicle records, so /api/trip-search could only
 * ever return a single candidate - which is why "cheapest", "fastest", and
 * "most reliable" all collapsed onto the same card. This seeds enough real
 * Strapi records for the trip-search controller to build genuinely distinct
 * comparison options:
 *
 *   - 3 demo jeepneys (SL-SF-JEEP-01/02/03) assigned to the existing direct
 *     route (SL-SF-01), with deliberately different vehicle_status/
 *     occupancy_level so reliability differs between them.
 *   - A second route (SL-SF-02) modeling the same corridor via a Santo Tomas
 *     transfer (San Luis -> Santo Tomas Transfer Point -> San Fernando),
 *     with its own fare/travel time and one demo vehicle. trip-search
 *     detects this as a transfer leg by the "Transfer Point" stop name (see
 *     src/api/trip-search/controllers/trip-search.js) rather than a
 *     dedicated schema field.
 *
 * All fare/time/vehicle values here are simulated pilot placeholders, not
 * real operator data - plate numbers use an obviously-demo "DEMO-" prefix.
 * Vehicles have no direction field (a physical jeepney serves both outbound
 * and inbound trips), so the same 3 direct-route vehicles cover both
 * San Luis -> San Fernando and San Fernando -> San Luis searches; no
 * separate return-direction vehicle records are needed.
 *
 * Safe to re-run: routes are matched by route_code, vehicles by
 * vehicle_number, stops by (route, name) - existing rows are left alone.
 *
 * Usage: node --env-file=.env scripts/seed-trip-planner-demo.js
 */

const crypto = require('crypto');
const { Client } = require('pg');

const DIRECT_ROUTE_CODE = 'SL-SF-01';

const TRANSFER_ROUTE = {
  route_name: 'San Luis - City of San Fernando (via Santo Tomas Transfer)',
  route_code: 'SL-SF-02',
  origin: 'San Luis, Pampanga',
  destination: 'City of San Fernando, Pampanga',
  base_fare: 35,
  estimated_travel_time: 60,
};

const TRANSFER_ROUTE_STOPS = [
  {
    name: 'San Luis Public Market',
    sequence: 1,
    latitude: 15.1667,
    longitude: 120.7333,
    stop_type: 'terminal',
    covered_waiting_area: true,
  },
  {
    name: 'Santo Tomas Transfer Point',
    sequence: 2,
    latitude: 15.1206,
    longitude: 120.7188,
    stop_type: 'both',
    covered_waiting_area: false,
  },
  {
    name: 'SM City San Fernando',
    sequence: 3,
    latitude: 15.0285,
    longitude: 120.6898,
    stop_type: 'terminal',
    covered_waiting_area: true,
  },
];

// Deliberately varied so cheapest/fastest/most-reliable don't tie: JEEP-01
// is the plain "next available" pick, JEEP-02 is mid-trip (less reliable),
// JEEP-03 is available with the lowest occupancy (most reliable).
const DIRECT_ROUTE_VEHICLES = [
  {
    vehicle_number: 'SL-SF-JEEP-01',
    plate_number: 'DEMO-0001',
    vehicle_type: 'jeepney',
    capacity: 20,
    current_occupancy: 9,
    occupancy_level: 'moderate',
    vehicle_status: 'available',
  },
  {
    vehicle_number: 'SL-SF-JEEP-02',
    plate_number: 'DEMO-0002',
    vehicle_type: 'jeepney',
    capacity: 20,
    current_occupancy: 16,
    occupancy_level: 'near_full',
    vehicle_status: 'in_transit',
  },
  {
    vehicle_number: 'SL-SF-JEEP-03',
    plate_number: 'DEMO-0003',
    vehicle_type: 'jeepney',
    capacity: 20,
    current_occupancy: 3,
    occupancy_level: 'low',
    vehicle_status: 'available',
  },
];

const TRANSFER_ROUTE_VEHICLE = {
  vehicle_number: 'SL-STO-JEEP-01',
  plate_number: 'DEMO-0004',
  vehicle_type: 'jeepney',
  capacity: 20,
  current_occupancy: 4,
  occupancy_level: 'low',
  vehicle_status: 'available',
};

const documentId = () => crypto.randomBytes(16).toString('hex').slice(0, 24);

async function ensureTransferRoute(client) {
  const existing = await client.query('SELECT id FROM routes WHERE route_code = $1 LIMIT 1', [
    TRANSFER_ROUTE.route_code,
  ]);

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO routes
      (document_id, route_name, route_code, origin, destination, base_fare,
       estimated_travel_time, route_status, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), now(), now())
     RETURNING id`,
    [
      documentId(),
      TRANSFER_ROUTE.route_name,
      TRANSFER_ROUTE.route_code,
      TRANSFER_ROUTE.origin,
      TRANSFER_ROUTE.destination,
      TRANSFER_ROUTE.base_fare,
      TRANSFER_ROUTE.estimated_travel_time,
    ]
  );

  console.log(`created route "${TRANSFER_ROUTE.route_code}" (id ${inserted.rows[0].id})`);
  return inserted.rows[0].id;
}

async function ensureRouteStops(client, routeId) {
  for (const stop of TRANSFER_ROUTE_STOPS) {
    const existing = await client.query(
      `SELECT s.id FROM route_stops s
       JOIN route_stops_route_lnk link ON link.route_stop_id = s.id
       WHERE link.route_id = $1 AND s.name = $2
       LIMIT 1`,
      [routeId, stop.name]
    );

    if (existing.rows.length > 0) {
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO route_stops
        (document_id, name, sequence, latitude, longitude, stop_type,
         covered_waiting_area, accessible_toilet_nearby,
         created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, now(), now(), now())
       RETURNING id`,
      [
        documentId(),
        stop.name,
        stop.sequence,
        stop.latitude,
        stop.longitude,
        stop.stop_type,
        stop.covered_waiting_area,
      ]
    );

    await client.query(
      `INSERT INTO route_stops_route_lnk (route_stop_id, route_id) VALUES ($1, $2)`,
      [inserted.rows[0].id, routeId]
    );

    console.log(`created stop "${stop.name}" for route id ${routeId}`);
  }
}

async function ensureVehicle(client, vehicle, routeId) {
  const existing = await client.query('SELECT id FROM vehicles WHERE vehicle_number = $1 LIMIT 1', [
    vehicle.vehicle_number,
  ]);

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO vehicles
      (document_id, vehicle_number, plate_number, vehicle_type, capacity,
       current_occupancy, occupancy_level, vehicle_status,
       wheelchair_accessible, low_floor, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false, now(), now(), now())
     RETURNING id`,
    [
      documentId(),
      vehicle.vehicle_number,
      vehicle.plate_number,
      vehicle.vehicle_type,
      vehicle.capacity,
      vehicle.current_occupancy,
      vehicle.occupancy_level,
      vehicle.vehicle_status,
    ]
  );

  const vehicleId = inserted.rows[0].id;

  await client.query(`INSERT INTO vehicles_route_lnk (vehicle_id, route_id) VALUES ($1, $2)`, [
    vehicleId,
    routeId,
  ]);

  console.log(`created vehicle "${vehicle.vehicle_number}" on route id ${routeId}`);
  return vehicleId;
}

async function main() {
  const client = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME || 'pamana-db',
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD,
  });

  await client.connect();
  await client.query('BEGIN');

  try {
    const directRoute = await client.query('SELECT id FROM routes WHERE route_code = $1 LIMIT 1', [
      DIRECT_ROUTE_CODE,
    ]);

    if (directRoute.rows.length === 0) {
      throw new Error(
        `Route "${DIRECT_ROUTE_CODE}" not found - run scripts/seed-local-demo-route.js first.`
      );
    }

    const directRouteId = directRoute.rows[0].id;

    for (const vehicle of DIRECT_ROUTE_VEHICLES) {
      await ensureVehicle(client, vehicle, directRouteId);
    }

    const transferRouteId = await ensureTransferRoute(client);
    await ensureRouteStops(client, transferRouteId);
    await ensureVehicle(client, TRANSFER_ROUTE_VEHICLE, transferRouteId);

    await client.query('COMMIT');
    console.log('Trip planner demo data ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('TRIP PLANNER DEMO SEED FAILED:', error.message);
  process.exit(1);
});
