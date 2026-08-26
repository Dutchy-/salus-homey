# Salus Smart Home (Homey App)

Homey app for Salus iT600 devices (thermostats, smart plugs, wiring centres) via Salus Cloud.

## Status

This app is currently an **alpha** version.

## Disclaimer

This app is provided **as is**, without warranties and without any promise of future support.

## Supported Devices

- Salus Quantum Thermostat family (`SQ610RF` / `SQ610`)
- Salus Smart Plug (`SPE600` / `SP600`)
- Salus underfloor heating wiring centres (`CB12RF` / `KL08RF`)

## Current Features

Thermostats:

- Temperature and humidity readings
- Target temperature control
- On/off control with standby behavior, resuming the previous mode
- Preset selector: follow schedule, permanent hold or standby, plus a "Resume schedule" flow action
- Heating/cooling activity indicators with insights and flow cards
- Battery level and low-battery alarm (battery models)
- Operating mode display (`thermostat_mode`, read-only)

Smart plugs:

- On/off control
- Power and cumulative energy metering (metering models)

Wiring centres:

- Pump and boiler output status with insights and flow cards
- Per-zone open/closed status for bound zones, with flow triggers

General:

- Login with Salus cloud account; adding more devices reuses stored credentials
- Repair flow to update a changed Salus password without re-pairing

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
- Development of this app was fully AI-assisted (Cursor, Claude Code).

