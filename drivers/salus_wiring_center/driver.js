'use strict';

const { SalusDriverBase } = require('../../lib/salus-driver-base');

class SalusWiringCenterDriver extends SalusDriverBase {
  async onInit() {
    this.pumpOnTrigger = this.homey.flow.getDeviceTriggerCard('pump_output_on');
    this.pumpOffTrigger = this.homey.flow.getDeviceTriggerCard('pump_output_off');
    this.boilerOnTrigger = this.homey.flow.getDeviceTriggerCard('boiler_output_on');
    this.boilerOffTrigger = this.homey.flow.getDeviceTriggerCard('boiler_output_off');
    this.zoneActivatedTrigger = this.homey.flow.getDeviceTriggerCard('zone_activated');
    this.zoneDeactivatedTrigger = this.homey.flow.getDeviceTriggerCard('zone_deactivated');

    this.homey.flow
      .getConditionCard('is_pump_output_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('salus_pump_output') === true);
    this.homey.flow
      .getConditionCard('is_boiler_output_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('salus_boiler_output') === true);

    this.log('Salus wiring center driver initialized');
  }

  filterPairableDevice(device) {
    // Wiring centers are recognized by their zone-control cluster, so all
    // models (CB12RF, KL08RF, ...) qualify without a model list.
    const props = device?._shadow_properties || {};
    return typeof props['ep8:sIT6ZB:PumpOutput'] === 'number'
      || typeof props['ep9:sIT6ZB:PumpOutput'] === 'number';
  }

  buildPairingSettings(device) {
    return {
      device_model: device.model || 'CB12RF',
      device_code: device.device_code || '',
    };
  }
}

module.exports = SalusWiringCenterDriver;
