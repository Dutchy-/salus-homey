'use strict';

const Homey = require('homey');
const SalusCloudClient = require('../../lib/salus-cloud-client');

const POLL_INTERVAL_MS = 60 * 1000;

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

  // Fallback: some models expose humidity in non-standard shadow keys.
  for (const [key, value] of Object.entries(props)) {
    if (/humidity/i.test(key) && typeof value === 'number') {
      return value > 100 ? value / 100 : value;
    }
  }

  // Fallbacks outside shadow data, based on Home Assistant integration patterns.
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

class SalusSensorDevice extends Homey.Device {
  async onInit() {
    this.client = new SalusCloudClient({
      email: this.getSetting('email'),
      password: this.getSetting('password'),
    });

    this.pollInterval = this.homey.setInterval(async () => {
      await this.syncFromCloud();
    }, POLL_INTERVAL_MS);

    await this.syncFromCloud();
  }

  async onDeleted() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async syncFromCloud() {
    try {
      const allDevices = await this.client.getAllDevices();
      const own = allDevices.find((device) => {
        const id = String(device.id || device.device_id || device.device_code || '');
        return id === String(this.getData().id);
      });

      if (!own) {
        throw new Error('Cloud device not found for paired Homey device');
      }

      const temperature = readTemperature(own);
      const humidity = readHumidity(own);

      if (typeof temperature === 'number') {
        await this.setCapabilityValue('measure_temperature', temperature);
      }
      if (typeof humidity === 'number') {
        await this.setCapabilityValue('measure_humidity', humidity);
      }

      await this.setAvailable();
    } catch (error) {
      this.error('Failed syncing Salus sensor', error);
      await this.setUnavailable(error.message);
    }
  }
}

module.exports = SalusSensorDevice;
