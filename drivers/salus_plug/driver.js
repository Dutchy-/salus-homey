'use strict';

const { SalusDriverBase, readModelIdentifier } = require('../../lib/salus-driver-base');

/**
 * Actual plugs only: SPE600 and its SP600 sibling. The SR600 wall relay
 * shares the OnOff cluster but is not a plug — it should get its own driver
 * (different class and imagery) if anyone asks for it.
 */
const PLUG_MODEL_PREFIXES = ['SPE600', 'SP600'];

class SalusPlugDriver extends SalusDriverBase {
  async onInit() {
    this.log('Salus plug driver initialized');
  }

  filterPairableDevice(device) {
    const model = String(readModelIdentifier(device));
    return PLUG_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
  }

  buildPairingSettings(device) {
    return {
      device_model: device.model || 'SPE600',
      device_code: device.device_code || '',
    };
  }
}

module.exports = SalusPlugDriver;
