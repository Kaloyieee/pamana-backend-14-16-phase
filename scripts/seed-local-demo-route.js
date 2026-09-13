'use strict';

/**
 * Creates the pilot San Luis to City of San Fernando corridor used by the
 * passenger trip planner. Safe to re-run: the route and stops are matched by
 * stable codes/names, and existing records are reused.
 *
 * Usage: npm run seed:local-demo-route
 */

const crypto = require('crypto');
const { Client } = require('pg');

const ROUTE = {
  route_name: 'San Luis - City of San Fernando',
  route_code: 'SL-SF-01',
  origin: 'San Luis, Pampanga',
  destination: 'City of San Fernando, Pampanga',
  base_fare: 40,
  estimated_travel_time: 45,
};

const STOPS = [
  {
    name: 'San Luis Public Market',
    sequence: 1,
    latitude: 15.1667,
    longitude: 120.7333,
    stop_type: 'terminal',
    covered_waiting_area: true,
  },
  {
    name: 'Santo Tomas Stop',
    sequence: 2,
    latitude: 15.1206,
    longitude: 120.7188,
    stop_type: 'both',
    covered_waiting_area: false,
  },
  {
    name: 'OGC Stop',
    sequence: 3,
    latitude: 15.0746,
    longitude: 120.7043,
    stop_type: 'both',
    covered_waiting_area: false,
  },
  {
    name: 'SM City San Fernando',
    sequence: 4,
    latitude: 15.0285,
    longitude: 120.6898,
    stop_type: 'terminal',
    covered_waiting_area: true,
  },
];

const documentId = () => crypto.randomBytes(16).toString('hex').slice(0, 24);

async function ensureRoute(client) {
  let result = await client.query(
    'SELECT id FROM routes WHERE route_code = $1 LIMIT 1',
    [ROUTE.route_code]
  );

  if (result.rows.length > 0) {
    return result.rows[0].id;
  }

  result = await client.query(
    "SELECT id FROM routes WHERE route_code = 'AUTH-TEST-001' LIMIT 1"
  );

  if (result.rows.length > 0) {
    const routeId = result.rows[0].id;
    await client.query(
      `UPDATE routes
       SET route_name = $1, route_code = $2, origin = $3, destination = $4,
           base_fare = $5, estimated_travel_time = $6, route_status = 'active',
           updated_at = now()
       WHERE id = $7`,
      [
        ROUTE.route_name,
        ROUTE.route_code,
        ROUTE.origin,
        ROUTE.destination,
        ROUTE.base_fare,
        ROUTE.estimated_travel_time,
        routeId,
      ]
    );
    return routeId;
  }

  result = await client.query(
    `INSERT INTO routes
      (document_id, route_name, route_code, origin, destination, base_fare,
       estimated_travel_time, route_status, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), now(), now())
     RETURNING id`,
    [
      documentId(),
      ROUTE.route_name,
      ROUTE.route_code,
      ROUTE.origin,
      ROUTE.destination,
      ROUTE.base_fare,
      ROUTE.estimated_travel_time,
    ]
  );

  return result.rows[0].id;
}

async function ensureStops(client, routeId) {
  for (const stop of STOPS) {
    let result = await client.query(
      `SELECT s.id
       FROM route_stops s
       JOIN route_stops_route_lnk link ON link.route_stop_id = s.id
       WHERE link.route_id = $1 AND s.name = $2
       LIMIT 1`,
      [routeId, stop.name]
    );

    let stopId;
    if (result.rows.length > 0) {
      stopId = result.rows[0].id;
      await client.query(
        `UPDATE route_stops
         SET sequence = $1, latitude = $2, longitude = $3, stop_type = $4,
             covered_waiting_area = $5, accessible_toilet_nearby = false,
             updated_at = now()
         WHERE id = $6`,
        [
          stop.sequence,
          stop.latitude,
          stop.longitude,
          stop.stop_type,
          stop.covered_waiting_area,
          stopId,
        ]
      );
      continue;
    }

    result = await client.query(
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
    stopId = result.rows[0].id;

    await client.query(
      `INSERT INTO route_stops_route_lnk (route_stop_id, route_id)
       VALUES ($1, $2)`,
      [stopId, routeId]
    );
  }
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
    const routeId = await ensureRoute(client);
    await ensureStops(client, routeId);
    await client.query('COMMIT');
    console.log(`Demo corridor ready (route id ${routeId}, ${STOPS.length} stops).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('DEMO ROUTE SEED FAILED:', error.message);
  process.exit(1);
});
