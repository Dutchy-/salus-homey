'use strict';

const { SalusDriverBase } = require('../../lib/salus-driver-base');

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

class SalusSensorDriver extends SalusDriverBase {
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

  filterPairableDevice(device) {
    return hasDayOneSensors(device);
  }

  buildPairingSettings(device) {
    return {
      device_model: device.model || 'SQ610',
      device_family: 'Quantum Thermostat (SQ610RF/SQ610)',
      device_code: device.device_code || '',
    };
  }
}

module.exports = SalusSensorDriver;
