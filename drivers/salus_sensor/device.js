'use strict';

const SalusDeviceBase = require('../../lib/salus-device-base');

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
const HOLD_MODE_TYPES = { schedule: 0, hold: 2, standby: 7 };
const HOLD_MODE_CONFIRM_TIMEOUT_MS = 30 * 1000;
const LAST_ACTIVE_HOLD_MODE_STORE_KEY = 'last_active_hold_mode';

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

function readBatteryPercentage(device) {
  const props = device?._shadow_properties || {};
  const level = props['ep9:sIT600TH:BatteryLevel'] ?? props['ep9:sHT:BatteryLevel'];
  if (typeof level === 'number') {
    // BatteryLevel is the Zigbee 0-5 scale (5 = full).
    return Math.max(0, Math.min(100, level * 20));
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

  const strongActiveMode = readStrongActiveMode(device);
  if (strongActiveMode) return strongActiveMode;

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

class SalusSensorDevice extends SalusDeviceBase {
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

  /** Remember the last non-standby mode so the onoff toggle can restore it. */
  async _rememberActiveHoldMode(mode) {
    if (mode !== 'schedule' && mode !== 'hold') return;
    if (this._lastActiveHoldMode === mode) return;
    this._lastActiveHoldMode = mode;
    await this.setStoreValue(LAST_ACTIVE_HOLD_MODE_STORE_KEY, mode);
  }

  async getRememberedActiveHoldMode() {
    const stored = this._lastActiveHoldMode ?? (await this.getStoreValue(LAST_ACTIVE_HOLD_MODE_STORE_KEY));
    return stored === 'schedule' || stored === 'hold' ? stored : 'hold';
  }

  async _setHoldModeOptimistic(mode) {
    this._pendingHoldMode = mode;
    this._pendingHoldModeUntil = Date.now() + HOLD_MODE_CONFIRM_TIMEOUT_MS;
    if (this.hasCapability('salus_hold_mode')) {
      await this.setCapabilityValue('salus_hold_mode', mode);
    }
  }

  /**
   * Shared write path for the preset picker, the resume-schedule flow action
   * and (indirectly) the onoff toggle. Maps mode to Salus HoldType.
   */
  async applyHoldMode(mode) {
    const holdType = HOLD_MODE_TYPES[mode];
    if (holdType === undefined) {
      throw new Error(`Unknown hold mode: ${mode}`);
    }
    const deviceCode = this.getSetting('device_code');
    if (!deviceCode) {
      throw new Error('Missing Salus device code');
    }
    const shadowIndex = this.getData().shadow_device_index || undefined;

    await this.client.setHoldMode(deviceCode, holdType, shadowIndex);

    if (mode === 'standby') {
      await this.applyLocalOnOff(false);
    } else {
      if (mode === 'hold' && this._lastOnOff === false) {
        // Waking from standby into hold restores the previous setpoint,
        // matching the onoff toggle. Schedule mode sets its own target.
        const rememberedTarget = (await this.getRememberedTargetTemperature()) ?? DEFAULT_RESTORE_TARGET_C;
        await this.client.setTemperature(
          deviceCode,
          rememberedTarget,
          shadowIndex,
          this._lastActiveThermostatMode || null,
        );
        this._pendingTargetTemperature = rememberedTarget;
        this._pendingTargetUntil = Date.now() + TARGET_CONFIRM_TIMEOUT_MS;
        await this.setCapabilityValue('target_temperature', rememberedTarget);
      }
      await this.applyLocalOnOff(true);
    }

    // After applyLocalOnOff so its hold/standby guess is overridden by the real mode.
    await this._setHoldModeOptimistic(mode);
    await this._rememberActiveHoldMode(mode);
    await this.refreshSoon();
  }

  async applyLocalOnOff(onoff) {
    this._pendingOnOff = onoff;
    this._pendingOnOffUntil = Date.now() + ONOFF_CONFIRM_TIMEOUT_MS;
    this._lastOnOff = onoff;
    if (this.hasCapability('onoff')) {
      await this.setCapabilityValue('onoff', onoff);
    }
    await this._setHoldModeOptimistic(onoff ? 'hold' : 'standby');
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
    const { email, password } = await this.getCredentials();
    this._credentials = { email, password };
    this.client = this._createClient(email, password);
    this._targetTempOptsKey = null;
    this._pendingTargetTemperature = null;
    this._pendingTargetUntil = 0;
    this._pendingOnOff = null;
    this._pendingOnOffUntil = 0;
    this._pendingHoldMode = null;
    this._pendingHoldModeUntil = 0;
    this._lastActiveHoldMode = null;
    this._lastOnOff = null;
    this._lastThermostatMode = null;
    this._lastActiveThermostatMode = null;

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
      } else {
        // Any setpoint change puts the thermostat into permanent hold.
        await this._setHoldModeOptimistic('hold');
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
      if (value) {
        // Resume whatever the thermostat was doing before standby (default: hold).
        await this.applyHoldMode(await this.getRememberedActiveHoldMode());
      } else {
        await this.applyHoldMode('standby');
      }
    });

    // Heat/cool comes from a separate heatpump controller app, so this capability is reflection-only here.
    this.registerCapabilityListener('thermostat_mode', async () => {
      throw new Error('Heatpump mode is read-only in this app and managed by your separate heatpump integration.');
    });

    this.registerCapabilityListener('salus_hold_mode', async (value) => {
      await this.applyHoldMode(value);
    });

    await this.startPolling(email, password);
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

  async applyCloudSnapshot(own) {
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

    // Battery only exists on battery-powered models (SQ610RF); wired SQ610
    // never reports BatteryLevel, so the capability is added when first seen.
    const batteryPercentage = readBatteryPercentage(own);
    if (typeof batteryPercentage === 'number') {
      if (!this.hasCapability('measure_battery')) {
        await this.addCapability('measure_battery');
      }
      if (!this.hasCapability('alarm_battery')) {
        await this.addCapability('alarm_battery');
      }
      await this.setCapabilityValue('measure_battery', batteryPercentage);
      await this.setCapabilityValue('alarm_battery', batteryPercentage <= 20);
    }

    const holdMode = readHoldMode(own);
    if (holdMode) {
      if (!this.hasCapability('salus_hold_mode')) {
        await this.addCapability('salus_hold_mode');
      }
      const pendingHoldModeBefore = this._pendingHoldMode;
      const hasPendingHoldMode = Date.now() < this._pendingHoldModeUntil && this._pendingHoldMode;
      if (hasPendingHoldMode) {
        if (holdMode === this._pendingHoldMode) {
          this._pendingHoldMode = null;
          this._pendingHoldModeUntil = 0;
          await this.setCapabilityValue('salus_hold_mode', holdMode);
        } else {
          // Keep the optimistic value until the cloud confirms or the window expires.
          await this.setCapabilityValue('salus_hold_mode', this._pendingHoldMode);
        }
      } else {
        this._pendingHoldMode = null;
        this._pendingHoldModeUntil = 0;
        await this.setCapabilityValue('salus_hold_mode', holdMode);
      }
      // Track cloud-confirmed active modes too, so changes made in the
      // Salus app itself are what the onoff toggle later restores. Skip
      // stale cloud values while an optimistic change is still pending.
      if (!hasPendingHoldMode || holdMode === pendingHoldModeBefore) {
        await this._rememberActiveHoldMode(holdMode);
      }
    }

    // Active heating/cooling from RunningState (1 = heating, 2 = cooling).
    if (typeof runningState === 'number') {
      await this._updateActiveState(
        'salus_heating_active',
        runningState === 1,
        this.driver.heatingStartedTrigger,
        this.driver.heatingStoppedTrigger,
      );
      await this._updateActiveState(
        'salus_cooling_active',
        runningState === 2,
        this.driver.coolingStartedTrigger,
        this.driver.coolingStoppedTrigger,
      );
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
    if (this.hasCapability('thermostat_mode')) {
      let effectiveMode = thermostatMode;
      // Fall back to the remembered mode when cloud flags are ambiguous (on, idle, no mapping).
      if (!effectiveMode && onoff && runningState === 0 && this._lastActiveThermostatMode) {
        effectiveMode = this._lastActiveThermostatMode;
      }

      if (effectiveMode) {
        this._lastThermostatMode = effectiveMode;
        if (effectiveMode === 'heat' || effectiveMode === 'cool') {
          this._lastActiveThermostatMode = effectiveMode;
        }
        await this.setCapabilityValue('thermostat_mode', effectiveMode);
      }
      if (strongActiveMode) {
        this._lastActiveThermostatMode = strongActiveMode;
      }
    }
  }
}

module.exports = SalusSensorDevice;
