# Salus iT600 on zigbee2mqtt

Run Salus iT600 thermostats (SQ610RFNH) and their KL08RF wiring centre on your own Zigbee network with zigbee2mqtt, without the Salus gateway. The same devices are also sold under the Neotherm brand in Denmark.

The thermostats are ordinary Zigbee devices, but they only finish pairing when the coordinator answers a Salus specific greeting. This repo has that greeting, a zigbee2mqtt converter, and the protocol as it was captured from a live Salus system.

## Status

| What | State |
|---|---|
| Pairing to zigbee2mqtt | Works |
| Temperature, setpoint, humidity, battery, heating on/off | Works |
| Off/on, heat and cool mode, setpoint, keypad lock | Works. `current_heating_setpoint` is the setpoint of the mode, so the cooling setpoint in cool mode |
| Presets: schedule, permanent hold, away | Works |
| Settings: frost setpoint, temperature offset, heat control algorithm, display resolution | Works |
| Settings: minimum and maximum heating setpoint | Written like the four above, with limits checked. The bytes are proven; these writes have not been tried on a thermostat yet |
| Firmware update over zigbee2mqtt | Works (0x50 to 0x54, about 1.5 h) |
| Wiring centre (KL08RF / it600WC) on zigbee2mqtt: joining, zone table, zone pairing, relays following the thermostats | Works. A wiring centre with six thermostats over seven zones runs without the Salus gateway, see [docs/wiring-centre.md](docs/wiring-centre.md). One wiring centre per network |
| Wiring centre firmware update over zigbee2mqtt | The index match works: zigbee2mqtt matches the wiring centre to the zigbee-OTA image SAL6DW1_20230222, the version it already runs. A transfer is untested, as no newer image exists yet |
| Other iT600 devices | Not covered. The related models SQ610NH (OTA image type 0x7B), SQ610RF (0x4E) and SQ610 (0x4F) are untested |

Tested with SQ610RFNH thermostats on firmware 0x50 and 0x54 and a KL08RF wiring centre on firmware SAL6DW1_20230222 (no newer image exists), on zigbee2mqtt 2.14.2.

## Use the converter

1. Copy `converters/salus_sq610rfnh.mjs` to `external_converters/` in your zigbee2mqtt data folder and restart zigbee2mqtt.
2. Factory reset the thermostat.
3. Permit join on the whole network, with the thermostat close to a router or the coordinator:
   `zigbee2mqtt/bridge/request/permit_join` with `{"time": 254}`.
   Do not limit it to the wiring centre: a thermostat associated with it 50+ times and never received the network key.
   In one test a router accepted the thermostat and dropped it again before the key exchange.
4. Start pairing on the thermostat.

The display shows "go to the Smart Home app" and the buttons do nothing until the thermostat is paired with a receiver, like a wiring centre zone. The Salus gateway behaves the same way. Readings and writes from zigbee2mqtt work in that state.

The devices get their clock and summer time from zigbee2mqtt, in the time zone of the host it runs on. In Docker that is UTC unless `TZ` is set, for example `TZ=Europe/Copenhagen`, so set it: with UTC the thermostats show UTC all year, and zigbee2mqtt logs a warning at start.

A zone of the wiring centre is paired with `wiring_centre_zones`, see below.

## Add a wiring centre

The same file has a second definition for the KL08RF / it600WC. It supports one wiring centre per network. More in [docs/wiring-centre.md](docs/wiring-centre.md).

1. Factory reset the wiring centre: hold Pair for 15 s until G1 and G2 turn red and go off. Its paired thermostats leave the network too, so they have to join and be paired again.
2. Cut its mains power and wait until the network LED has gone dark. A short cut is not enough.
3. Permit join on the whole network (step 3 above) and switch the wiring centre on. It joins at once and shows up as KL08RF.
4. Join the thermostats as above.
5. Pair a zone from the thermostat: publish `{"wiring_centre_zones": "8"}` to `zigbee2mqtt/<thermostat>/set`. The value is the zone numbers 1 to 8 separated by commas, for example `"1,4"`, and `replace` in front takes over a zone that another thermostat holds, for example `"replace 1,4"`. The call is done when the wiring centre's zone table shows the thermostat in all the zones, and it fails after 20 s per zone if not. There is no unpairing yet: its form is not known. `wiring_centre_zones` has been run on a real wiring centre: a plain pairing of a zone that the coordinator held was refused (the zone table never showed the thermostat, and the call failed after 20 s), and `replace` took it over. `replace` first sends the reset form of B47 (state `fd`) and waits for its echo, and then the pairing form (state `fe`), because a thermostat whose zone the coordinator took over did not pair with `replace` alone. The B47 of the pairing form, which `salus_command` can also send as raw hex (MQTT only, not an expose), is explained in [docs/wiring-centre.md](docs/wiring-centre.md).
6. The wiring centre reports the zone table after each pairing: `zone_1` to `zone_8` show the IEEE address of the thermostat in each zone (its short address when no device has it, null while the zone is free). Publish `{"zone_1": ""}` to `zigbee2mqtt/<wiring centre>/get` to ask again.

## Firmware updates

zigbee2mqtt can update the thermostats over the air. The images are standard Zigbee OTA files (manufacturer 0x1078, image type 0x7A). A Salus gateway stores the download link of the last image it installed on each device. Read it from the gateway's local API (`readall`, field `sOTA.OTAFirmwareURL_d`), unpack the `.tar.gz` and add the `.ota` file to zigbee2mqtt's local OTA index (`ota.zigbee_ota_override_index_location`). Firmware is not included in this repo.

## Capture it yourself

Everything here came from decrypted captures of a Salus network. You can do the same with a Sonoff ZBDongle-P:

1. Back up the dongle's flash with [cc2538-bsl](https://github.com/JelmerT/cc2538-bsl) (`--bootloader-sonoff-usb -r -l 360448`).
2. Get TI's sniffer firmware from SmartRF Packet Sniffer 2 (free TI account). Extract the installer with 7-Zip and take `sniffer_fw/bin/cc1352p2lp/sniffer_fw.hex`.
3. Run `tools/fix_ccfg.py sniffer_fw.hex sniffer-dongle.hex <your backup>` so the dongle stays re-flashable, then flash `sniffer-dongle.hex`.
4. `tools/ti_sniff.py -c <channel> -w capture.pcap` records to a pcap for Wireshark.
5. Pair a thermostat to the Salus gateway while recording. The network key is sent during the join, encrypted with the standard Zigbee link key, so Wireshark can recover it.
6. `SALUS_NWK_KEY=<key> tools/decode_capture.py capture.pcap` prints the Salus frames as a timeline.

Restore the backup with cc2538-bsl when you are done.

[PROTOCOL.md section 11](PROTOCOL.md#11-open-questions) lists what is still unknown and which captures would answer it.

## Documentation

| Path | What |
|---|---|
| [docs/zigbee2mqtt/SQ610RFNH.md](docs/zigbee2mqtt/SQ610RFNH.md) | Draft device page for zigbee2mqtt.io |
| [docs/zigbee2mqtt/KL08RF.md](docs/zigbee2mqtt/KL08RF.md) | Draft device page for the wiring centre |
| [docs/ota/README.md](docs/ota/README.md) | Getting the 0x54 firmware into the shared zigbee-OTA index |
| [docs/wiring-centre.md](docs/wiring-centre.md) | The wiring centre on zigbee2mqtt: how to add it, what is proven, firmware updates |
| [MANUAL-COVERAGE.md](MANUAL-COVERAGE.md) | Every feature in the manufacturer's manuals, with where it sits in the protocol and whether the converter has it |

## Files

| Path | What |
|---|---|
| `converters/salus_sq610rfnh.mjs` | zigbee2mqtt external converter |
| `tests/salus_sq610rfnh.test.mjs` | Converter tests against a simulated thermostat; run `node --test` with zigbee-herdsman and zigbee-herdsman-converters on the module path, e.g. inside the zigbee2mqtt container |
| `PROTOCOL.md` | The protocol, every field marked proven, inferred or unknown |
| `tools/ti_sniff.py` | Host side for TI's sniffer firmware, writes pcap |
| `tools/decode_capture.py` | Decodes Salus frames in a capture |
| `tools/check_ccfg.py`, `tools/fix_ccfg.py` | Check and fix the CCFG of a firmware image before flashing a ZBDongle-P |

## Licence

MIT, see [LICENSE](LICENSE). The product photos in `images/`, and the icons made from them in the converter, belong to Salus Controls and are not covered by that licence. This project is not affiliated with Salus.
