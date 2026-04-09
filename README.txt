Salus Smart Home
================

Homey app for Salus Quantum thermostats via Salus Cloud.

Status
------
This app is currently an alpha release.

Supported Devices
-----------------
- Salus Quantum Thermostat family
  - SQ610RF (wireless)
  - SQ610 (wired)

Current Features
----------------
- Sign in with your Salus Smart Home account
- Discover and pair thermostats in Homey
- Read temperature values
- Read humidity values

Notes:
- Humidity on SQ610RF devices is read from the Salus cloud field
  "ep9:sIT600TH:SunnySetpoint_x100" (manually cross-referenced against
  the official Salus app).
- Polling interval is 60 seconds.

How To Use
----------
1. Install the app on Homey.
2. Add a "Quantum Thermostat" device.
3. Enter your Salus account credentials during pairing.
4. Select and add your thermostats.

Disclaimer
----------
This app is provided AS IS, without warranties and without any promise
of future support.

Credits
-------
- Built using the Home Assistant Salus cloud integration as a technical
  reference:
  https://github.com/Peterka35/salus-it600-cloud
- Development of this app was fully assisted by Cursor AI.

Support
-------
Publisher: Edwin Smulders
Email: edwin@edwinsmulders.eu
