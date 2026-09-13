'use strict';

/**
 * passenger-report controller
 *
 * A passenger's report is always attributed to their own passenger
 * profile (never a client-supplied id). `route`/`stop` are optional -
 * attached automatically when the caller has that context (per the
 * guide's "Automatically Attach Context ... when available"), but a
 * general free-form report is still valid without them. Duplicate
 * reports for the same passenger/type within a short window are
 * rejected (narrowed to the same route/stop too, when both are given)
 * so a single passenger can't inflate the crowdsourcing confidence
 * signal. find/findOne are scoped to the caller's own reports only -
 * passengers can see their own submission history, not everyone else's.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const DUPLICATE_WINDOW_MINUTES = 5;

const getOwnPassengerProfile = (userId) =>
  strapi.documents('api::passenger-profile.passenger-profile').findFirst({
    filters: { user: { id: userId } },
  });

module.exports = createCoreController('api::passenger-report.passenger-report', ({ strapi }) => ({
  async create(ctx) {
    const passengerProfile = await getOwnPassengerProfile(ctx.state.user.id);

    if (!passengerProfile) {
      return ctx.badRequest('No passenger profile linked to this account.');
    }

    const { report_type, route, stop, vehicle, latitude, longitude, location_note } =
      ctx.request.body?.data || {};

    if (!report_type) {
      return ctx.badRequest('"report_type" is required.');
    }

    // Validate and sanitize only fields supplied by the caller. The passenger
    // ownership relation and timestamp are trusted server-side fields; adding
    // them before super.create() makes content API validation reject the
    // request because passengers cannot query all passenger profiles.
    await this.validateQuery(ctx);
    const sanitizedQuery = await this.sanitizeQuery(ctx);
    await this.validateInput(ctx.request.body.data, ctx);
    const sanitizedInput = await this.sanitizeInput(ctx.request.body.data, ctx);

    const windowStart = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000).toISOString();

    const duplicateFilters = {
      passenger: { id: passengerProfile.id },
      report_type,
      reported_at: { $gte: windowStart },
    };

    if (route && stop) {
      duplicateFilters.route = { id: route };
      duplicateFilters.stop = { id: stop };
    }

    const recentDuplicate = await strapi.documents('api::passenger-report.passenger-report').findFirst({
      filters: duplicateFilters,
    });

    if (recentDuplicate) {
      return ctx.badRequest('You already submitted this report recently. Please wait before submitting again.');
    }

    const entity = await strapi
      .service('api::passenger-report.passenger-report')
      .create({
        ...sanitizedQuery,
        data: {
          ...sanitizedInput,
          report_type,
          route: route || undefined,
          stop: stop || undefined,
          vehicle: vehicle || undefined,
          latitude,
          longitude,
          location_note,
          reported_at: new Date().toISOString(),
          passenger: passengerProfile.id,
        },
      });
    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);

    ctx.status = 201;
    return this.transformResponse(sanitizedEntity);
  },

  async find(ctx) {
    const passengerProfile = await getOwnPassengerProfile(ctx.state.user.id);

    // Validate and sanitize only the caller-controlled query. Adding the
    // private passenger relation to ctx.query before calling super.find()
    // makes Strapi reject it unless passengers are also allowed to list all
    // passenger profiles. Apply the ownership filter after sanitization so
    // report history stays scoped without broadening profile permissions.
    await this.validateQuery(ctx);
    const sanitizedQuery = await this.sanitizeQuery(ctx);
    const ownReportsFilter = {
      passenger: { id: passengerProfile?.id ?? -1 },
    };
    const filters = sanitizedQuery.filters
      ? { $and: [sanitizedQuery.filters, ownReportsFilter] }
      : ownReportsFilter;

    const { results, pagination } = await strapi
      .service('api::passenger-report.passenger-report')
      .find({ ...sanitizedQuery, filters });
    const sanitizedResults = await this.sanitizeOutput(results, ctx);

    return this.transformResponse(sanitizedResults, { pagination });
  },

  async findOne(ctx) {
    const passengerProfile = await getOwnPassengerProfile(ctx.state.user.id);

    if (passengerProfile) {
      const report = await strapi.documents('api::passenger-report.passenger-report').findOne({
        documentId: ctx.params.id,
        populate: ['passenger'],
      });

      if (!report || report.passenger?.id !== passengerProfile.id) {
        return ctx.notFound();
      }
    }

    return super.findOne(ctx);
  },
}));
