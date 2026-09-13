'use strict';

/**
 * Strapi's schema sync (strapi.db.schema.sync(), run once per startup)
 * creates every attribute's column purely from its schema.json shape -
 * `required`/`default` are enforced by the Document Service at the
 * application layer only, never as a DB-level NOT NULL/DEFAULT. Confirmed
 * empirically: even a from-scratch CREATE TABLE leaves these nullable with
 * no default, identically to an ALTER TABLE ADD COLUMN on an existing one.
 *
 * These four accessibility flags are meant to be read directly by a future
 * recommendation engine (Phase 17/20.3), so "unknown" must never be
 * possible to read back as true by construction, not just by convention -
 * this hardens that at the DB level too, closing the gap for anything that
 * writes via raw SQL/import scripts instead of the Strapi API.
 *
 * `database/migrations/*.js` files can't do this: Strapi always runs
 * pending user migrations BEFORE schema sync (see @strapi/database's
 * schema/index.js `sync()`), so on a fresh database the target tables
 * don't exist yet at migration time. The user `bootstrap()` lifecycle
 * below is the first hook guaranteed to run after schema sync has
 * finished (Strapi core's own bootstrap() calls db.schema.sync() long
 * before it runs user lifecycles) - so it runs identically on a fresh
 * clone and an existing database, every startup, and is fully idempotent.
 */
const ACCESSIBILITY_BOOLEAN_COLUMNS = [
  { table: 'vehicles', column: 'wheelchair_accessible' },
  { table: 'vehicles', column: 'low_floor' },
  { table: 'route_stops', column: 'covered_waiting_area' },
  { table: 'route_stops', column: 'accessible_toilet_nearby' },
];

const ROLE_LOOKUP_ACTION = 'plugin::users-permissions.role.find';
const REQUIRED_ROLE_PERMISSIONS = {
  Passenger: [
    ROLE_LOOKUP_ACTION,
    'api::passenger-report.passenger-report.find',
    'api::passenger-report.passenger-report.findOne',
    'api::passenger-report.passenger-report.create',
    'api::passenger-profile.passenger-profile.create',
    'api::passenger-profile.passenger-profile.find',
    'api::passenger-profile.passenger-profile.findOne',
    'api::passenger-profile.passenger-profile.update',
    'api::trip-search.trip-search.search',
    'api::live-vehicle.live-vehicle.list',
  ],
  Driver: [
    ROLE_LOOKUP_ACTION,
    'api::trip.trip.find',
    'api::trip.trip.findOne',
    'api::trip.trip.create',
    'api::trip.trip.update',
    'api::vehicle.vehicle.update',
    'api::vehicle-location.vehicle-location.create',
  ],
  LGU: [
    ROLE_LOOKUP_ACTION,
    'api::pamana-ai.pamana-ai.waitTime',
    'api::pamana-ai.pamana-ai.demand',
    'api::pamana-ai.pamana-ai.supplyDemand',
    'api::pamana-ai.pamana-ai.dashboardSummary',
    'api::live-vehicle.live-vehicle.list',
    'api::disruption.disruption.create',
    'api::disruption.disruption.update',
    'api::report-confidence.report-confidence.list',
  ],
  Administrator: [
    ROLE_LOOKUP_ACTION,
    'api::pamana-ai.pamana-ai.waitTime',
    'api::pamana-ai.pamana-ai.demand',
    'api::pamana-ai.pamana-ai.supplyDemand',
    'api::pamana-ai.pamana-ai.dashboardSummary',
    'api::live-vehicle.live-vehicle.list',
    'api::disruption.disruption.create',
    'api::disruption.disruption.update',
    'api::report-confidence.report-confidence.list',
  ],
};

async function hardenAccessibilityColumns(strapi) {
  if (strapi.db.dialect.client !== 'postgres') {
    return;
  }

  const knex = strapi.db.connection;

  for (const { table, column } of ACCESSIBILITY_BOOLEAN_COLUMNS) {
    const hasColumn = await knex.schema.hasColumn(table, column);

    if (!hasColumn) {
      continue;
    }

    await knex(table).whereNull(column).update({ [column]: false });

    await knex.schema.alterTable(table, (t) => {
      t.boolean(column).notNullable().defaultTo(false).alter();
    });
  }
}

/**
 * `/api/users/me?populate=role` is sanitized against the caller's content API
 * permissions. Without permission to read roles, Strapi silently removes the
 * populated role and the frontend cannot choose a role-specific dashboard.
 *
 * Keep this idempotent so fresh databases and restored databases behave the
 * same way without requiring a manual permissions change in the admin panel.
 */
async function ensureRequiredRolePermissions(strapi) {
  const roleQuery = strapi.db.query('plugin::users-permissions.role');
  const permissionQuery = strapi.db.query(
    'plugin::users-permissions.permission'
  );

  const roles = await roleQuery.findMany({
    where: { name: { $in: Object.keys(REQUIRED_ROLE_PERMISSIONS) } },
  });

  for (const role of roles) {
    for (const action of REQUIRED_ROLE_PERMISSIONS[role.name]) {
      const existingPermission = await permissionQuery.findOne({
        where: {
          action,
          role: { id: role.id },
        },
      });

      if (!existingPermission) {
        await permissionQuery.create({
          data: {
            action,
            role: role.id,
          },
        });
      }
    }
  }
}

/**
 * `POST /api/auth/local/register` (used by the passenger self-service
 * register flow, see useAuth.ts) assigns whatever role is configured as
 * the plugin's "default role for authenticated users" - out of the box
 * that's Strapi's own built-in "authenticated" role, not this app's
 * "Passenger" role. Left on the default, every self-registered user ends
 * up unable to create their passenger profile (Passenger-only permission)
 * and never resolves to a role-specific dashboard. Force it to "passenger"
 * so fresh/restored databases match the intended self-service signup flow
 * without a manual admin panel change.
 */
async function ensureDefaultRegistrationRole(strapi) {
  const pluginStore = strapi.store({
    type: 'plugin',
    name: 'users-permissions',
    key: 'advanced',
  });

  const settings = await pluginStore.get();

  if (settings && settings.default_role !== 'passenger') {
    await pluginStore.set({ value: { ...settings, default_role: 'passenger' } });
  }
}

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    await hardenAccessibilityColumns(strapi);
    await ensureRequiredRolePermissions(strapi);
    await ensureDefaultRegistrationRole(strapi);
  },
};
