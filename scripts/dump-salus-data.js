'use strict';

const fs = require('fs/promises');
const path = require('path');
const SalusCloudClient = require('../lib/salus-cloud-client');

async function main() {
  const email = process.env.SALUS_EMAIL;
  const password = process.env.SALUS_PASSWORD;

  if (!email || !password) {
    throw new Error('Set SALUS_EMAIL and SALUS_PASSWORD environment variables');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(process.cwd(), 'debug-output', timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const client = new SalusCloudClient({ email, password });

  const gatewaysResponse = await client.request('GET', '/occupants/slider_list');
  await fs.writeFile(
    path.join(outputDir, '01-slider-list-raw.json'),
    JSON.stringify(gatewaysResponse, null, 2),
  );

  const gateways = Array.isArray(gatewaysResponse?.data)
    ? gatewaysResponse.data.filter((entry) => entry?.type === 'gateway')
    : [];

  const gatewayDetails = [];
  const allItems = [];

  for (const gateway of gateways) {
    const gatewayId = gateway?.id;
    if (!gatewayId) continue;

    const detailsResponse = await client.request(
      'GET',
      `/occupants/slider_details?id=${gatewayId}&type=gateway`,
    );
    gatewayDetails.push({
      gatewayId,
      raw: detailsResponse,
    });

    const items = Array.isArray(detailsResponse?.data?.items) ? detailsResponse.data.items : [];
    for (const item of items) {
      allItems.push({
        gatewayId,
        ...item,
      });
    }
  }

  await fs.writeFile(
    path.join(outputDir, '02-gateway-details-raw.json'),
    JSON.stringify(gatewayDetails, null, 2),
  );

  await fs.writeFile(
    path.join(outputDir, '03-gateway-items-flattened.json'),
    JSON.stringify(allItems, null, 2),
  );

  const deviceCodes = allItems
    .map((item) => item?.device_code)
    .filter((code) => typeof code === 'string' && code.length > 0);

  const shadowsResponse = await client.request('POST', '/devices/device_shadows', {
    request_id: `debug-dump-${Date.now()}`,
    device_codes: deviceCodes,
  });

  await fs.writeFile(
    path.join(outputDir, '04-device-shadows-raw.json'),
    JSON.stringify(shadowsResponse, null, 2),
  );

  // Parse payload JSON strings from success_list for easier inspection.
  const parsedShadows = {};
  const successList = shadowsResponse?.data?.success_list || [];
  for (const item of successList) {
    if (!item?.device_code || !item?.payload) continue;
    try {
      parsedShadows[item.device_code] = JSON.parse(item.payload);
    } catch (error) {
      parsedShadows[item.device_code] = { parse_error: String(error), raw_payload: item.payload };
    }
  }

  await fs.writeFile(
    path.join(outputDir, '05-device-shadows-parsed.json'),
    JSON.stringify(parsedShadows, null, 2),
  );

  // Build a compact key map for quick searching.
  const keyMap = {};
  for (const [deviceCode, shadow] of Object.entries(parsedShadows)) {
    const reported = shadow?.state?.reported || {};
    const keys = [];
    for (const entry of Object.values(reported)) {
      if (entry && typeof entry === 'object' && entry.properties && typeof entry.properties === 'object') {
        keys.push(...Object.keys(entry.properties));
      }
    }
    keyMap[deviceCode] = Array.from(new Set(keys)).sort();
  }

  await fs.writeFile(
    path.join(outputDir, '06-shadow-property-keys-by-device.json'),
    JSON.stringify(keyMap, null, 2),
  );

  console.log(`Dump complete: ${outputDir}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
