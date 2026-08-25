'use strict';

const SalusDeviceBase = require('../../lib/salus-device-base');

const UNBOUND_ZONE_ADDR = 65535;

/**
 * Dew-protection fields whose semantics are not understood yet (only zeros
 * observed so far). Recorded as invisible app-level insights and a
 * dew_debug app setting, never as device capabilities, until a real
 * non-zero observation teaches us what they mean.
 */
const DEW_DEBUG_PROPS = ['SystemDewStatus', 'WCDewState'];

function readProps(device) {
  return device?._shadow_properties || {};
}

function readOutput(device, key) {
  const props = readProps(device);
  const value = props[`ep8:sIT6ZB:${key}`] ?? props[`ep9:sIT6ZB:${key}`];
  return typeof value === 'number' ? value === 1 : null;
}

function readZoneCount(device) {
  const props = readProps(device);
  const value = props['ep8:sIT6ZB:WCTotalZoneNum'] ?? props['ep9:sIT6ZB:WCTotalZoneNum'];
  return typeof value === 'number' && value > 0 && value <= 32 ? value : 12;
}

/** Zones with a thermostat bound to them (TsatAddr != 65535). */
function readBoundZones(device) {
  const props = readProps(device);
  const zones = [];
  for (let i = 1; i <= readZoneCount(device); i++) {
    const addr = props[`ep8:sIT6ZB:WCZone${i}TsatAddr`] ?? props[`ep9:sIT6ZB:WCZone${i}TsatAddr`];
    if (typeof addr === 'number' && addr !== UNBOUND_ZONE_ADDR) {
      zones.push(i);
    }
  }
  return zones;
}

/** WCZoneStatus is a bitmask of zones whose actuators are currently open. */
function readZoneActive(device, zone) {
  const props = readProps(device);
  const status = props['ep8:sIT6ZB:WCZoneStatus'] ?? props['ep9:sIT6ZB:WCZoneStatus'];
  if (typeof status !== 'number') return null;
  return (status & (1 << (zone - 1))) !== 0;
}

class SalusWiringCenterDevice extends SalusDeviceBase {
  async onInit() {
    const { email, password } = await this.connectClient();
    this._zoneTitlesSet = {};
    await this.startPolling(email, password);
  }

  async applyCloudSnapshot(own) {
    const pump = readOutput(own, 'PumpOutput');
    if (typeof pump === 'boolean') {
      await this._updateActiveState(
        'salus_pump_output',
        pump,
        this.driver.pumpOnTrigger,
        this.driver.pumpOffTrigger,
      );
    }

    const boiler = readOutput(own, 'BoilerOutput');
    if (typeof boiler === 'boolean') {
      await this._updateActiveState(
        'salus_boiler_output',
        boiler,
        this.driver.boilerOnTrigger,
        this.driver.boilerOffTrigger,
      );
    }

    for (const zone of readBoundZones(own)) {
      const active = readZoneActive(own, zone);
      if (typeof active !== 'boolean') continue;
      const capability = `salus_zone_active.zone${zone}`;
      const isNew = !this.hasCapability(capability);
      await this._updateActiveState(
        capability,
        active,
        this.driver.zoneActivatedTrigger,
        this.driver.zoneDeactivatedTrigger,
        { zone },
      );
      if (isNew && !this._zoneTitlesSet[capability]) {
        this._zoneTitlesSet[capability] = true;
        await this.setCapabilityOptions(capability, { title: { en: `Zone ${zone}` } }).catch(this.error);
      }
    }

    await this._recordDewDebug(own);
  }

  async _recordDewDebug(own) {
    const props = readProps(own);
    const values = {};
    for (const key of DEW_DEBUG_PROPS) {
      const value = props[`ep8:sIT6ZB:${key}`] ?? props[`ep9:sIT6ZB:${key}`];
      if (typeof value === 'number') values[key] = value;
    }
    if (!Object.keys(values).length) return;

    // Seed the comparison from the persisted record so app restarts do not
    // re-append an unchanged baseline.
    let previous = this._lastDewValues;
    if (!previous) {
      try {
        previous = (this.homey.settings.get('dew_debug') || {})[this.getName()]?.current;
      } catch (error) {
        previous = null;
      }
    }
    previous = previous || {};
    const changed = DEW_DEBUG_PROPS.some((key) => values[key] !== previous[key]);
    this._lastDewValues = values;
    if (!changed) return;

    // Logged so user-sent diagnostic reports carry the observation.
    this.log(`[dew-debug] ${this.getName()}: ${JSON.stringify(values)} (was ${JSON.stringify(previous)})`);

    try {
      const all = this.homey.settings.get('dew_debug') || {};
      const entry = all[this.getName()] || { changes: [] };
      entry.current = values;
      entry.changes.push({ at: new Date().toISOString(), ...values });
      if (entry.changes.length > 50) {
        entry.changes.splice(0, entry.changes.length - 50);
      }
      all[this.getName()] = entry;
      this.homey.settings.set('dew_debug', all);
    } catch (error) {
      this.error('Failed persisting dew debug setting', error);
    }

    for (const [key, value] of Object.entries(values)) {
      try {
        const logId = `dew_${key.toLowerCase()}_${String(this.getData().id).slice(-6)}`;
        let log;
        try {
          log = await this.homey.insights.getLog(logId);
        } catch (missing) {
          log = await this.homey.insights.createLog(logId, {
            title: { en: `${this.getName()} ${key}` },
            type: 'number',
          });
        }
        await log.createEntry(value);
      } catch (error) {
        this.error('Failed writing dew insights entry', error);
      }
    }
  }
}

module.exports = SalusWiringCenterDevice;
