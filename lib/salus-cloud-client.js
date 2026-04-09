'use strict';

const fetch = require('node-fetch');
const {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} = require('amazon-cognito-identity-js');

const AWS_USER_POOL_ID = 'eu-central-1_XGRz3CgoY';
const AWS_CLIENT_ID = '4pk5efh3v84g5dav43imsv4fbj';
const COMPANY_CODE = 'salus-eu';
const SERVICE_API_BASE_URL = 'https://service-api.eu.premium.salusconnect.io/api/v1';

class SalusCloudClient {
  constructor({ email, password }) {
    this.email = email;
    this.password = password;
    this.accessToken = null;
    this.idToken = null;
    this.tokenExpiresAt = 0;
  }

  async authenticate() {
    const userPool = new CognitoUserPool({
      UserPoolId: AWS_USER_POOL_ID,
      ClientId: AWS_CLIENT_ID,
    });

    const cognitoUser = new CognitoUser({
      Username: this.email,
      Pool: userPool,
    });

    const authDetails = new AuthenticationDetails({
      Username: this.email,
      Password: this.password,
    });

    const result = await new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: resolve,
        onFailure: reject,
        mfaRequired: () => reject(new Error('MFA is not supported by this app yet')),
      });
    });

    this.accessToken = result.getAccessToken().getJwtToken();
    this.idToken = result.getIdToken().getJwtToken();
    this.tokenExpiresAt = Date.now() + 2.5 * 60 * 60 * 1000;
  }

  async ensureAuth() {
    if (!this.accessToken || Date.now() > this.tokenExpiresAt) {
      await this.authenticate();
    }
  }

  async request(method, endpoint, body) {
    await this.ensureAuth();

    const response = await fetch(`${SERVICE_API_BASE_URL}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken,
        'x-auth-token': this.idToken,
        'x-company-code': COMPANY_CODE,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Salus API ${response.status}: ${text}`);
    }

    return response.json();
  }

  async getGateways() {
    const response = await this.request('GET', '/occupants/slider_list');
    const data = Array.isArray(response?.data) ? response.data : [];
    return data.filter((entry) => entry?.type === 'gateway');
  }

  async getGatewayDetails(gatewayId) {
    const response = await this.request('GET', `/occupants/slider_details?id=${gatewayId}&type=gateway`);
    return response?.data || {};
  }

  async getDeviceShadows(deviceCodes) {
    if (!deviceCodes.length) {
      return {};
    }

    const response = await this.request('POST', '/devices/device_shadows', {
      request_id: 'homey-request',
      device_codes: deviceCodes,
    });

    const successList = response?.data?.success_list || [];
    const shadows = {};
    for (const item of successList) {
      if (!item?.device_code || !item?.payload) {
        continue;
      }
      try {
        shadows[item.device_code] = JSON.parse(item.payload);
      } catch (error) {
        // Ignore malformed shadow payloads and keep parsing others.
      }
    }

    return shadows;
  }

  async getAllDevices() {
    const gateways = await this.getGateways();
    const devices = [];
    const deviceCodes = [];

    for (const gateway of gateways) {
      const gatewayId = gateway?.id;
      if (!gatewayId) continue;

      const details = await this.getGatewayDetails(gatewayId);
      const items = Array.isArray(details?.items) ? details.items : [];

      for (const item of items) {
        if (!item?.device_code) continue;
        devices.push({ ...item, _gateway_id: gatewayId });
        deviceCodes.push(item.device_code);
      }
    }

    const shadows = await this.getDeviceShadows(deviceCodes);
    return devices.map((device) => {
      const shadow = shadows[device.device_code];
      const reported = shadow?.state?.reported || {};
      const shadowProperties = {};
      const shadowPropertySources = [];

      Object.entries(reported).forEach(([reportedKey, value]) => {
        if (value && typeof value === 'object' && value.properties) {
          Object.assign(shadowProperties, value.properties);
          shadowPropertySources.push(reportedKey);
        }
      });

      return {
        ...device,
        _shadow_properties: shadowProperties,
        _shadow_property_sources: shadowPropertySources,
      };
    });
  }
}

module.exports = SalusCloudClient;
