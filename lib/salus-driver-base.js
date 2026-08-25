'use strict';

const Homey = require('homey');
const SalusCloudClient = require('./salus-cloud-client');

/**
 * Shared pairing and repair flow for all Salus drivers. Subclasses implement
 * filterPairableDevice(cloudDevice) and buildPairingSettings(cloudDevice).
 */
class SalusDriverBase extends Homey.Driver {
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
        .filter((device) => this.filterPairableDevice(device))
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
              ...this.buildPairingSettings(device),
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

  filterPairableDevice(cloudDevice) {
    throw new Error(`filterPairableDevice not implemented for ${this.constructor.name}: ${cloudDevice?.device_code}`);
  }

  buildPairingSettings(cloudDevice) {
    throw new Error(`buildPairingSettings not implemented for ${this.constructor.name}: ${cloudDevice?.device_code}`);
  }
}

/** Model from gateway item metadata or the device shadow, e.g. "SQ610RFNH". */
function readModelIdentifier(cloudDevice) {
  const props = cloudDevice?._shadow_properties || {};
  return (
    cloudDevice?.model ||
    props['ep9:sBasicS:ModelIdentifier'] ||
    props['ep8:sBasicS:ModelIdentifier'] ||
    ''
  );
}

module.exports = { SalusDriverBase, readModelIdentifier };
