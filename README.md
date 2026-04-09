# Salus Smart Home (Homey App)

Homey app for Salus Quantum thermostats via Salus Cloud.

## Status

This app is currently an **alpha** version.

## Disclaimer

This app is provided **as is**, without warranties and without any promise of future support.

## Supported Devices

- Salus Quantum Thermostat family (`SQ610RF` / `SQ610`)

## Current Features

- Login with Salus cloud account
- Device discovery and pairing in Homey
- Temperature sensor updates (`measure_temperature`)
- Humidity sensor updates (`measure_humidity`)

## Planned Features

- Thermostat control

## Requirements

- Homey Pro (tested on Pro 2023)
- Salus Smart Home account
- Internet access (cloud API)

## Development

Install dependencies:

```bash
npm install
```

Run the app:

```bash
homey app run
```

Install on your selected Homey:

```bash
homey app install
```

## Notes

- Polling interval is 60 seconds.
- Humidity on SQ610RF devices is read from the Salus cloud field `ep9:sIT600TH:SunnySetpoint_x100` (manually cross-referenced against the official Salus app).

## Credits

- This app was built using the Home Assistant integration/module [Peterka35/salus-it600-cloud](https://github.com/Peterka35/salus-it600-cloud) as the reference for cloud API behavior.
- Development of this app was fully assisted by Cursor AI.

