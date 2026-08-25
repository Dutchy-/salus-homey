'use strict';

const Homey = require('homey');
const SalusCloudClient = require('../../lib/salus-cloud-client');

function hasDayOneSensors(device) {
  const props = device?._shadow_properties || {};
  const hasTemp =
    typeof props['ep9:sIT600TH:LocalTemperature_x100'] === 'number' ||
    typeof props['ep9:sHT:LocalTemperature_x100'] === 'number';
  const hasHumidity =
    typeof props['ep9:sIT600TH:LocalHumidity'] === 'number' ||
    typeof props['ep9:sHT:LocalHumidity'] === 'number' ||
    typeof props['ep9:sIT600TH:LocalHumidity_x100'] === 'number' ||
    typeof props['ep9:sHT:LocalHumidity_x100'] === 'number' ||
    typeof props['ep9:sIT600TH:SunnySetpoint_x100'] === 'number';
  const hasSetpoint =
    typeof props['ep9:sIT600TH:HeatingSetpoint_x100'] === 'number' ||
    typeof props['ep9:sHT:HeatingSetpoint_x100'] === 'number';
  return hasTemp || hasHumidity || hasSetpoint;
}

class SalusSensorDriver extends Homey.Driver {
  async onInit() {
    this.heatingStartedTrigger = this.homey.flow.getDeviceTriggerCard('heating_started');
    this.heatingStoppedTrigger = this.homey.flow.getDeviceTriggerCard('heating_stopped');
    this.coolingStartedTrigger = this.homey.flow.getDeviceTriggerCard('cooling_started');
    this.coolingStoppedTrigger = this.homey.flow.getDeviceTriggerCard('cooling_stopped');

    this.homey.flow
      .getConditionCard('is_heating')
      .registerRunListener(async (args) => args.device.getCapabilityValue('salus_heating_active') === true);
    this.homey.flow
      .getConditionCard('is_cooling')
      .registerRunListener(async (args) => args.device.getCapabilityValue('salus_cooling_active') === true);

    this.homey.flow
      .getActionCard('resume_schedule')
      .registerRunListener(async (args) => {
        await args.device.applyHoldMode('schedule');
        return true;
      });

    this.log('Salus sensor driver initialized');
  }

  async onPair(session) {
    let credentials = null;

    session.setHandler('login', async (data = {}) => {
      const email = (data.username || '').trim();
      const password = data.password || '';
      if (!email || !password) {
        throw new Error('Email and password are required');
      }

      const client = new SalusCloudClient({ email, password });
      // Validate login early so list_devices can run directly.
      await client.ensureAuth();
      credentials = { email, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!credentials) {
        throw new Error('Please enter credentials first');
      }

      const client = new SalusCloudClient(credentials);
      const devices = await client.getAllDevices();

      return devices
        .filter(hasDayOneSensors)
        .map((device) => {
          const dataId = device.id || device.device_id || device.device_code;
          const name = device.name || device.dashboard_attributes?.name || dataId;
          if (!dataId) return null;

          const data = { id: String(dataId) };
          if (device._shadow_device_index != null && String(device._shadow_device_index) !== '') {
            data.shadow_device_index = String(device._shadow_device_index);
          }

          return {
            name,
            data,
            icon: '/icon.svg',
            // Credentials live in the device store, not settings, so they are
            // not exposed through the settings UI or developer tools.
            store: {
              salus_email: credentials.email,
              salus_password: credentials.password,
            },
            settings: {
              email: credentials.email,
              device_model: device.model || 'SQ610',
              device_family: 'Quantum Thermostat (SQ610RF/SQ610)',
              device_code: device.device_code || '',
            },
          };
        })
        .filter(Boolean);
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data = {}) => {
      const email = (data.username || '').trim();
      const password = data.password || '';
      if (!email || !password) {
        throw new Error('Email and password are required');
      }

      // Validate against Salus cloud before storing anything.
      const client = new SalusCloudClient({ email, password });
      await client.ensureAuth();

      await device.applyNewCredentials(email, password);
      return true;
    });
  }
}

module.exports = SalusSensorDriver;
