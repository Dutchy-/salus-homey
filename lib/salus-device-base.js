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
        throw new Error('Cloud device not found for paired Homey device');
      }
      await this.applyCloudSnapshot(own);
      await this.setAvailable();
    } catch (error) {
      this.error('Failed syncing Salus device', error);
      await this.setUnavailable(error.message);
    }
  }

  /** Subclasses map the cloud device (with _shadow_properties) to capabilities. */
  async applyCloudSnapshot(cloudDevice) {
    throw new Error(`applyCloudSnapshot not implemented for ${this.constructor.name}: ${cloudDevice?.device_code}`);
  }
}

module.exports = SalusDeviceBase;
