'use strict';

const SalusDeviceBase = require('../../lib/salus-device-base');

const ONOFF_CONFIRM_TIMEOUT_MS = 30 * 1000;

function readProps(device) {
  return device?._shadow_properties || {};
}

function readOnOff(device) {
  const value = readProps(device)['ep9:sOnOffS:OnOff'];
  return typeof value === 'number' ? value === 1 : null;
}

/** Metering values are self-describing: raw * Multiplier / Divisor = kW resp. kWh. */
function readMeterScale(props) {
  const multiplier = props['ep9:sMeterS:Multiplier'];
  const divisor = props['ep9:sMeterS:Divisor'];
  return {
    multiplier: typeof multiplier === 'number' && multiplier > 0 ? multiplier : 1,
    divisor: typeof divisor === 'number' && divisor > 0 ? divisor : 10000,
  };
}

function readPowerWatt(device) {
  const props = readProps(device);
  const raw = props['ep9:sMeterS:DemandDelivered_x10k'];
  if (typeof raw !== 'number') return null;
  const { multiplier, divisor } = readMeterScale(props);
  return (raw * multiplier / divisor) * 1000;
}

function readEnergyKwh(device) {
  const props = readProps(device);
  const low = props['ep9:sMeterS:SummationDeliveredL_x10k'];
  if (typeof low !== 'number') return null;
  const high = typeof props['ep9:sMeterS:SummationDeliveredH_x10k'] === 'number'
    ? props['ep9:sMeterS:SummationDeliveredH_x10k']
    : 0;
  const { multiplier, divisor } = readMeterScale(props);
  // Zigbee summation is split into 32-bit words.
  return (high * 4294967296 + low) * multiplier / divisor;
}

function readVoltage(device) {
  const value = readProps(device)['ep9:sPowerS:MainsVoltage_x10'];
  return typeof value === 'number' ? value / 10 : null;
}

class SalusPlugDevice extends SalusDeviceBase {
  async onInit() {
    const { email, password } = await this.connectClient();
    this._pendingOnOff = null;
    this._pendingOnOffUntil = 0;

    this.registerCapabilityListener('onoff', async (value) => {
      const deviceCode = this.getSetting('device_code');
      if (!deviceCode) {
        throw new Error('Missing Salus device code');
      }
      this._pendingOnOff = value;
      this._pendingOnOffUntil = Date.now() + ONOFF_CONFIRM_TIMEOUT_MS;
      await this.client.setOnOff(deviceCode, value, this.getData().shadow_device_index || undefined);
      await this.refreshSoon();
    });

    await this.startPolling(email, password);
  }

  async applyCloudSnapshot(own) {
    const onoff = readOnOff(own);
    if (typeof onoff === 'boolean') {
      const hasPending = Date.now() < this._pendingOnOffUntil && typeof this._pendingOnOff === 'boolean';
      if (hasPending && onoff !== this._pendingOnOff) {
        // Keep the optimistic value until the cloud confirms or the window expires.
        await this.setCapabilityValue('onoff', this._pendingOnOff);
      } else {
        this._pendingOnOff = null;
        this._pendingOnOffUntil = 0;
        await this.setCapabilityValue('onoff', onoff);
      }
    }

    // Metering capabilities are added when first reported, so plug models
    // without metering never show empty tiles.
    const metered = [
      ['measure_power', readPowerWatt(own)],
      ['meter_power', readEnergyKwh(own)],
      ['measure_voltage', readVoltage(own)],
    ];
    for (const [capability, value] of metered) {
      if (typeof value !== 'number') continue;
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
      await this.setCapabilityValue(capability, value);
    }
  }
}

module.exports = SalusPlugDevice;
