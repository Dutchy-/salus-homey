'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const SalusCloudClient = require('./lib/salus-cloud-client');

const POLL_INTERVAL_MS = 60 * 1000;

class SalusCloudApp extends Homey.App {
  async onInit() {
    this._accounts = new Map();
    this.log('Salus Cloud app initialized');
  }

  _accountKey(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const raw = `${normalizedEmail}|${String(password || '')}`;
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  _getOrCreateAccount(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const key = this._accountKey(email, password);
    let account = this._accounts.get(key);
    if (!account) {
      account = {
        key,
        label: normalizedEmail || 'unknown-account',
        client: new SalusCloudClient({ email, password }),
        devices: new Set(),
        pollTimer: null,
        inFlight: null,
        refreshRequested: false,
      };
      this._accounts.set(key, account);
    }
    return account;
  }

  async registerDeviceForSharedPolling(device, email, password) {
    if (!email || !password) {
      throw new Error('Missing Salus credentials for shared polling');
    }
    const account = this._getOrCreateAccount(email, password);
    account.devices.add(device);
    device._schedulerAccountKey = account.key;

    if (!account.pollTimer) {
      account.pollTimer = this.homey.setInterval(() => {
        this.refreshAccountByKey(account.key).catch((error) => {
          this.error(`Shared poll failed for ${account.label}`, error);
        });
      }, POLL_INTERVAL_MS);
    }
  }

  unregisterDeviceFromSharedPolling(device) {
    const key = device?._schedulerAccountKey;
    if (!key) return;

    const account = this._accounts.get(key);
    if (!account) return;

    account.devices.delete(device);
    device._schedulerAccountKey = null;

    if (!account.devices.size) {
      if (account.pollTimer) {
        this.homey.clearInterval(account.pollTimer);
      }
      this._accounts.delete(key);
    }
  }

  async requestDeviceRefresh(device, delayMs = 0) {
    const key = device?._schedulerAccountKey;
    if (!key) return;
    const account = this._accounts.get(key);
    if (!account) return;

    account.refreshRequested = true;

    this.homey.setTimeout(() => {
      this.refreshAccountByKey(key).catch((error) => {
        const current = this._accounts.get(key);
        const label = current?.label || 'unknown-account';
        this.error(`Shared refresh failed for ${label}`, error);
      });
    }, Math.max(0, delayMs));
  }

  async refreshAccountByKey(key) {
    const account = this._accounts.get(key);
    if (!account) return;

    if (account.inFlight) {
      account.refreshRequested = true;
      await account.inFlight;
      if (account.refreshRequested) {
        return this.refreshAccountByKey(key);
      }
      return;
    }

    account.inFlight = (async () => {
      account.refreshRequested = false;
      const allDevices = await account.client.getAllDevices();
      await Promise.all(
        [...account.devices].map(async (device) => {
          try {
            await device.syncFromSnapshot(allDevices);
          } catch (error) {
            this.error(`Shared sync failed for device ${device.getName?.() || 'unknown'}`, error);
          }
        }),
      );
    })();

    try {
      await account.inFlight;
    } finally {
      account.inFlight = null;
    }

    if (account.refreshRequested) {
      await this.refreshAccountByKey(key);
    }
  }
}

module.exports = SalusCloudApp;
