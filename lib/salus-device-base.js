'use strict';

const Homey = require('homey');
const SalusCloudClient = require('./salus-cloud-client');

/**
 * Shared behavior for all Salus device types: credential storage (with the
 * legacy settings migration), client creation with auth telemetry, shared
 * polling registration and the snapshot sync skeleton. Subclasses implement
 * applyCloudSnapshot(cloudDevice) with their capability mapping.
 */
class SalusDeviceBase extends Homey.Device {
  /**
   * Credentials live in the device store. Devices paired before this existed
   * kept them in settings; migrate once, then purge the plaintext password.
   */
  async getCredentials() {
    let email = this.getStoreValue('salus_email');
    let password = this.getStoreValue('salus_password');

    if (!password) {
      const legacyEmail = this.getSetting('email');
      const legacyPassword = this.getSetting('password');
      if (legacyPassword) {
        await this.setStoreValue('salus_email', legacyEmail);
        await this.setStoreValue('salus_password', legacyPassword);
        email = legacyEmail;
        password = legacyPassword;
      }
    }

    // Purge plaintext whenever a legacy password lingers in settings and the
    // store copy is confirmed readable — retried every init until it succeeds.
    if (this.getSetting('password') && this.getStoreValue('salus_password')) {
      await this.setSettings({ password: '' }).catch((error) => {
        this.error('Could not blank legacy password setting', error);
      });
    }

    return { email, password };
  }

  _createClient(email, password) {
    return new SalusCloudClient({
      email,
      password,
      onAuthEvent: (event) => {
        const label = `${String(email || '').trim().toLowerCase()} [${this.getName()}]`;
        if (typeof this.homey.app?._recordAuthEvent === 'function') {
          this.homey.app._recordAuthEvent(label, event);
        } else {
          this.log(`[auth] ${event.type}`);
        }
      },
      onWriteError: ({ deviceCode, propertyKeys, message }) => {
        this.error(`[write-failed] ${propertyKeys.join(',')} on ${String(deviceCode).slice(-12)}: ${message}`);
      },
    });
  }

  /** Resolve credentials and create the cloud client. Call first in onInit. */
  async connectClient() {
    const { email, password } = await this.getCredentials();
    this._credentials = { email, password };
    this.client = this._createClient(email, password);
    return { email, password };
  }

  /** Register for shared polling. Call last in onInit. */
  async startPolling(email, password) {
    if (typeof this.homey.app?.registerDeviceForSharedPolling === 'function') {
      await this.homey.app.registerDeviceForSharedPolling(this, email, password);
      await this.refreshSoon(0);
    } else {
      await this.syncFromCloud();
    }
  }

  /** Called from the repair flow after the new credentials validated against Salus cloud. */
  async applyNewCredentials(email, password) {
    await this.setStoreValue('salus_email', email);
    await this.setStoreValue('salus_password', password);

    if (typeof this.homey.app?.unregisterDeviceFromSharedPolling === 'function') {
      this.homey.app.unregisterDeviceFromSharedPolling(this);
    }
    this.client = this._createClient(email, password);
    if (typeof this.homey.app?.registerDeviceForSharedPolling === 'function') {
      await this.homey.app.registerDeviceForSharedPolling(this, email, password);
    }
    await this.setAvailable().catch(() => {});
    await this.refreshSoon(0);
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

  async onDeleted() {
    if (typeof this.homey.app?.unregisterDeviceFromSharedPolling === 'function') {
      this.homey.app.unregisterDeviceFromSharedPolling(this);
    }
  }

  matchesCloudDevice(device) {
    const pairedId = String(this.getData().id);
    const candidates = [device.id, device.device_id, device.device_code]
      .filter((v) => v != null && v !== '')
      .map(String);
    return candidates.includes(pairedId);
  }

  async syncFromCloud() {
    try {
      const allDevices = await this.client.getAllDevices();
      await this.syncFromSnapshot(allDevices);
    } catch (error) {
      this.error('Failed syncing Salus device', error);
      await this.setUnavailable(error.message);
    }
  }

  async syncFromSnapshot(allDevices) {
    try {
      const own = allDevices.find((device) => this.matchesCloudDevice(device));
      if (!own) {
        const codes = allDevices
          .map((device) => String(device.device_code || device.id || '').slice(-12))
          .filter(Boolean);
        this.error(`[not-found] paired id ${this.getData().id}; cloud returned ${codes.length} device(s): ${codes.join(', ')}`);
        throw new Error('Cloud device not found for paired Homey device');
      }
      if (!this._fingerprintLogged) {
        this._fingerprintLogged = true;
        this._logDeviceFingerprint(own);
      }
      this._trackOnlineStatus(own);
      await this.applyCloudSnapshot(own);
      await this.setAvailable();
    } catch (error) {
      this.error('Failed syncing Salus device', error);
      await this.setUnavailable(error.message);
    }
  }

  /**
   * One line per device per app run with model, firmware and the full shadow
   * property key list, so diagnostic reports reveal hardware variants.
   */
  _logDeviceFingerprint(cloudDevice) {
    const props = cloudDevice._shadow_properties || {};
    const bySuffix = (suffix) => {
      for (const key of Object.keys(props)) {
        if (key.endsWith(suffix)) return props[key];
      }
      return undefined;
    };
    const model = cloudDevice.model || bySuffix(':sBasicS:ModelIdentifier') || 'unknown';
    const firmware = bySuffix(':sZDO:FirmwareVersion') || 'unknown';
    const keys = Object.keys(props).sort();
    this.log(`[fingerprint] model=${model} fw=${firmware} properties(${keys.length})=${keys.join(',')}`);
  }

  /** Log gateway<->device reachability transitions; explains frozen values. */
  _trackOnlineStatus(cloudDevice) {
    const props = cloudDevice._shadow_properties || {};
    const online = props['ep9:sZDOInfo:OnlineStatus_i'] ?? props['ep8:sZDOInfo:OnlineStatus_i'];
    if (typeof online !== 'number') return;
    if (this._lastOnlineStatus !== undefined && this._lastOnlineStatus !== online) {
      this.log(`[online] OnlineStatus_i ${this._lastOnlineStatus} -> ${online}${online === 0 ? ' (gateway lost contact with device)' : ''}`);
    }
    this._lastOnlineStatus = online;
  }

  /**
   * Update a boolean capability and fire started/stopped flow triggers on
   * transitions. The first-ever value never triggers, so an app restart
   * cannot fire flows for a state that was already in effect.
   */
  async _updateActiveState(capability, active, startedTrigger, stoppedTrigger, tokens) {
    if (!this.hasCapability(capability)) {
      await this.addCapability(capability);
    }
    const previous = this.getCapabilityValue(capability);
    if (previous === active) {
      return;
    }
    await this.setCapabilityValue(capability, active);
    if (previous === null || previous === undefined) {
      return;
    }
    const card = active ? startedTrigger : stoppedTrigger;
    if (card) {
      await card.trigger(this, tokens || {}).catch(this.error);
    }
  }

  /** Subclasses map the cloud device (with _shadow_properties) to capabilities. */
  async applyCloudSnapshot(cloudDevice) {
    throw new Error(`applyCloudSnapshot not implemented for ${this.constructor.name}: ${cloudDevice?.device_code}`);
  }
}

module.exports = SalusDeviceBase;
