'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAvailability,
  timeOfDayFactor,
} = require('../src/services/pamana-ai/wait-time');
const {
  classifyDemand,
  featureMultiplier,
} = require('../src/services/pamana-ai/demand');
const {
  classifySupplyDemand,
  availableSeats,
} = require('../src/services/pamana-ai/supply-demand');

test('Phase 14 availability classification follows the requested bands', () => {
  assert.equal(classifyAvailability(8, 0.8, 1), 'High');
  assert.equal(classifyAvailability(18, 0.8, 1), 'Medium');
  assert.equal(classifyAvailability(30, 0.8, 1), 'Low');
  assert.equal(classifyAvailability(8, 0.2, 1), 'Low');
  assert.equal(classifyAvailability(8, 0.8, 0), 'Low');
});

test('Phase 14 time-of-day factor recognizes rush and late-night periods', () => {
  assert.equal(timeOfDayFactor(7), 0.9);
  assert.equal(timeOfDayFactor(17), 0.9);
  assert.equal(timeOfDayFactor(23), 1.25);
  assert.equal(timeOfDayFactor(12), 1);
});

test('Phase 15 demand categories are LOW/MODERATE/HIGH/CRITICAL', () => {
  assert.equal(classifyDemand(5), 'LOW');
  assert.equal(classifyDemand(15), 'MODERATE');
  assert.equal(classifyDemand(30), 'HIGH');
  assert.equal(classifyDemand(45), 'CRITICAL');
});

test('Phase 15 optional context changes the transparent multiplier', () => {
  const normal = featureMultiplier({ hour: 7 });
  const peakSchoolRain = featureMultiplier({ weather: 'rain', schoolDay: true, hour: 7 });
  assert.equal(normal.multiplier, 1);
  assert.ok(peakSchoolRain.multiplier > 1);
});

test('Phase 16 available seats subtract current occupancy', () => {
  assert.equal(
    availableSeats({ vehicle_status: 'available', capacity: 20, current_occupancy: 7 }),
    13
  );
  assert.equal(
    availableSeats({ vehicle_status: 'offline', capacity: 20, current_occupancy: 0 }),
    0
  );
});

test('Phase 16 classifies adequate, monitor and shortage', () => {
  assert.equal(classifySupplyDemand(10, 30), 'ADEQUATE');
  assert.equal(classifySupplyDemand(28, 30), 'MONITOR');
  assert.equal(classifySupplyDemand(31, 30), 'SHORTAGE');
  assert.equal(classifySupplyDemand(null, 30), 'UNKNOWN');
});
