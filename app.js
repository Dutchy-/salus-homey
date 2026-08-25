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

  /**
   * Persist auth telemetry to app settings so token handling can be verified
   * on an installed app via the Homey developer tools (no attached console).
   */
  _recordAuthEvent(label, event) {
    const expiresIso = event.tokenExpiresAt ? new Date(event.tokenExpiresAt).toISOString() : 'n/a';
    this.log(`[auth] ${label}: ${event.type}${event.detail ? ` (${event.detail})` : ''}, token valid until ${expiresIso}`);

    try {
      const stats = this.homey.settings.get('auth_stats') || {};
      const entry = stats[label] || { counts: {}, lastByType: {} };
      entry.counts[event.type] = (entry.counts[event.type] || 0) + 1;
      entry.lastByType[event.type] = new Date(event.at).toISOString();
      entry.lastEvent = event.type;
      entry.lastDetail = event.detail || null;
      entry.tokenExpiresAt = expiresIso;
      stats[label] = entry;
      this.homey.settings.set('auth_stats', stats);
    } catch (error) {
      this.error('Failed persisting auth stats', error);
    }
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
      const label = normalizedEmail || 'unknown-account';
      account = {
        key,
        label,
        client: new SalusCloudClient({
          email,
          password,
          onAuthEvent: (event) => this._recordAuthEvent(label, event),
        }),
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
