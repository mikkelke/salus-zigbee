---
title: "Salus Controls SQ610RFNH control via MQTT"
description: "Integrate your Salus Controls SQ610RFNH via Zigbee2MQTT with whatever smart home infrastructure you are using without the vendor's bridge or gateway."
pageClass: device-page
---

<!-- !!!! -->
<!-- ATTENTION: This file is auto-generated through docgen! -->
<!-- You can only edit the "Notes"-Section between the two comment lines "Notes BEGIN" and "Notes END". -->
<!-- Do not use h1 or h2 heading within "## Notes"-Section. -->
<!-- !!!! -->

# Salus Controls SQ610RFNH

|     |     |
|-----|-----|
| Model | SQ610RFNH  |
| Vendor  | [Salus Controls](/supported-devices/#v=Salus%20Controls)  |
| Description | Quantum wireless thermostat (iT600) |
| Exposes | climate (current_heating_setpoint, local_temperature, system_mode, running_state, preset), humidity, battery, hold_type, schedule_setpoint, child_lock, frost_setpoint, temperature_offset, heat_control, min_heat_setpoint, max_heat_setpoint, min_cool_setpoint, max_cool_setpoint, display_resolution, wiring_centre_zones |
| Picture | ![Salus Controls SQ610RFNH](https://www.zigbee2mqtt.io/images/devices/SQ610RFNH.png) |



<!-- Notes BEGIN: You can edit here. Add "## Notes" headline if not already present. -->
## Notes

This device is also sold under the Neotherm brand in Denmark.

### Pairing
The thermostat only finishes pairing when the coordinator answers a Salus specific greeting, which this converter does.

1. Factory reset the thermostat.
2. Permit join on the whole network, with the thermostat close to a router or the coordinator: publish `{"time": 254}` to `zigbee2mqtt/bridge/request/permit_join`. Do not limit it to a Salus wiring centre: a thermostat associated with it 50+ times and never received the network key. In one test a router accepted the thermostat and dropped it again before the key exchange.
3. Start pairing on the thermostat.

### "Go to the Smart Home app"
After pairing, the display shows "go to the Smart Home app" and the buttons do nothing until the thermostat is paired with a receiver, such as a wiring centre zone. The Salus gateway behaves the same way. Readings and writes from Zigbee2MQTT work in that state.

### Wiring centre zones
`wiring_centre_zones` pairs the thermostat with zones of a wiring centre (KL08RF / it600WC) on the same Zigbee2MQTT network: the zone numbers 1 to 8 separated by commas, for example `1,4`, and `replace` in front, for example `replace 1,4`, to take over a zone that another thermostat holds. With `replace` it first sends the reset form of B47 and waits for its echo, as a thermostat whose zone the coordinator took over did not pair without it. It is done when the wiring centre's zone table shows the thermostat in all the zones, and it fails if the table does not within 20 s per zone, which is also what a refused zone looks like. There is no unpairing yet. Adding the wiring centre itself is on the [KL08RF](./KL08RF.md) page.

Underneath it sends a B47 command, which can also be sent as raw hex through `salus_command` over MQTT. For a wiring centre with the network address 0x5678 and zone 8:

```text
423437001101007856fe0000000000000000010000000000000000000000000000000000
```

The wiring centre's address is little-endian after `0100`. The eight bytes after `fe00` are one flag per zone, zone 1 first; `fe01` takes over a zone that another thermostat holds. The format is in [PROTOCOL.md section 7](https://github.com/mikkelke/salus-zigbee/blob/HEAD/PROTOCOL.md#7-wiring-centre-zone-pairing). That B47 was tested with a KL08RF on the same Zigbee2MQTT network: pairing, several zones, and the zone relays following the thermostats' demand. `wiring_centre_zones` itself was run there too: a zone that the coordinator held was refused, and `replace` took it over after the reset form had been sent.

### Clock
The thermostat gets its clock and summer time from Zigbee2MQTT, in the time zone Zigbee2MQTT runs in. In Docker that is UTC unless `TZ` is set, for example `TZ=Europe/Copenhagen`.

### Slow writes
The thermostat is a battery powered sleepy end device. A write waits until it next polls its parent, about every 7 s, so a change can take up to about 30 s to be confirmed.

### Firmware updates
The firmware images are standard Zigbee OTA files (manufacturer 0x1078, image type 0x7A). An update from 0x50 to 0x54 took about 1.5 h. If the image you want is not in the OTA index yet, add it to a [local OTA index](../guide/usage/ota_updates.md#using-custom-firmware-files-or-index).

### Temperature resolution
A factory new thermostat reports the temperature in 0.5 °C steps, the resolution of its display. The thermostat can be set to 0.1 °C. `display_resolution` shows which one is set and sets it, 0.5 or 0.1. It is an admin setting, written with the same B11 as `heat_control`. `min_heat_setpoint` and `max_heat_setpoint` are written the same way. `max_heat_setpoint` has been written on real thermostats; `min_heat_setpoint` has not been tried yet.
<!-- Notes END: Do not edit below this line -->


## OTA updates
This device supports OTA updates, for more information see [OTA updates](../guide/usage/ota_updates.md).
