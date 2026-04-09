'use strict';

const Homey = require('homey');

class SalusCloudApp extends Homey.App {
  async onInit() {
    this.log('Salus Cloud app initialized');
  }
}

module.exports = SalusCloudApp;
