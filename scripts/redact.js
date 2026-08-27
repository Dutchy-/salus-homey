'use strict';

/*
 * Redaction for Salus cloud dumps.
 *
 * The dumps exist to document device shadow properties, so device codes,
 * device names and all sIT600/sIT6ZB/sMeterS values are kept. Account
 * identity, location, network addresses and credentials are stripped: they
 * are never needed to understand the protocol, and a dump that leaves the
 * machine (bug report, app package) must not carry them.
 */

/** Exact keys, matched case-insensitively. */
const SENSITIVE_KEYS = new Set([
  'first_name',
  'last_name',
  'email',
  'invitation_email',
  'phone_number',
  'sharer_occupant_id',
  'receiver_occupant_id',
  'cloud_metadata_latitude',
  'cloud_metadata_longitude',
  'cloud_metadata_device_ip',
]);

/** Key patterns, for shadow properties that carry an endpoint/cluster prefix. */
const SENSITIVE_PATTERNS = [
  /NetworkPassword/i,
  /WirelessAPpassword/i,
  /NetworkSSID/i,
  /Wifiinfo/i,
  /NetworkLANIP/i,
  /NetworkLANMAC/i,
  /NetworkWiFiMAC/i,
  /OutboundIP/i,
];

function isSensitiveKey(key) {
  const k = String(key);
  return SENSITIVE_KEYS.has(k.toLowerCase()) || SENSITIVE_PATTERNS.some((p) => p.test(k));
}

/** Keep the value's type so consumers of the dump still see the shape. */
function redactValue(value) {
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  return '[redacted]';
}

function looksLikeJson(value) {
  if (typeof value !== 'string' || value.length < 2) return false;
  const first = value.trimStart()[0];
  return first === '{' || first === '[';
}

/**
 * Deep-redact a parsed JSON value. Strings that are themselves JSON (the
 * device_shadows `payload` fields) are parsed, redacted and re-stringified,
 * otherwise the gateway shadow inside them would slip through untouched.
 */
function redact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? redactValue(val) : redact(val);
    }
    return out;
  }
  if (looksLikeJson(value)) {
    try {
      return JSON.stringify(redact(JSON.parse(value)));
    } catch (error) {
      return value;
    }
  }
  return value;
}

module.exports = { redact, isSensitiveKey };
