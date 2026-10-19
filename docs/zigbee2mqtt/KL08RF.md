---
title: "Salus Controls KL08RF control via MQTT"
description: "Integrate your Salus Controls KL08RF via Zigbee2MQTT with whatever smart home infrastructure you are using without the vendor's bridge or gateway."
pageClass: device-page
---

<!-- !!!! -->
<!-- ATTENTION: This file is auto-generated through docgen! -->
<!-- You can only edit the "Notes"-Section between the two comment lines "Notes BEGIN" and "Notes END". -->
<!-- Do not use h1 or h2 heading within "## Notes"-Section. -->
<!-- !!!! -->

# Salus Controls KL08RF

|     |     |
|-----|-----|
| Model | KL08RF  |
| Vendor  | [Salus Controls](/supported-devices/#v=Salus%20Controls)  |
| Description | iT600 8-zone wiring centre |
| Exposes | zone_1, zone_2, zone_3, zone_4, zone_5, zone_6, zone_7, zone_8, replaced_thermostat |
| Picture | ![Salus Controls KL08RF](https://www.zigbee2mqtt.io/images/devices/KL08RF.png) |



<!-- Notes BEGIN: You can edit here. Add "## Notes" headline if not already present. -->
## Notes

This device is also sold under the Neotherm brand in Denmark.

### Pairing
The wiring centre sends the same Salus specific greeting as the [SQ610RFNH](./SQ610RFNH.md) thermostat when it joins, and leaves again if nobody answers it. This converter answers it, and gives the wiring centre device number 1. Only one wiring centre per Zigbee network is supported.

1. Factory reset the wiring centre: hold Pair for 15 s until G1 and G2 turn red and go off. Its paired thermostats leave the network too, so they have to join and be paired again.
2. Cut its mains power and wait until the network LED has gone dark. A short cut is not enough: the radio keeps running, and after a reset the wiring centre does not look for a network by itself.
3. Permit join on the whole network: publish `{"time": 254}` to `zigbee2mqtt/bridge/request/permit_join`. Do not limit it to the wiring centre when you join thermostats.
4. Switch the wiring centre on. It joins at once and is recognised as a KL08RF.

### Zones
The wiring centre reports which thermostat holds which zone. `zone_1` to `zone_8` show the IEEE address of the thermostat in each zone, or its short address when no device has it (a thermostat that rejoined under a new one), and null while the zone is free. It reports the table by itself after each pairing and at boot, and a get on any zone asks for it again.

A zone is paired from the thermostat, not from the wiring centre: set `wiring_centre_zones` on the thermostat, see [Wiring centre zones](./SQ610RFNH.md#wiring-centre-zones). The thermostat leaves "go to the Smart Home app" when its zone is paired. A zone that another thermostat holds is refused unless the command has the replace flag, and the wiring centre then reports the thermostat it replaced as `replaced_thermostat`.

From then on the thermostats send their demand to the wiring centre, which switches the zone relays and the pump and boiler outputs.

### Raw commands
`salus_command` sends a raw B-command to the wiring centre: hex, starting with the command code, without the handle. For example `4237307eaaaaa88000000078` asks for the zone table. It and `salus_frame` below work over MQTT only: publish `{"salus_command": "<hex>"}` to `zigbee2mqtt/<wiring centre>/set`. They are not exposes, so the frontend and Home Assistant do not list them.

### Direct zone control (experimental)
`salus_frame` sends a raw 0xFC00 frame to the wiring centre: hex, the command ID and then the payload. With it the coordinator can take a zone and drive it the way a thermostat does. For zone 8, which a thermostat held until then:

1. `1801080000ff0001` takes the zone over (zone request with the replace flag).
2. `140008` confirms it.
3. `120201010800ff0000000000ffd007b80bdc05` reports heat demand for the zone, with a room at 20.00 °C, a setpoint of 30.00 °C and a standby setpoint of 15.00 °C. The pump and boiler outputs switched on 3 minutes later.

A zone the coordinator holds stays on for about 30 minutes after its last report. Then the wiring centre drops it by itself, and the pump and boiler outputs go off 3 minutes later. If Zigbee2MQTT stops, the zone goes cold, so direct control is not a fail-safe way to heat a room. Zones that thermostats hold are not affected: they keep reporting on their own. Giving the zone back to its thermostat is not a plain re-pairing, see [PROTOCOL.md section 7.7](https://github.com/mikkelke/salus-zigbee/blob/HEAD/PROTOCOL.md#77-giving-a-zone-back-to-its-thermostat). There is no structured interface for this yet: it is raw frames, described in [PROTOCOL.md section 7.6](https://github.com/mikkelke/salus-zigbee/blob/HEAD/PROTOCOL.md#76-coordinator-as-a-zones-thermostat).

### Firmware updates
The wiring centre lists the OTA client cluster (0x0019), and Salus ships its firmware as standard Zigbee OTA files. The OTA index has the image of the version it runs (20230222) under the manufacturer name SalusControls, which the definition uses, and Zigbee2MQTT matches the wiring centre to it. No newer image exists yet, so a transfer has not been tried.
<!-- Notes END: Do not edit below this line -->


## OTA updates
This device supports OTA updates, for more information see [OTA updates](../guide/usage/ota_updates.md).
