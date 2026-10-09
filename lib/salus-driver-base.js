'use strict';

const Homey = require('homey');
const SalusCloudClient = require('./salus-cloud-client');

/**
 * Shared pairing and repair flow for all Salus drivers. Subclasses implement
 * filterPairableDevice(cloudDevice) and buildPairingSettings(cloudDevice).
 */
class SalusDriverBase extends Homey.Driver {
  /** Credentials from any already-paired Salus device, so pairing more devices skips the login. */
  _findStoredCredentials() {
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        const email = device.getStoreValue('salus_email');
        const password = device.getStoreValue('salus_password');
        if (email && password) {
          return { email, password };
        }
      }
    }
    return null;
  }

  async onPair(session) {
    let credentials = null;

    // The flow starts on a loading spinner; decide there whether stored
    // credentials from an already-paired device let us skip the login view.
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'loading' || credentials) {
        return;
      }
      const stored = this._findStoredCredentials();
      if (stored) {
        try {
          const client = new SalusCloudClient(stored);
          await client.ensureAuth();
          credentials = stored;
          await session.showView('list_devices');
          return;
        } catch (error) {
          this.log('Stored credentials rejected, asking for login', error.message);
        }
      }
      await session.showView('login_credentials');
    });

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
      const pairable = devices.filter((device) => this.filterPairableDevice(device));
      this.log(`[pair] ${pairable.length} of ${devices.length} cloud device(s) pairable`);
      this._logUnrecognizedDevices(devices);

      return pairable
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

  /**
   * A device no driver accepts never gets paired, so it never logs a
   * fingerprint either. Log its model and shadow property keys during
   * pairing so a diagnostic report sent after an empty list shows what the
   * unsupported device reports.
   */
  _logUnrecognizedDevices(cloudDevices) {
    try {
      const drivers = Object.values(this.homey.drivers.getDrivers());
      for (const device of cloudDevices) {
        const keys = Object.keys(device._shadow_properties || {}).sort();
        if (keys.some((key) => key.startsWith('ep0:sGateway:'))) continue;
        if (drivers.some((driver) => driver.filterPairableDevice?.(device))) continue;
        const model = readModelIdentifier(device) || 'unknown';
        const category = device.category?.name || 'unknown';
        const sources = (device._shadow_property_sources || []).join(',') || 'none';
        this.log(`[unrecognized] model=${model} category=${category} sources=${sources} properties(${keys.length})=${keys.join(',')}`);
      }
    } catch (error) {
      // Diagnostics must never break pairing.
      this.error('Failed logging unrecognized devices', error);
    }
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
