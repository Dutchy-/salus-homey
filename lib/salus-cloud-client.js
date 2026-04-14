'use strict';

const crypto = require('crypto');
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const mqtt = require('mqtt');
const {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} = require('amazon-cognito-identity-js');

const AWS_USER_POOL_ID = 'eu-central-1_XGRz3CgoY';
const AWS_CLIENT_ID = '4pk5efh3v84g5dav43imsv4fbj';
const AWS_REGION = 'eu-central-1';
const AWS_IDENTITY_POOL_ID = 'eu-central-1:60912c00-287d-413b-a2c9-ece3ccef9230';
const AWS_IOT_ENDPOINT = 'a24u3z7zzwrtdl-ats.iot.eu-central-1.amazonaws.com';
const COGNITO_PROVIDER_KEY = `cognito-idp.${AWS_REGION}.amazonaws.com/${AWS_USER_POOL_ID}`;
const COMPANY_CODE = 'salus-eu';
const SERVICE_API_BASE_URL = 'https://service-api.eu.premium.salusconnect.io/api/v1';

const CREDENTIAL_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MQTT_CONNECT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_SHADOW_DEVICE_INDEX = '11';

function awsUriEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function formatAmzDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${h}${min}${s}Z`;
}

function formatDateStamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function signHmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = signHmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = signHmac(kDate, region);
  const kService = signHmac(kRegion, service);
  return signHmac(kService, 'aws4_request');
}

function buildSortedQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(params[k])}`)
    .join('&');
}

function createSignedWebsocketUrl({ host, region, accessKeyId, secretAccessKey, sessionToken }) {
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = formatDateStamp(now);
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/iotdevicegateway/aws4_request`;

  const canonicalQuerystring = {
    'X-Amz-Algorithm': algorithm,
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-SignedHeaders': 'host',
  };

  const encodedParams = buildSortedQuery(canonicalQuerystring);
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');

  const canonicalRequest = [
    'GET',
    '/mqtt',
    encodedParams,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, 'iotdevicegateway');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  let finalParams = `${encodedParams}&X-Amz-Signature=${signature}`;
  if (sessionToken) {
    finalParams += `&X-Amz-Security-Token=${awsUriEncode(sessionToken)}`;
  }

  return `wss://${host}/mqtt?${finalParams}`;
}

function extractFirstShadowDeviceIndex(shadow) {
  const reported = shadow?.state?.reported || {};
  for (const [key, value] of Object.entries(reported)) {
    if (value && typeof value === 'object' && value.properties) {
      return key;
    }
  }
  return null;
}

/** Reported shadow blocks use string keys like "11"; pick the thermostat endpoint, not the gateway block. */
const THERMOSTAT_SHADOW_MARKERS = [
  'ep9:sIT600TH:LocalTemperature_x100',
  'ep9:sIT600TH:HeatingSetpoint_x100',
  'ep9:sHT:LocalTemperature_x100',
  'ep9:sHT:HeatingSetpoint_x100',
];

function findThermostatShadowReportedIndex(shadow) {
  const reported = shadow?.state?.reported || {};
  for (const [key, value] of Object.entries(reported)) {
    if (!value || typeof value !== 'object' || !value.properties) {
      continue;
    }
    const props = value.properties;
    const hit = THERMOSTAT_SHADOW_MARKERS.some((m) => typeof props[m] === 'number');
    if (hit) {
      return key;
    }
  }
  return null;
}

function getReportedPropertiesAtIndex(shadow, index) {
  if (!index) {
    return {};
  }
  const block = shadow?.state?.reported?.[index];
  if (block && typeof block === 'object' && block.properties) {
    return block.properties;
  }
  return {};
}

function detectThermostatCluster(properties) {
  if (!properties || typeof properties !== 'object') {
    return 'ep9:sIT600TH';
  }
  const keys = Object.keys(properties);
  if (keys.some((k) => k.startsWith('ep9:sIT600TH:'))) {
    return 'ep9:sIT600TH';
  }
  if (keys.some((k) => k.startsWith('ep9:sHT:'))) {
    return 'ep9:sHT';
  }
  return 'ep9:sIT600TH';
}

async function resolveThermostatWriteContext(client, deviceCode, deviceIndexHint) {
  const shadows = await client.getDeviceShadows([deviceCode]);
  const shadow = shadows[deviceCode];

  let index = findThermostatShadowReportedIndex(shadow);
  if (!index && deviceIndexHint) {
    index = String(deviceIndexHint);
  }
  if (!index) {
    index = extractFirstShadowDeviceIndex(shadow) || DEFAULT_SHADOW_DEVICE_INDEX;
  }

  const reportedProps = getReportedPropertiesAtIndex(shadow, index);
  const cluster = detectThermostatCluster(reportedProps);
  return { index, cluster };
}

class SalusCloudClient {
  constructor({ email, password }) {
    this.email = email;
    this.password = password;
    this.accessToken = null;
    this.idToken = null;
    this.tokenExpiresAt = 0;

    this.awsAccessKeyId = null;
    this.awsSecretAccessKey = null;
    this.awsSessionToken = null;
    this.awsCredentialsExpireAt = 0;

    this.mqttClient = null;
    this.gatewayDeviceCode = null;
    this._mqttPublishChain = Promise.resolve();
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

  mergeShadowIntoDevice(device, shadow) {
    const reported = shadow?.state?.reported || {};
    const shadowProperties = {};
    const shadowPropertySources = [];
    let firstIndex = null;

    Object.entries(reported).forEach(([reportedKey, value]) => {
      if (value && typeof value === 'object' && value.properties) {
        if (firstIndex === null) {
          firstIndex = reportedKey;
        }
        Object.assign(shadowProperties, value.properties);
        shadowPropertySources.push(reportedKey);
      }
    });

    const thermostatIndex = findThermostatShadowReportedIndex(shadow) || firstIndex;

    return {
      ...device,
      _shadow_properties: shadowProperties,
      _shadow_property_sources: shadowPropertySources,
      _shadow_device_index: thermostatIndex,
    };
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
      if (!shadow) {
        return device;
      }
      return this.mergeShadowIntoDevice(device, shadow);
    });
  }

  async fetchAwsIotCredentials() {
    await this.ensureAuth();

    const getIdUrl = `https://cognito-identity.${AWS_REGION}.amazonaws.com/`;
    const getIdBody = JSON.stringify({
      IdentityPoolId: AWS_IDENTITY_POOL_ID,
      Logins: {
        [COGNITO_PROVIDER_KEY]: this.idToken,
      },
    });

    const getIdResponse = await fetch(getIdUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityService.GetId',
      },
      body: getIdBody,
    });

    if (!getIdResponse.ok) {
      const text = await getIdResponse.text();
      throw new Error(`AWS GetId ${getIdResponse.status}: ${text}`);
    }

    const getIdResult = await getIdResponse.json();
    const identityId = getIdResult.IdentityId;

    const getCredsBody = JSON.stringify({
      IdentityId: identityId,
      Logins: {
        [COGNITO_PROVIDER_KEY]: this.idToken,
      },
    });

    const getCredsResponse = await fetch(getIdUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
      },
      body: getCredsBody,
    });

    if (!getCredsResponse.ok) {
      const text = await getCredsResponse.text();
      throw new Error(`AWS GetCredentialsForIdentity ${getCredsResponse.status}: ${text}`);
    }

    const credsResult = await getCredsResponse.json();
    const credentials = credsResult.Credentials;

    this.awsAccessKeyId = credentials.AccessKeyId;
    this.awsSecretAccessKey = credentials.SecretKey;
    this.awsSessionToken = credentials.SessionToken;

    const expirationSec = credentials.Expiration;
    if (typeof expirationSec === 'number') {
      this.awsCredentialsExpireAt = expirationSec * 1000;
    } else {
      this.awsCredentialsExpireAt = Date.now() + 60 * 60 * 1000;
    }
  }

  awsCredentialsNeedRefresh() {
    return (
      !this.awsAccessKeyId ||
      Date.now() >= this.awsCredentialsExpireAt - CREDENTIAL_REFRESH_SKEW_MS
    );
  }

  async ensureAwsIotCredentials() {
    if (!this.awsCredentialsNeedRefresh()) {
      return;
    }
    await this.disconnectMqtt();
    await this.fetchAwsIotCredentials();
  }

  async resolveGatewayDeviceCode() {
    if (this.gatewayDeviceCode) {
      return this.gatewayDeviceCode;
    }

    const gateways = await this.getGateways();
    const gateway = gateways[0];
    const nested = gateway?.gateway || {};
    const code = nested.device_code || gateway?.device_code;

    if (!code) {
      throw new Error('Gateway device_code not found (needed for Salus cloud control)');
    }

    this.gatewayDeviceCode = code;
    return this.gatewayDeviceCode;
  }

  async disconnectMqtt() {
    if (!this.mqttClient) {
      return;
    }

    const client = this.mqttClient;
    this.mqttClient = null;

    await new Promise((resolve) => {
      try {
        client.end(true, {}, () => resolve());
      } catch (error) {
        resolve();
      }
    });
  }

  async ensureMqttConnected() {
    await this.ensureAwsIotCredentials();

    if (this.mqttClient && this.mqttClient.connected) {
      return;
    }

    await this.disconnectMqtt();

    const wsUrl = createSignedWebsocketUrl({
      host: AWS_IOT_ENDPOINT,
      region: AWS_REGION,
      accessKeyId: this.awsAccessKeyId,
      secretAccessKey: this.awsSecretAccessKey,
      sessionToken: this.awsSessionToken,
    });

    const gatewayCode = await this.resolveGatewayDeviceCode();
    const clientId = `${gatewayCode}-${randomUUID()}`;

    this.mqttClient = await new Promise((resolve, reject) => {
      const client = mqtt.connect(wsUrl, {
        clientId,
        protocolVersion: 4,
        reconnectPeriod: 0,
        keepalive: 60,
        connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
      });

      const timer = setTimeout(() => {
        client.end(true);
        reject(new Error('MQTT connection timeout'));
      }, MQTT_CONNECT_TIMEOUT_MS);

      client.once('connect', () => {
        clearTimeout(timer);
        resolve(client);
      });

      client.once('error', (err) => {
        clearTimeout(timer);
        client.end(true);
        reject(err);
      });
    });
  }

  async resolveShadowDeviceIndex(deviceCode, hintIndex) {
    if (hintIndex) {
      return String(hintIndex);
    }

    const shadows = await this.getDeviceShadows([deviceCode]);
    const shadow = shadows[deviceCode];
    const thermostatIdx = findThermostatShadowReportedIndex(shadow);
    if (thermostatIdx) {
      return String(thermostatIdx);
    }
    const fromShadow = extractFirstShadowDeviceIndex(shadow);
    if (fromShadow) {
      return fromShadow;
    }

    return DEFAULT_SHADOW_DEVICE_INDEX;
  }

  async publishDeviceShadowDesired(deviceCode, properties, deviceIndex) {
    await this.ensureMqttConnected();

    const index = await this.resolveShadowDeviceIndex(deviceCode, deviceIndex);
    const topic = `$aws/things/${deviceCode}/shadow/update`;
    const payload = JSON.stringify({
      state: {
        desired: {
          [index]: {
            properties,
          },
        },
      },
    });

    const client = this.mqttClient;

    await new Promise((resolve, reject) => {
      client.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async updateDeviceShadow(deviceCode, properties, deviceIndex) {
    this._mqttPublishChain = this._mqttPublishChain
      .catch(() => {})
      .then(() => this._updateDeviceShadowOnce(deviceCode, properties, deviceIndex));
    return this._mqttPublishChain;
  }

  async _updateDeviceShadowOnce(deviceCode, properties, deviceIndex) {
    try {
      await this.publishDeviceShadowDesired(deviceCode, properties, deviceIndex);
    } catch (error) {
      const message = error?.message || String(error);
      if (message.includes('Connection closed') || message.includes('disconnect')) {
        await this.disconnectMqtt();
        await this.ensureMqttConnected();
        await this.publishDeviceShadowDesired(deviceCode, properties, deviceIndex);
        return;
      }
      await this.disconnectMqtt();
      throw error;
    }
  }

  /**
   * Set heating setpoint via Salus cloud (AWS IoT device shadow).
   * SQ610 often reports SystemMode 3 while older docs use 4 for heat — do not force 4.
   */
  async setTemperature(deviceCode, temperatureCelsius, deviceIndexHint, modeHint = null) {
    const tempX100 = Math.round(Number(temperatureCelsius) * 100);
    const { index, cluster } = await resolveThermostatWriteContext(this, deviceCode, deviceIndexHint);

    const targetKey = modeHint === 'cool'
      ? `${cluster}:SetCoolingSetpoint_x100`
      : `${cluster}:SetHeatingSetpoint_x100`;

    const properties = {
      [targetKey]: tempX100,
      [`${cluster}:SetHoldType`]: 2,
    };

    await this.updateDeviceShadow(deviceCode, properties, index);
  }

  async setHoldMode(deviceCode, holdType, deviceIndexHint) {
    const { index, cluster } = await resolveThermostatWriteContext(this, deviceCode, deviceIndexHint);
    const properties = {
      [`${cluster}:SetHoldType`]: holdType,
    };
    await this.updateDeviceShadow(deviceCode, properties, index);
  }

  async setSystemMode(deviceCode, systemMode, deviceIndexHint) {
    const { index, cluster } = await resolveThermostatWriteContext(this, deviceCode, deviceIndexHint);
    const properties = {
      [`${cluster}:SetSystemMode`]: systemMode,
    };
    await this.updateDeviceShadow(deviceCode, properties, index);
  }
}

module.exports = SalusCloudClient;
