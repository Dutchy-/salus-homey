'use strict';

const Homey = require('homey');
const SalusCloudClient = require('../../lib/salus-cloud-client');

const TARGET_CONFIRM_TIMEOUT_MS = 45 * 1000;
const ONOFF_CONFIRM_TIMEOUT_MS = 30 * 1000;
const LAST_TARGET_STORE_KEY = 'last_target_temperature';
const LAST_TARGET_OPTIONS_STORE_KEY = 'last_target_options';
const DEFAULT_RESTORE_TARGET_C = 20;

/** Fallback when shadow does not publish min/max yet (manifest default is max 45). */
const TARGET_TEMPERATURE_OPTIONS = {
  min: 5,
  max: 40.5,
  step: 0.5,
};
const TARGET_SENTINEL_EPSILON = 0.2;

function deviceMatchesHomeyData(device, pairedId) {
  const p = String(pairedId);
  const candidates = [device.id, device.device_id, device.device_code]
    .filter((v) => v != null && v !== '')
    .map(String);
  return candidates.includes(p);
}

function readTemperature(device) {
  const props = device?._shadow_properties || {};
  const tempX100 =
    props['ep9:sIT600TH:LocalTemperature_x100'] ??
    props['ep9:sHT:LocalTemperature_x100'];

  if (typeof tempX100 === 'number') {
    return tempX100 / 100;
  }
  return null;
}

function readTargetTemperature(device) {
  const props = device?._shadow_properties || {};
  const tempX100 =
    props['ep9:sIT600TH:HeatingSetpoint_x100'] ??
    props['ep9:sHT:HeatingSetpoint_x100'];

  if (typeof tempX100 === 'number') {
    return tempX100 / 100;
  }
  return null;
}

function readHumidity(device) {
  const props = device?._shadow_properties || {};
  const directHumidity =
    // Manually cross-referenced against the Salus app values (Apr 2026):
    // despite its name, SunnySetpoint_x100 contains relative humidity for SQ610RFNH.
    props['ep9:sIT600TH:SunnySetpoint_x100'] ??
    props['ep9:sIT600TH:LocalHumidity'] ??
    props['ep9:sHT:LocalHumidity'] ??
    props['ep9:sIT600TH:LocalHumidity_x100'] ??
    props['ep9:sHT:LocalHumidity_x100'];

  if (typeof directHumidity === 'number') {
    return directHumidity > 100 ? directHumidity / 100 : directHumidity;
  }

  for (const [key, value] of Object.entries(props)) {
    if (/humidity/i.test(key) && typeof value === 'number') {
      return value > 100 ? value / 100 : value;
    }
  }

  for (const field of ['humidity', 'current_humidity']) {
    if (typeof device?.[field] === 'number') {
      const value = device[field];
      return value > 100 ? value / 100 : value;
    }
  }

  if (device?.status && typeof device.status === 'object' && typeof device.status.humidity === 'number') {
    const value = device.status.humidity;
    return value > 100 ? value / 100 : value;
  }

  return null;
}

function readSystemModeRaw(device) {
  const props = device?._shadow_properties || {};
  return props['ep9:sIT600TH:SystemMode'] ?? props['ep9:sHT:SystemMode'] ?? null;
}

function readHeatingControl(device) {
  const props = device?._shadow_properties || {};
  return props['ep9:sIT600TH:HeatingControl'] ?? props['ep9:sHT:HeatingControl'] ?? null;
}

function readCoolingControl(device) {
  const props = device?._shadow_properties || {};
  return props['ep9:sIT600TH:CoolingControl'] ?? props['ep9:sHT:CoolingControl'] ?? null;
}

function readHoldTypeRaw(device) {
  const props = device?._shadow_properties || {};
  return props['ep9:sIT600TH:HoldType'] ?? props['ep9:sHT:HoldType'] ?? null;
}

function readThermostatMode(device) {
  const holdMode = readHoldMode(device);
  if (holdMode === 'standby') return 'off';

  const runningState = readRunningState(device);
  if (runningState === 2) return 'cool';
  if (runningState === 1) return 'heat';

  const systemMode = readSystemModeRaw(device);

  if (systemMode === 0) return 'off';
  if (systemMode === 2 || systemMode === 3) return 'cool';
  if (systemMode === 1 || systemMode === 4) return 'heat';
  return null;
}

function readRunningState(device) {
  const props = device?._shadow_properties || {};
  return props['ep9:sIT600TH:RunningState'] ?? props['ep9:sHT:RunningState'] ?? null;
}

function readStrongActiveMode(device) {
  const runningState = readRunningState(device);
  if (runningState === 2) return 'cool';
  if (runningState === 1) return 'heat';
  return null;
}

function readHoldMode(device) {
  const holdType = readHoldTypeRaw(device);
  if (holdType === 7) return 'standby';
  if (holdType === 2) return 'hold';
  if (holdType === 0) return 'schedule';
  return null;
}

function readOnOff(device) {
  const holdMode = readHoldMode(device);
  return holdMode !== 'standby';
}

function isApproximately(value, expected, epsilon = TARGET_SENTINEL_EPSILON) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected) <= epsilon;
}

function isStandbySentinelTarget(value) {
  return isApproximately(value, 5) || isApproximately(value, 40.5);
}

function resolveStandbySentinelForMode(mode) {
  return mode === 'cool' ? 40.5 : 5;
}

class SalusSensorDevice extends Homey.Device {
  clampTargetToKnownRange(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const min = typeof this._minTargetC === 'number' ? this._minTargetC : TARGET_TEMPERATURE_OPTIONS.min;
    const max = typeof this._maxTargetC === 'number' ? this._maxTargetC : TARGET_TEMPERATURE_OPTIONS.max;
    return Math.min(max, Math.max(min, value));
  }

  async rememberTargetTemperature(value) {
    const clamped = this.clampTargetToKnownRange(value);
    if (clamped == null) return;
    if (isStandbySentinelTarget(clamped)) return;
    await this.setStoreValue(LAST_TARGET_STORE_KEY, clamped);
  }

  async getRememberedTargetTemperature() {
    const remembered = await this.getStoreValue(LAST_TARGET_STORE_KEY);
    if (typeof remembered === 'number' && Number.isFinite(remembered)) {
      return this.clampTargetToKnownRange(remembered);
    }
    return null;
  }

  async refreshSoon(delayMs = 4000) {
    if (typeof this.homey.app?.requestDeviceRefresh === 'function') {
      await this.homey.app.requestDeviceRefresh(this, delayMs);
      return;
    }
    this.homey.setTimeout(() => {
      this.syncFromCloud().catch(this.error);
    }, delayMs);
  }

  async applyLocalOnOff(onoff) {
    this._pendingOnOff = onoff;
    this._pendingOnOffUntil = Date.now() + ONOFF_CONFIRM_TIMEOUT_MS;
    this._lastOnOff = onoff;
    if (this.hasCapability('onoff')) {
      await this.setCapabilityValue('onoff', onoff);
    }
    if (onoff === false && this.hasCapability('target_temperature')) {
      // Reflect standby setpoint immediately to avoid cloud-lag snap.
      const modeForStandby =
        (this._lastActiveThermostatMode === 'heat' || this._lastActiveThermostatMode === 'cool')
          ? this._lastActiveThermostatMode
          : this._lastThermostatMode;
      const standbyTarget = resolveStandbySentinelForMode(modeForStandby);
      // Ensure Homey does not clamp cooling standby sentinel (40.5 C) to old max (e.g. 35 C).
      if (standbyTarget > (this._maxTargetC ?? TARGET_TEMPERATURE_OPTIONS.max)) {
        const min = typeof this._minTargetC === 'number' ? this._minTargetC : TARGET_TEMPERATURE_OPTIONS.min;
        const max = standbyTarget + 2;
        this._minTargetC = min;
        this._maxTargetC = max;
        this._targetTempOptsKey = `${min}|${max}|0.5`;
        await this.setCapabilityOptions('target_temperature', { min, max, step: 0.5 });
      }
      this._pendingTargetTemperature = standbyTarget;
      this._pendingTargetUntil = Date.now() + TARGET_CONFIRM_TIMEOUT_MS;
      await this.setCapabilityValue('target_temperature', standbyTarget);
    }
    // thermostat_mode is read-only reflection, but we can set a sensible immediate value.
    if (this.hasCapability('thermostat_mode')) {
      const rememberedMode =
        (this._lastActiveThermostatMode === 'heat' || this._lastActiveThermostatMode === 'cool')
          ? this._lastActiveThermostatMode
          : ((this._lastThermostatMode === 'heat' || this._lastThermostatMode === 'cool')
            ? this._lastThermostatMode
            : null);
      const immediateMode = onoff ? (rememberedMode || 'heat') : 'off';
      await this.setCapabilityValue('thermostat_mode', immediateMode);
    }
  }

  async onInit() {
    this.client = new SalusCloudClient({
      email: this.getSetting('email'),
      password: this.getSetting('password'),
    });
    this._targetTempOptsKey = null;
    this._pendingTargetTemperature = null;
    this._pendingTargetUntil = 0;
    this._pendingOnOff = null;
    this._pendingOnOffUntil = 0;

    // Devices paired before target_temperature existed do not get new capabilities automatically.
    if (!this.hasCapability('target_temperature')) {
      await this.addCapability('target_temperature');
    }
    // Apply options immediately so UI has sane bounds before first cloud sync.
    const storedTargetOpts = await this.getStoreValue(LAST_TARGET_OPTIONS_STORE_KEY);
    const initialTargetOpts =
      storedTargetOpts &&
      typeof storedTargetOpts.min === 'number' &&
      typeof storedTargetOpts.max === 'number' &&
      typeof storedTargetOpts.step === 'number'
        ? storedTargetOpts
        : TARGET_TEMPERATURE_OPTIONS;
    this._minTargetC = initialTargetOpts.min;
    this._maxTargetC = initialTargetOpts.max;
    this._targetTempOptsKey = `${initialTargetOpts.min}|${initialTargetOpts.max}|${initialTargetOpts.step}`;
    await this.setCapabilityOptions('target_temperature', initialTargetOpts);
    if (!this.hasCapability('onoff')) {
      await this.addCapability('onoff');
    }
    if (!this.hasCapability('thermostat_mode')) {
      await this.addCapability('thermostat_mode');
    }

    this.registerCapabilityListener('target_temperature', async (value) => {
      const deviceCode = this.getSetting('device_code');
      if (!deviceCode) {
        throw new Error('Missing Salus device code');
      }
      // Optimistically keep UI at user-selected setpoint until cloud confirms.
      this._pendingTargetTemperature = value;
      this._pendingTargetUntil = Date.now() + TARGET_CONFIRM_TIMEOUT_MS;
      await this.setCapabilityValue('target_temperature', value);
      await this.rememberTargetTemperature(value);

      if (this._lastOnOff === false) {
        // Homey UX: changing setpoint should wake thermostat into Hold mode.
        await this.client.setHoldMode(deviceCode, 2, this.getData().shadow_device_index || undefined);
        await this.applyLocalOnOff(true);
      }
      await this.client.setTemperature(
        deviceCode,
        value,
        this.getData().shadow_device_index || undefined,
        this._lastActiveThermostatMode || null,
      );
      await this.refreshSoon();
    });

    this.registerCapabilityListener('onoff', async (value) => {
      const deviceCode = this.getSetting('device_code');
      if (!deviceCode) {
        throw new Error('Missing Salus device code');
      }
      const shadowIndex = this.getData().shadow_device_index || undefined;

      if (value) {
        // Restore previous target when re-enabling thermostat.
        const rememberedTarget = (await this.getRememberedTargetTemperature()) ?? DEFAULT_RESTORE_TARGET_C;
        await this.client.setHoldMode(deviceCode, 2, shadowIndex);
        await this.client.setTemperature(
          deviceCode,
          rememberedTarget,
          shadowIndex,
          this._lastActiveThermostatMode || null,
        );
        this._pendingTargetTemperature = rememberedTarget;
        this._pendingTargetUntil = Date.now() + TARGET_CONFIRM_TIMEOUT_MS;
        await this.setCapabilityValue('target_temperature', rememberedTarget);
      } else {
        await this.client.setHoldMode(deviceCode, 7, shadowIndex);
      }

      await this.applyLocalOnOff(value);
      await this.refreshSoon();
    });

    // Heat/cool comes from a separate heatpump controller app, so this capability is reflection-only here.
    this.registerCapabilityListener('thermostat_mode', async () => {
      throw new Error('Heatpump mode is read-only in this app and managed by your separate heatpump integration.');
    });

    if (typeof this.homey.app?.registerDeviceForSharedPolling === 'function') {
      await this.homey.app.registerDeviceForSharedPolling(
        this,
        this.getSetting('email'),
        this.getSetting('password'),
      );
      await this.refreshSoon(0);
    } else {
      await this.syncFromCloud();
    }
  }

  async onDeleted() {
    if (typeof this.homey.app?.unregisterDeviceFromSharedPolling === 'function') {
      this.homey.app.unregisterDeviceFromSharedPolling(this);
    }
  }

  /**
   * Keep Homey min/max in sync with Salus shadow so real setpoints (e.g. 40.5 °C) are not clamped to 35 °C.
   */
  async applyTargetTemperatureOptionsFromShadow(props, targetCelsius) {
    const minX = props['ep9:sIT600TH:MinHeatSetpoint_x100'] ?? props['ep9:sHT:MinHeatSetpoint_x100'];
    const maxCandidates = [
      props['ep9:sIT600TH:MaxHeatSetpoint_x100'],
      props['ep9:sIT600TH:MaxHeatSetpoint_x100_a'],
      props['ep9:sHT:MaxHeatSetpoint_x100'],
      props['ep9:sHT:MaxHeatSetpoint_x100_a'],
    ].filter((v) => typeof v === 'number');

    const min = typeof minX === 'number' ? minX / 100 : TARGET_TEMPERATURE_OPTIONS.min;
    let max = TARGET_TEMPERATURE_OPTIONS.max;
    if (maxCandidates.length) {
      max = Math.max(...maxCandidates.map((v) => v / 100));
    }
    if (typeof targetCelsius === 'number' && Number.isFinite(targetCelsius)) {
      max = Math.max(max, targetCelsius + 2);
    }
    max = Math.min(60, Math.max(max, min + 1));

    const opts = { min, max, step: 0.5 };
    this._minTargetC = min;
    this._maxTargetC = max;
    const key = `${min}|${max}|0.5`;
    if (key === this._targetTempOptsKey) {
      return;
    }
    this._targetTempOptsKey = key;
    await this.setCapabilityOptions('target_temperature', opts);
    await this.setStoreValue(LAST_TARGET_OPTIONS_STORE_KEY, opts);
  }

  async syncFromCloud() {
    try {
      const allDevices = await this.client.getAllDevices();
      await this.syncFromSnapshot(allDevices);
    } catch (error) {
      this.error('Failed syncing Salus sensor', error);
      await this.setUnavailable(error.message);
    }
  }

  async syncFromSnapshot(allDevices) {
    try {
      const own = allDevices.find((device) => deviceMatchesHomeyData(device, this.getData().id));

      if (!own) {
        throw new Error('Cloud device not found for paired Homey device');
      }

      const temperature = readTemperature(own);
      const targetTemperature = readTargetTemperature(own);
      const humidity = readHumidity(own);
      const thermostatMode = readThermostatMode(own);
      const onoff = readOnOff(own);
      const runningState = readRunningState(own);
      const strongActiveMode = readStrongActiveMode(own);

      if (typeof temperature === 'number') {
        await this.setCapabilityValue('measure_temperature', temperature);
      }
      if (typeof humidity === 'number') {
        await this.setCapabilityValue('measure_humidity', humidity);
      }

      await this.applyTargetTemperatureOptionsFromShadow(own._shadow_properties || {}, targetTemperature);

      if (typeof targetTemperature === 'number') {
        if (!isStandbySentinelTarget(targetTemperature)) {
          await this.rememberTargetTemperature(targetTemperature);
        }
        const hasPending = Date.now() < this._pendingTargetUntil && typeof this._pendingTargetTemperature === 'number';
        if (hasPending) {
          const delta = Math.abs(targetTemperature - this._pendingTargetTemperature);
          if (delta <= 0.2) {
            // Cloud confirmed the requested target.
            this._pendingTargetTemperature = null;
            this._pendingTargetUntil = 0;
            await this.setCapabilityValue('target_temperature', targetTemperature);
          } else {
            // Keep optimistic value a bit longer to avoid visual snap-back.
            await this.setCapabilityValue('target_temperature', this._pendingTargetTemperature);
          }
        } else {
          this._pendingTargetTemperature = null;
          this._pendingTargetUntil = 0;
          await this.setCapabilityValue('target_temperature', targetTemperature);
        }
      }
      if (this.hasCapability('onoff')) {
        const hasPendingOnOff = Date.now() < this._pendingOnOffUntil && typeof this._pendingOnOff === 'boolean';
        if (hasPendingOnOff) {
          if (onoff === this._pendingOnOff) {
            this._pendingOnOff = null;
            this._pendingOnOffUntil = 0;
            this._lastOnOff = onoff;
            await this.setCapabilityValue('onoff', onoff);
          } else {
            this._lastOnOff = this._pendingOnOff;
            await this.setCapabilityValue('onoff', this._pendingOnOff);
          }
        } else {
          this._pendingOnOff = null;
          this._pendingOnOffUntil = 0;
          this._lastOnOff = onoff;
          await this.setCapabilityValue('onoff', onoff);
        }
      }
      if (thermostatMode && this.hasCapability('thermostat_mode')) {
        let effectiveMode = thermostatMode;
        // Only fall back to remembered mode when current mapping is unavailable.
        if (!effectiveMode && onoff && runningState === 0 && this._lastActiveThermostatMode) {
          effectiveMode = this._lastActiveThermostatMode;
        }

        this._lastThermostatMode = effectiveMode;
        if (effectiveMode === 'heat' || effectiveMode === 'cool') {
          this._lastActiveThermostatMode = effectiveMode;
        }
        if (strongActiveMode) {
          this._lastActiveThermostatMode = strongActiveMode;
        }
        await this.setCapabilityValue('thermostat_mode', effectiveMode);
      }

      await this.setAvailable();
    } catch (error) {
      this.error('Failed syncing Salus sensor', error);
      await this.setUnavailable(error.message);
    }
  }
}

module.exports = SalusSensorDevice;
