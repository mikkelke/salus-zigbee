// Salus iT600 SQ610RFNH thermostat (Computime, manufacturer code 0x1078) without the Salus gateway.
// Protocol: PROTOCOL.md. The thermostat expects a greeting from its coordinator on manufacturer
// cluster 0xFC00, pushes status as 0xFC00 records and takes writes as B-commands that it echoes.
// Settings are read from the 0x72 record and changed by asking for a fresh 0x72 with B74 and writing it back with B11.
// Known risk: the coordinator's ZDO node descriptor cannot report manufacturer code 0x1078 from a converter.
// The second definition is the KL08RF / it600WC wiring centre, which asks for the same greeting and reports its zone table (PROTOCOL.md section 8).
// A device that asks for the wiring centre (0x16) is told its short address (PROTOCOL.md section 4.3). One wiring centre per network is supported.

import { Zcl } from "zigbee-herdsman";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import { logger } from "zigbee-herdsman-converters/lib/logger";
import * as m from "zigbee-herdsman-converters/lib/modernExtend";
import * as utils from "zigbee-herdsman-converters/lib/utils";

const NS = "zhc:salus_sq610rfnh";
const e = exposes.presets;
const ea = exposes.access;

const CLUSTER = "manuSpecificSalusIt600";
const THERMOSTAT_ENDPOINT = 9;
const WIRING_CENTRE_ENDPOINT = 8;
// The device number in byte 0 of the sync response (PROTOCOL.md section 4.3). Gateway code gives wiring centres 1-9; this converter has one.
const THERMOSTAT_NUMBER = 0x20;
const WIRING_CENTRE_NUMBER = 1;

// The clock the devices show is the host's, which is TZ in Docker. The gateway's zigbee_device_timezone.ini numbers the standard UTC offsets
// in seconds (PROTOCOL.md section 4.2); summer time is signalled separately.
const TIME_ZONE_OFFSETS = [
    -46800, -43200, -39600, -36000, -32400, -28800, -25200, -21600, -18000, -14400, -10800, -7200, -3600,
    0, 3600, 7200, 10800, 14400, 18000, 21600, 25200, 28800, 32400, 36000, 39600, 43200, 46800, 50400,
    -34200, -16200, -12600, -11220, 12600, 16200, 19800, 20700, 23400, 31500, 34200, 37800, 41400, 45900,
];
const SECONDS_1970_TO_2000 = 946684800;
// The sync response is repeated this often, and whenever the local offset from UTC changes.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const RECORD_STATUS = 0x71;
const STATUS_MIN_LENGTH = 50;
// Byte offsets in a 0x71 record (PROTOCOL.md section 5.2).
const STATUS = {
    holdType: 3,
    temperature: 4,
    setpoint: 9,
    scheduleSetpoint: 11,
    systemMode: 15,
    runningState: 17,
    keypadLock: 23,
    humidity: 24,
    battery: 49,
};
// The thermostat sometimes sends a status record with 12.34 as the temperature, a placeholder and not a reading.
// The rest of such a record is valid.
const STATUS_PLACEHOLDER_TEMPERATURE = 0x1234;
const HOLD_TYPES = { 0: "schedule", 1: "temporary_hold", 2: "permanent_hold", 6: "away", 7: "standby" };
const HOLD_TYPE_STANDBY = 7;
// The preset follows the hold type. A temporary hold is the schedule running with an override, so it shows as the schedule preset.
const PRESETS = { 0: "schedule", 1: "schedule", 2: "permanent_hold", 6: "away" };
// Byte 15 of a 0x71 record, and the argument of B48.
const SYSTEM_MODES = { 3: "cool", 4: "heat" };
const SYSTEM_MODE_SET = Object.fromEntries(Object.entries(SYSTEM_MODES).map(([code, name]) => [name, Number(code)]));
const RUNNING_STATES = { 0: "idle", 1: "heat" };
const BATTERY_PERCENT = [0, 10, 25, 50, 75, 100];

// The thermostat has one setpoint at a time, the one of the system mode it is in. The expose spans the limits of both modes.
const SETPOINT_MIN = 5;
const SETPOINT_MAX = 40;
const SETPOINT_BYTE_OFFSET = 0x20;
// The settable hold types, named like the preset the hold type shows as.
const HOLD_TYPE_SET = { schedule: 0, permanent_hold: 2, away: 6 };
const KEYPAD_LOCK = { LOCK: 0x41, UNLOCK: 0x42 };

const RECORD_SETTINGS = 0x72;
// B11 carries bytes 0-47 of the record. Byte 0 says what is written: the user settings, or the user and admin settings.
const SETTINGS_LENGTH = 48;
const SETTINGS_WRITE = { user: 0x72, admin: 0x73 };
// Byte offsets in a 0x72 record (PROTOCOL.md section 5.3).
const SETTINGS = {
    counter: 1,
    temperatureOffset: 3,
    frostSetpoint: 6,
    displayResolution: 11,
    heatControl: 12,
    maxHeatSetpoint: 22,
    minHeatSetpoint: 24,
    maxCoolSetpoint: 26,
    minCoolSetpoint: 28,
    pin: 40,
};
// The setpoint of each system mode: the command that sets it (the thermostat ignores B34 outside heat and B33 outside cool), the bytes of
// a 0x72 that hold the limits it accepts, and the limits to use until one has been seen.
const SETPOINTS = {
    heat: { command: "B34", minByte: SETTINGS.minHeatSetpoint, maxByte: SETTINGS.maxHeatSetpoint, min: SETPOINT_MIN, max: 35 },
    cool: { command: "B33", minByte: SETTINGS.minCoolSetpoint, maxByte: SETTINGS.maxCoolSetpoint, min: SETPOINT_MIN, max: SETPOINT_MAX },
};
const HEAT_CONTROL = { 0: "itlc_ufh", 1: "itlc_rad", 2: "itlc_elect", 3: "span_0.25", 4: "span_0.5", 5: "thb_actuator" };
const HEAT_CONTROL_SET = Object.fromEntries(Object.entries(HEAT_CONTROL).map(([code, name]) => [name, Number(code)]));
const DISPLAY_RESOLUTIONS = { 0: 0.5, 1: 0.1 };
const DISPLAY_RESOLUTION_SET = Object.fromEntries(Object.entries(DISPLAY_RESOLUTIONS).map(([code, step]) => [step, Number(code)]));
// Bytes 40-41 hold the PIN scrambled with the report counter in byte 1; 0xFFFF means no PIN.
// The counter and PIN bytes below decode to no PIN.
const NO_PIN = 0xffff;
const NO_PIN_BYTES = { counter: 0x01, pinHigh: 0x01, pinLow: 0xff };
// The manual's ranges for the standby heating setpoint and the temperature calibration.
const FROST_MIN = 5;
const FROST_MAX = 35;
const OFFSET_MIN = -3.5;
const OFFSET_MAX = 3.5;
// The minimum heating setpoint is at least this much below the maximum one.
const HEAT_LIMIT_GAP = 0.5;

// The wiring centre answers B70 with a 0x33 (PROTOCOL.md section 8). After the handle, the code, five zero bytes and the count byte come
// slots of three bytes from byte 10: the short address of the thermostat in the zone, big-endian, and a flag byte. 0xFFFF marks a free zone.
const ZONES = 8;
const ZONE_KEYS = Array.from({ length: ZONES }, (_, index) => `zone_${index + 1}`);
const ZONE_TABLE = { code: "B70", firstSlot: 10, slotLength: 3 };
const ZONE_TABLE_LENGTH = ZONE_TABLE.firstSlot + ZONE_TABLE.slotLength * ZONES;
const FREE_ZONE = 0xffff;
// The gateway's own request for the table (it600WC.cfg): the code and its arguments. A reply is taken to carry the handle of its request, as
// the thermostat's echoes do, so the request takes its handle from the same allocator as every other B-command: a fixed handle could
// resolve a command that is waiting for its echo.
const ZONE_TABLE_REQUEST = [...Buffer.from(ZONE_TABLE.code, "latin1"), 0x7e, 0xaa, 0xaa, 0xa8, 0x80, 0x00, 0x00, 0x00, 0x78];
// The 0x1a report of a replaced thermostat: 01 00, then the short address of the thermostat that was replaced, little-endian.
const REPLACED_THERMOSTAT = { length: 4, address: 2 };
// B47 makes a thermostat pair itself with zones of a wiring centre (PROTOCOL.md section 7.1). After the code come 33 bytes: 00 11, the number of the
// wiring centre and its short address (little-endian), the state fe for a pairing, the replace flag and one flag byte per zone, then zeros.
// The reset form has ff ff for the number and for the short address, the state fd and zeros after it.
const ZONE_PAIRING = { code: "B47", length: 33, state: 0xfe, resetState: 0xfd, replaceByte: 7, firstZoneByte: 8 };
// Thermostat and wiring centre pair directly, which takes about 8 s a zone, and the wiring centre then reports its zone table.
const ZONE_PAIRING_MS = 20000;

const ECHO_TIMEOUT_MS = 30000;
const SETTINGS_TIMEOUT_MS = 30000;
const lastHandle = new Map();
const pendingEchoes = new Map();
// The last 0x72 of each thermostat, which is where the setpoint limits come from. A settings write asks for a fresh one.
const settingsRecords = new Map();
const settingsWaiters = new Map();
const queues = new Map();
const lastSync = new Map();
// Byte 15 of each thermostat's last 0x71 record, or what its last echoed B48 set: 4 heat, 3 cool.
const systemModeBytes = new Map();
// The zone pairings that wait for a zone table: the short address of the thermostat and its zone numbers (1-8).
const zonePairings = new Set();
// The endpoint of the wiring centre that was given each wiring centre number. Its short address is read from the endpoint when it is asked
// for, so a new short address after a rejoin is followed.
const wiringCentres = new Map();

const echoKey = (ieeeAddr, handle) => `${ieeeAddr}/${handle}`;

// Handles 1-127: the device uses 0 and 0x80 and up for its own unsolicited reports. A handle that still waits for its echo is skipped.
function nextHandle(ieeeAddr) {
    for (let tried = 0; tried < 0x7f; tried++) {
        const handle = ((lastHandle.get(ieeeAddr) ?? 0) % 0x7f) + 1;
        lastHandle.set(ieeeAddr, handle);
        if (!pendingEchoes.has(echoKey(ieeeAddr, handle))) {
            return handle;
        }
    }
    throw new Error(`All 127 handles of ${ieeeAddr} wait for an echo`);
}

// A promise that is settled from outside. `stop` can reject it before anything awaits it, which must not count as an unhandled rejection.
function waiter() {
    const resolvers = Promise.withResolvers();
    resolvers.promise.catch(() => {});
    return resolvers;
}

// The coordinator and the thermostat send frames with the server-to-client bit set, so their commands are declared as command responses.
// The wiring centre sends the other bit, so what the devices send to the coordinator is declared a second time, as commands (toCoordinator).
const rawCommand = (name, ID) => ({ name, ID, parameters: [{ name: "payload", type: Zcl.BuffaloZclDataType.BUFFER }] });

// The thermostat reads modelId from its coordinator. herdsman answers Basic reads from the attribute defaults, from
// the endpoint that was addressed, so these defaults make the coordinator identify as a Salus gateway.
const gatewayBasic = {
    name: "genBasic",
    ID: 0x0000,
    attributes: {
        manufacturerName: { name: "manufacturerName", ID: 0x0004, type: Zcl.DataType.CHAR_STR, default: "Computime", maxLen: 32 },
        modelId: { name: "modelId", ID: 0x0005, type: Zcl.DataType.CHAR_STR, default: "SAU2AG1", maxLen: 32 },
    },
    commands: {},
    commandsResponse: {},
};

// The commands the devices send to the coordinator. Herdsman looks a command up by the direction bit of the frame: the thermostat sets the
// server-to-client bit and the wiring centre the client-to-server bit, so these are declared in both tables.
const toCoordinator = {
    syncRequest: rawCommand("syncRequest", 0x10),
    echo: rawCommand("echo", 0x33),
    syncAck: rawCommand("syncAck", 0x37),
    replacedThermostat: rawCommand("replacedThermostat", 0x1a),
    wiringCentreRequest: rawCommand("wiringCentreRequest", 0x16),
};

// What only the wiring centre sends, with the client-to-server bit. 0x88 and 0x84 answer a zone request and confirmation when the coordinator
// makes them (PROTOCOL.md section 7.6). 0xA9 has no payload and is probably the Pair button.
const fromWiringCentre = {
    pairAck: rawCommand("pairAck", 0x88),
    pairDone: rawCommand("pairDone", 0x84),
    pairButton: rawCommand("pairButton", 0xa9),
};

const salusCluster = {
    name: CLUSTER,
    ID: 0xfc00,
    manufacturerCode: Zcl.ManufacturerCode.COMPUTIME,
    attributes: {},
    commands: { ...toCoordinator, ...fromWiringCentre },
    commandsResponse: {
        ...toCoordinator,
        zoneReport: rawCommand("zoneReport", 0x12),
        pairConfirm: rawCommand("pairConfirm", 0x14),
        pairRequest: rawCommand("pairRequest", 0x18),
        record: rawCommand("record", 0x31),
        write: rawCommand("write", 0x32),
        syncResponse: rawCommand("syncResponse", 0x81),
        wiringCentreResponse: rawCommand("wiringCentreResponse", 0x86),
    },
};

// The sync response and writes must never be replayed late, so they bypass the request queue.
const send = (endpoint, commandName, payload) =>
    endpoint.commandResponse(CLUSTER, commandName, { payload }, { disableDefaultResponse: true, sendPolicy: "immediate" });

const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const warned = new Set();
function warnOnce(key, message) {
    if (!warned.has(key)) {
        warned.add(key);
        logger.warning(message, NS);
    }
}

// Seconds the host's clock is ahead of UTC at `date`, summer time included.
const localOffset = (date) => Math.round(-date.getTimezoneOffset() * 60);

// The standard offset is the lower of the host's offsets on 1 January and 1 July, which holds in both hemispheres, and the summer time offset
// the higher one.
function seasonalOffsets(now) {
    const year = now.getFullYear();
    const offsets = [localOffset(new Date(year, 0, 1)), localOffset(new Date(year, 6, 1))];
    return { standard: Math.min(...offsets), summer: Math.max(...offsets) };
}

// The index of a standard offset in the gateway's table. An offset that the table lacks gets the nearest index, with a warning.
function timeZoneIndex(standardOffset) {
    const exact = TIME_ZONE_OFFSETS.indexOf(standardOffset);
    if (exact !== -1) {
        return exact;
    }
    const distance = (index) => Math.abs(TIME_ZONE_OFFSETS[index] - standardOffset);
    const nearest = TIME_ZONE_OFFSETS.reduce((best, _, index) => (distance(index) < distance(best) ? index : best), 0);
    warnOnce(
        `offset ${standardOffset}`,
        `Time zone ${hostTimeZone()} has the standard UTC offset ${standardOffset} s, which the gateway's time zone table lacks; ` +
            `using the nearest, index ${nearest} (${TIME_ZONE_OFFSETS[nearest]} s)`,
    );
    return nearest;
}

// zigbee2mqtt in Docker has no time zone unless TZ is set, and the devices then get UTC as their clock.
function warnIfHostHasNoRegion() {
    const zone = hostTimeZone();
    if (!zone?.includes("/") || zone.startsWith("Etc/")) {
        warnOnce(
            `region ${zone}`,
            `The time zone of the host is ${zone}, so the Salus devices get a clock without summer time. ` +
                "Set TZ for zigbee2mqtt, for example TZ=Europe/Copenhagen",
        );
    }
}

// Byte 0 is the device number the coordinator assigns. A wiring centre keeps the first number it receives until a factory reset and
// refuses zone pairing (0x88 status 01) unless that number is a wiring centre's.
function syncResponsePayload(now, endpointId = THERMOSTAT_ENDPOINT) {
    const offset = localOffset(now);
    const { standard, summer } = seasonalOffsets(now);
    const localSeconds = Math.floor(now.getTime() / 1000) + offset;
    const payload = Buffer.alloc(15);
    payload[0] = endpointId === WIRING_CENTRE_ENDPOINT ? WIRING_CENTRE_NUMBER : THERMOSTAT_NUMBER;
    payload.writeUInt32LE(localSeconds - SECONDS_1970_TO_2000, 2);
    payload[6] = 0x02 | (offset > standard ? 0x01 : 0);
    payload[7] = timeZoneIndex(standard);
    payload[8] = Math.round((summer - standard) / 3600);
    payload.fill(0xff, 9, 13);
    payload[13] = 0x31;
    return payload;
}

async function sendSyncResponse(endpoint) {
    const now = new Date();
    lastSync.set(endpoint.deviceIeeeAddress, { at: now.getTime(), offset: localOffset(now) });
    // The greeting gives a wiring centre its number, so the one that is greeted holds it.
    if (endpoint.ID === WIRING_CENTRE_ENDPOINT) {
        wiringCentres.set(WIRING_CENTRE_NUMBER, endpoint);
    }
    try {
        await send(endpoint, "syncResponse", syncResponsePayload(now, endpoint.ID));
    } catch (error) {
        lastSync.delete(endpoint.deviceIeeeAddress);
        logger.warning(`Sync response to ${endpoint.deviceIeeeAddress} failed (${error.message})`, NS);
    }
}

// The answer to a request for wiring centre `number` (0x16): 01 and the short address of the wiring centre that holds the number,
// little-endian, or 00 ff ff when none does.
async function sendWiringCentre(endpoint, number) {
    const wiringCentre = wiringCentres.get(number);
    const payload = Buffer.from([0x00, 0xff, 0xff]);
    if (wiringCentre) {
        payload[0] = 0x01;
        payload.writeUInt16LE(wiringCentre.deviceNetworkAddress, 1);
    }
    logger.info(`${endpoint.deviceIeeeAddress} asked for wiring centre ${number}, answering ${payload.toString("hex")}`, NS);
    try {
        await send(endpoint, "wiringCentreResponse", payload);
    } catch (error) {
        logger.warning(`Wiring centre answer to ${endpoint.deviceIeeeAddress} failed (${error.message})`, NS);
    }
}

// The thermostat gets the clock and summer time from the sync response, so it is repeated daily and when the offset from UTC changes.
function resyncClock(endpoint) {
    const last = lastSync.get(endpoint.deviceIeeeAddress);
    const now = new Date();
    if (!last || now.getTime() - last.at > SYNC_INTERVAL_MS || localOffset(now) !== last.offset) {
        void sendSyncResponse(endpoint);
    }
}

// The stop event names the device that stops: what the device waits for fails, what is queued for it does not run, and what the converter
// knows about it is dropped. Work that starts afterwards begins from nothing.
function stopDevice(ieeeAddr) {
    const stopped = new Error(`${ieeeAddr} stopped`);
    for (const [key, echo] of pendingEchoes) {
        if (key.startsWith(`${ieeeAddr}/`)) {
            echo.reject(stopped);
        }
    }
    settingsWaiters.get(ieeeAddr)?.reject(stopped);
    for (const pairing of zonePairings) {
        if (pairing.ieeeAddr === ieeeAddr) {
            pairing.reject(stopped);
        }
    }
    const queue = queues.get(ieeeAddr);
    if (queue) {
        queue.stopped = true;
    }
    for (const known of [lastHandle, settingsRecords, queues, lastSync, systemModeBytes]) {
        known.delete(ieeeAddr);
    }
    for (const [number, endpoint] of wiringCentres) {
        if (endpoint.deviceIeeeAddress === ieeeAddr) {
            wiringCentres.delete(number);
        }
    }
}

// zigbee2mqtt drops what a device sends while it is being interviewed, so its greeting is answered when it has joined.
// `afterSync` runs once that response is sent.
const onJoin = (endpointId, afterSync) => async (event) => {
    const { type, data } = event;
    if (type === "start") {
        warnIfHostHasNoRegion();
    }
    if (type === "stop") {
        stopDevice(data.ieeeAddr);
    }
    if (type === "deviceAnnounce" || (type === "deviceInterview" && data.status === "successful")) {
        const endpoint = data.device.getEndpoint(endpointId);
        if (endpoint) {
            await sendSyncResponse(endpoint);
            await afterSync?.(endpoint);
        }
    }
};

// No echo is awaited: the wiring centre answers with a 0x33 that the zone_table converter publishes.
const requestZoneTable = (endpoint) => send(endpoint, "write", Buffer.from([nextHandle(endpoint.deviceIeeeAddress), ...ZONE_TABLE_REQUEST]));

const requestZoneTableAfterJoin = (endpoint) =>
    requestZoneTable(endpoint).catch((error) => logger.warning(`Zone table request to ${endpoint.deviceIeeeAddress} failed (${error.message})`, NS));

const onWiringCentreJoin = onJoin(WIRING_CENTRE_ENDPOINT, requestZoneTableAfterJoin);

// zigbee2mqtt sends start for every device when it starts, and the wiring centre keeps its number across that, so it is known again at once.
const onWiringCentreEvent = async (event) => {
    if (event.type === "start") {
        const endpoint = event.data.device.getEndpoint(WIRING_CENTRE_ENDPOINT);
        if (endpoint) {
            wiringCentres.set(WIRING_CENTRE_NUMBER, endpoint);
        }
    }
    await onWiringCentreJoin(event);
};

const bcd = (byte) => (byte >> 4) * 10 + (byte & 0x0f);
const toBcd = (value) => (Math.floor(value / 10) << 4) | (value % 10);

// Four BCD digits hold the value times 100. Negative values are stored as 11000 minus the magnitude.
function bcdCelsius(record, offset) {
    const raw = bcd(record[offset]) * 100 + bcd(record[offset + 1]);
    return (raw >= 11000 ? 11000 - raw : raw) / 100;
}

// The same two bytes for a value that is not negative: 7.5 is 07 50.
function bcdBytes(celsius) {
    const hundredths = Math.round(celsius * 100);
    return [toBcd(Math.floor(hundredths / 100)), toBcd(hundredths % 100)];
}

// The temperature offset of the settings record is signed differently: bit 7 of the first byte is the sign, -0.5 is 80 50.
function signedBcdCelsius(record, offset) {
    const hundredths = bcd(record[offset] & 0x7f) * 100 + bcd(record[offset + 1]);
    return (record[offset] & 0x80) !== 0 && hundredths !== 0 ? -hundredths / 100 : hundredths / 100;
}

function signedBcdBytes(celsius) {
    const [high, low] = bcdBytes(Math.abs(celsius));
    return [celsius < 0 ? high | 0x80 : high, low];
}

// Codes outside the known tables are left unpublished.
const published = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

function parseStatusRecord(record, ieeeAddr) {
    if (record.length < STATUS_MIN_LENGTH) {
        logger.debug(`Ignoring short status record (${record.length} bytes) from ${ieeeAddr}`, NS);
        return;
    }
    systemModeBytes.set(ieeeAddr, record[STATUS.systemMode]);
    const holdType = record[STATUS.holdType];
    const placeholder = record.readUInt16BE(STATUS.temperature) === STATUS_PLACEHOLDER_TEMPERATURE;
    return published({
        local_temperature: placeholder ? undefined : bcdCelsius(record, STATUS.temperature),
        // Bytes 9-10 are the setpoint of the system mode the thermostat is in, heating or cooling; the other one is stored separately and
        // not in the record. It is named as the heating setpoint because zigbee2mqtt's Home Assistant discovery only keeps a single
        // temperature when the climate has this one setpoint and no cooling setpoint.
        current_heating_setpoint: bcdCelsius(record, STATUS.setpoint),
        schedule_setpoint: bcdCelsius(record, STATUS.scheduleSetpoint),
        system_mode: holdType === HOLD_TYPE_STANDBY ? "off" : SYSTEM_MODES[record[STATUS.systemMode]],
        hold_type: HOLD_TYPES[holdType],
        preset: PRESETS[holdType],
        running_state: RUNNING_STATES[record[STATUS.runningState]],
        child_lock: { 0: "UNLOCK", 1: "LOCK" }[record[STATUS.keypadLock]],
        humidity: bcd(record[STATUS.humidity]),
        battery: BATTERY_PERCENT[record[STATUS.battery]],
    });
}

function parseSettingsRecord(record, ieeeAddr) {
    if (record.length < SETTINGS_LENGTH) {
        logger.debug(`Ignoring short settings record (${record.length} bytes) from ${ieeeAddr}`, NS);
        return;
    }
    const copy = Buffer.from(record);
    settingsRecords.set(ieeeAddr, copy);
    settingsWaiters.get(ieeeAddr)?.resolve(copy);
    return published({
        frost_setpoint: bcdCelsius(record, SETTINGS.frostSetpoint),
        temperature_offset: signedBcdCelsius(record, SETTINGS.temperatureOffset),
        heat_control: HEAT_CONTROL[record[SETTINGS.heatControl]],
        min_heat_setpoint: bcdCelsius(record, SETTINGS.minHeatSetpoint),
        max_heat_setpoint: bcdCelsius(record, SETTINGS.maxHeatSetpoint),
        min_cool_setpoint: bcdCelsius(record, SETTINGS.minCoolSetpoint),
        max_cool_setpoint: bcdCelsius(record, SETTINGS.maxCoolSetpoint),
        display_resolution: DISPLAY_RESOLUTIONS[record[SETTINGS.displayResolution]],
    });
}

const RECORD_PARSERS = { [RECORD_STATUS]: parseStatusRecord, [RECORD_SETTINGS]: parseSettingsRecord };

const shortAddress = (address) => `0x${address.toString(16).padStart(4, "0")}`;

// The short address of the thermostat in zone `index` (0-7) of a B70 record, or null while the zone is free.
function zoneAddress(record, index) {
    const address = record.readUInt16BE(ZONE_TABLE.firstSlot + ZONE_TABLE.slotLength * index);
    return address === FREE_ZONE ? null : address;
}

// A thermostat is named by its IEEE address, which is what zigbee2mqtt knows it by (a converter cannot reach the friendly names). herdsman does
// not export its Device class, but that is the class of `device`, and it finds a device by network address. An address that no device has, as
// after a rejoin under a new one, stays a short address.
const zoneName = (device, address) => (address === null ? null : (device.constructor.byNetworkAddress?.(address)?.ieeeAddr ?? shortAddress(address)));

// A frame that is only logged, with its payload.
const loggedFrame = (type, level, text) => ({
    cluster: CLUSTER,
    type,
    convert: (model, msg) => {
        logger[level](`${text} from ${msg.device.ieeeAddr}, payload ${msg.data.payload.toString("hex") || "empty"}`, NS);
    },
});

const fzLocal = {
    sync_request: {
        cluster: CLUSTER,
        type: "commandSyncRequest",
        convert: async (model, msg) => {
            await sendSyncResponse(msg.endpoint);
        },
    },
    record: {
        cluster: CLUSTER,
        type: "commandRecord",
        convert: (model, msg) => {
            const record = msg.data.payload;
            const parse = RECORD_PARSERS[record[0]];
            if (!parse) {
                const type = record.subarray(0, 1).toString("hex");
                logger.debug(`Ignoring record 0x${type} (${record.length} bytes) from ${msg.device.ieeeAddr}`, NS);
                return;
            }
            return parse(record, msg.device.ieeeAddr);
        },
    },
    clock_sync: {
        cluster: CLUSTER,
        type: "commandRecord",
        convert: (model, msg) => {
            if (msg.data.payload[0] === RECORD_STATUS) {
                resyncClock(msg.endpoint);
            }
        },
    },
    write_echo: {
        cluster: CLUSTER,
        type: "commandEcho",
        convert: (model, msg) => {
            const echo = msg.data.payload;
            const pending = pendingEchoes.get(echoKey(msg.device.ieeeAddr, echo[0]));
            const awaited = pending?.code === echo.subarray(1, 4).toString("latin1") ? pending : undefined;
            logger.debug(`B-command echo ${echo.toString("hex")} from ${msg.device.ieeeAddr}${awaited ? "" : " (not awaited)"}`, NS);
            awaited?.resolve();
        },
    },
    zone_table: {
        cluster: CLUSTER,
        type: "commandEcho",
        convert: (model, msg) => {
            const echo = msg.data.payload;
            if (echo.subarray(1, 4).toString("latin1") !== ZONE_TABLE.code) {
                return;
            }
            if (echo.length < ZONE_TABLE_LENGTH) {
                logger.debug(`Ignoring short zone table (${echo.length} bytes) from ${msg.device.ieeeAddr}`, NS);
                return;
            }
            const addresses = ZONE_KEYS.map((key, index) => zoneAddress(echo, index));
            for (const pairing of zonePairings) {
                if (pairing.zones.every((zone) => addresses[zone - 1] === pairing.short)) {
                    pairing.resolve();
                }
            }
            return Object.fromEntries(ZONE_KEYS.map((key, index) => [key, zoneName(msg.device, addresses[index])]));
        },
    },
    sync_ack: {
        cluster: CLUSTER,
        type: "commandSyncAck",
        convert: (model, msg) => {
            logger.debug(`Sync acknowledgement ${msg.data.payload.toString("hex")} from ${msg.device.ieeeAddr}`, NS);
        },
    },
    wiring_centre_request: {
        cluster: CLUSTER,
        type: "commandWiringCentreRequest",
        convert: async (model, msg) => {
            const request = msg.data.payload;
            if (request.length < 1) {
                logger.debug(`Ignoring wiring centre request without a number from ${msg.device.ieeeAddr}`, NS);
                return;
            }
            await sendWiringCentre(msg.endpoint, request[0]);
        },
    },
    replaced_thermostat: {
        cluster: CLUSTER,
        type: "commandReplacedThermostat",
        convert: (model, msg) => {
            const report = msg.data.payload;
            if (report.length < REPLACED_THERMOSTAT.length) {
                logger.debug(`Ignoring short replaced thermostat report (${report.length} bytes) from ${msg.device.ieeeAddr}`, NS);
                return;
            }
            return { replaced_thermostat: zoneName(msg.device, report.readUInt16LE(REPLACED_THERMOSTAT.address)) };
        },
    },
    pair_ack: loggedFrame("commandPairAck", "debug", "Zone pairing ack (0x88)"),
    pair_done: loggedFrame("commandPairDone", "debug", "Zone pairing done (0x84)"),
    pair_button: loggedFrame("commandPairButton", "info", "Command 0xa9 (probably the Pair button)"),
    // A frame herdsman cannot parse comes as a raw message, which is the whole ZCL frame, header included.
    unknown_command: {
        cluster: CLUSTER,
        type: "raw",
        convert: (model, msg) => {
            const header = Zcl.Header.fromBuffer(msg.data);
            if (header?.isSpecific) {
                const id = header.commandIdentifier.toString(16).padStart(2, "0");
                logger.info(`Unknown command 0x${id} from ${msg.device.ieeeAddr}: ${msg.data.subarray(header.length).toString("hex")}`, NS);
            }
        },
    },
};

// Sends '<handle> B<d1><d2> <values>' and resolves once the thermostat echoes the same handle and code.
async function writeBCommand(endpoint, code, ...values) {
    utils.assertEndpoint(endpoint);
    const ieeeAddr = endpoint.deviceIeeeAddress;
    const handle = nextHandle(ieeeAddr);
    const key = echoKey(ieeeAddr, handle);
    const echoed = { code, ...waiter() };
    pendingEchoes.set(key, echoed);
    let timer;
    try {
        await send(endpoint, "write", Buffer.from([handle, ...Buffer.from(code, "latin1"), ...values]));
        const noEcho = new Error(`No ${code} echo from ${ieeeAddr} within ${ECHO_TIMEOUT_MS} ms`);
        timer = setTimeout(() => echoed.reject(noEcho), ECHO_TIMEOUT_MS);
        await echoed.promise;
    } finally {
        clearTimeout(timer);
        pendingEchoes.delete(key);
    }
}

// B74 makes the thermostat send a 0x72. It sends none by itself after a B11 write.
const requestSettings = (endpoint) => writeBCommand(endpoint, "B74", 0, 0, 0, 0, 0);

// The 0x72 that a B74 brings, as a copy. The waiter is in place before the request, so a 0x72 that comes before the echo is not missed.
async function readSettings(endpoint) {
    const ieeeAddr = endpoint.deviceIeeeAddress;
    const arrived = waiter();
    settingsWaiters.set(ieeeAddr, arrived);
    let timer;
    try {
        await requestSettings(endpoint);
        const noRecord = new Error(`No settings record (0x72) from ${ieeeAddr} within ${SETTINGS_TIMEOUT_MS} ms after B74`);
        timer = setTimeout(() => arrived.reject(noRecord), SETTINGS_TIMEOUT_MS);
        return Buffer.from(await arrived.promise);
    } finally {
        clearTimeout(timer);
        settingsWaiters.delete(ieeeAddr);
    }
}

// Bytes 40-41 decoded with the counter in byte 1.
function pinOf(record) {
    const counter = record[SETTINGS.counter];
    const high = (record[SETTINGS.pin] - 2 * counter) & 0xff;
    const low = (record[SETTINGS.pin + 1] + (counter >> 2)) & 0xff;
    return (high << 8) | low;
}

// zigbee2mqtt lets messages for a device overlap. A settings write reads the record, changes it and writes it back, and a climate message picks
// its setpoint command from the mode that the messages before it left, so the writes of a device run one at a time.
function serialized(ieeeAddr, task) {
    let queue = queues.get(ieeeAddr);
    if (!queue) {
        queue = { tail: Promise.resolve(), stopped: false };
        queues.set(ieeeAddr, queue);
    }
    const result = queue.tail.then(() => {
        if (queue.stopped) {
            throw new Error(`${ieeeAddr} stopped`);
        }
        return task();
    });
    queue.tail = result.catch(() => {});
    return result;
}

// Reads a fresh 0x72, writes it back with B11 after `change` has edited it, then asks for another 0x72, which publishes the new settings.
// `kind` is SETTINGS_WRITE.user or SETTINGS_WRITE.admin.
async function writeSettings(endpoint, kind, change) {
    utils.assertEndpoint(endpoint);
    const ieeeAddr = endpoint.deviceIeeeAddress;
    await serialized(ieeeAddr, async () => {
        const record = await readSettings(endpoint);
        if (pinOf(record) !== NO_PIN) {
            throw new Error(`${ieeeAddr} has a PIN set, so its settings are not written: a wrong PIN would lock its keys`);
        }
        change(record);
        record[0] = kind;
        record[SETTINGS.counter] = NO_PIN_BYTES.counter;
        record[SETTINGS.pin] = NO_PIN_BYTES.pinHigh;
        record[SETTINGS.pin + 1] = NO_PIN_BYTES.pinLow;
        await writeBCommand(endpoint, "B11", ...record.subarray(0, SETTINGS_LENGTH));
        await requestSettings(endpoint).catch((error) => logger.warning(`Settings request to ${ieeeAddr} failed (${error.message})`, NS));
    });
}

// Rounds to the 0.5 °C steps of the thermostat and checks the range.
function halfDegrees(value, key, min, max) {
    const celsius = Math.round(utils.toNumber(value, key) * 2) / 2;
    if (celsius < min || celsius > max) {
        throw new Error(`${key} must be between ${min} and ${max}, got ${value}`);
    }
    return celsius;
}

const modeByteOf = (mode) => (Object.hasOwn(SYSTEM_MODE_SET, mode) ? SYSTEM_MODE_SET[mode] : undefined);

// The values of a system_mode / preset message that cannot be written. Off is a hold type of its own, so no preset goes with it.
function checkHoldType(mode, preset) {
    if (mode !== undefined && mode !== "off" && modeByteOf(mode) === undefined) {
        throw new Error(`system_mode must be off, heat or cool, got ${mode}`);
    }
    if (preset !== undefined && !Object.hasOwn(HOLD_TYPE_SET, preset)) {
        throw new Error(`preset must be one of ${Object.keys(HOLD_TYPE_SET).join(", ")}, got ${preset}`);
    }
    if (mode === "off" && preset !== undefined) {
        throw new Error("preset cannot be set together with system_mode off, as both are hold types");
    }
}

// Off is the standby hold type. On is permanent hold plus the system mode, the pair the Salus gateway sends.
// The mode byte that picks the setpoint command follows the echo, as the next 0x71 can be minutes away.
async function writeSystemMode(endpoint, mode) {
    if (mode === "off") {
        await writeBCommand(endpoint, "B20", HOLD_TYPE_STANDBY);
    } else {
        await writeBCommand(endpoint, "B20", HOLD_TYPE_SET.permanent_hold);
        await writeBCommand(endpoint, "B48", SYSTEM_MODE_SET[mode]);
        systemModeBytes.set(endpoint.deviceIeeeAddress, SYSTEM_MODE_SET[mode]);
    }
}

// The command and the rounded, checked setpoint for a write of the one setpoint. The system mode decides both: the mode written in the same
// message, else the mode byte of the last 0x71 or echoed B48, else the mode zigbee2mqtt last published (a 0x71 may not have come yet after a
// restart), else heat. Off is not a mode here: standby keeps the mode byte as it was.
function setpointWrite(endpoint, writtenMode, value, publishedState) {
    const ieeeAddr = endpoint.deviceIeeeAddress;
    const modeByte = modeByteOf(writtenMode) ?? systemModeBytes.get(ieeeAddr) ?? modeByteOf(publishedState?.system_mode);
    const { command, minByte, maxByte, min, max } = SETPOINTS[modeByte === SYSTEM_MODE_SET.cool ? "cool" : "heat"];
    const record = settingsRecords.get(ieeeAddr);
    const [low, high] = record ? [bcdCelsius(record, minByte), bcdCelsius(record, maxByte)] : [min, max];
    return { command, setpoint: halfDegrees(value, "current_heating_setpoint", low, high) };
}

// Zone numbers 1 to 8 separated by commas or spaces, with the word replace in front to take over zones that another thermostat holds.
function parseZones(key, value) {
    const words = String(value).toLowerCase().split(/[\s,]+/).filter(Boolean);
    const replace = words[0] === "replace";
    const zones = words.slice(replace ? 1 : 0);
    if (zones.length === 0 || !zones.every((zone) => /^[1-8]$/.test(zone))) {
        throw new Error(
            `${key} must be zone numbers 1 to 8 separated by commas, e.g. 1,4, with replace in front to take over zones another thermostat holds, got ${value}`,
        );
    }
    return { replace, zones: [...new Set(zones.map(Number))].toSorted((a, b) => a - b) };
}

// Sends B47 to the thermostat and waits until the zone table of the wiring centre shows the thermostat in all the zones. The echo of the B47 only
// says that the thermostat got it: the wiring centre can still refuse a zone that is taken, and then no table comes.
// A replace sends the reset form first and waits for its echo, as a thermostat that still believes it holds the zone does not pair without it
// (PROTOCOL.md section 7.7).
async function pairZones(endpoint, zones, replace) {
    utils.assertEndpoint(endpoint);
    const wiringCentre = wiringCentres.get(WIRING_CENTRE_NUMBER);
    if (!wiringCentre) {
        throw new Error("No wiring centre is known to pair zones with: it has to join zigbee2mqtt first");
    }
    const args = Buffer.alloc(ZONE_PAIRING.length);
    args.set([0x00, 0x11]);
    args.writeUInt16LE(WIRING_CENTRE_NUMBER, 2);
    args.writeUInt16LE(wiringCentre.deviceNetworkAddress, 4);
    args[6] = ZONE_PAIRING.state;
    args[ZONE_PAIRING.replaceByte] = replace ? 1 : 0;
    for (const zone of zones) {
        args[ZONE_PAIRING.firstZoneByte + zone - 1] = 1;
    }
    if (replace) {
        const reset = Buffer.alloc(ZONE_PAIRING.length);
        reset.set([0x00, 0x11, 0xff, 0xff, 0xff, 0xff, ZONE_PAIRING.resetState]);
        await writeBCommand(endpoint, ZONE_PAIRING.code, ...reset);
    }
    const pairing = { ieeeAddr: endpoint.deviceIeeeAddress, zones, short: endpoint.deviceNetworkAddress, ...waiter() };
    zonePairings.add(pairing);
    let timer;
    try {
        await writeBCommand(endpoint, ZONE_PAIRING.code, ...args);
        const wait = ZONE_PAIRING_MS * zones.length;
        const notShown = new Error(
            `The zone table of the wiring centre does not show ${endpoint.deviceIeeeAddress} in zone ${zones.join(", ")} ` +
                `within ${wait / 1000} s of the B47; it refuses a zone that another thermostat holds unless the value starts with replace`,
        );
        timer = setTimeout(() => pairing.reject(notShown), wait);
        await pairing.promise;
    } finally {
        clearTimeout(timer);
        zonePairings.delete(pairing);
    }
}

// Spaces are ignored. Buffer.from would send what it keeps of a text that has a stray character or an odd digit, so those are refused.
function hexBytes(key, value) {
    const digits = String(value).replace(/\s+/g, "");
    if (!/^([0-9a-f]{2})+$/i.test(digits)) {
        throw new Error(`${key} must be hex in whole bytes, got ${value}`);
    }
    return Buffer.from(digits, "hex");
}

const tzLocal = {
    // zigbee2mqtt runs the keys of a message in the order they are written, but calls a converter only once per message, for the first of its keys.
    // The keys that decide the hold type are therefore one converter, which writes the system mode first, then the preset, so that the preset is
    // the hold type that is left, and last the setpoint, with the command of the mode just written.
    climate: {
        key: ["system_mode", "current_heating_setpoint", "preset"],
        convertSet: async (entity, key, value, meta) => {
            utils.assertEndpoint(entity);
            const { system_mode: mode, current_heating_setpoint: setpoint, preset } = { ...meta.message, [key]: value };
            return await serialized(entity.deviceIeeeAddress, async () => {
                // Checked before anything is written, so a value that is refused leaves the rest of the message unwritten too.
                checkHoldType(mode, preset);
                const write = setpoint === undefined ? undefined : setpointWrite(entity, mode, setpoint, meta.state);
                const state = {};
                if (mode !== undefined) {
                    await writeSystemMode(entity, mode);
                    state.system_mode = mode;
                }
                if (preset !== undefined) {
                    await writeBCommand(entity, "B20", HOLD_TYPE_SET[preset]);
                    state.preset = preset;
                    state.hold_type = preset;
                }
                if (write) {
                    await writeBCommand(entity, write.command, write.setpoint / 0.5 + SETPOINT_BYTE_OFFSET);
                    state.current_heating_setpoint = write.setpoint;
                }
                return { state };
            });
        },
    },
    child_lock: {
        key: ["child_lock"],
        convertSet: async (entity, key, value) => {
            if (!Object.hasOwn(KEYPAD_LOCK, value)) {
                throw new Error(`${key} must be LOCK or UNLOCK, got ${value}`);
            }
            await writeBCommand(entity, "B03", 0x00, 0x00, KEYPAD_LOCK[value], ...Array(10).fill(0x00));
            return { state: { child_lock: value } };
        },
    },
    // The settings are not published back by the setters: the 0x72 that follows the write does that.
    frost_setpoint: {
        key: ["frost_setpoint"],
        convertSet: async (entity, key, value) => {
            const setpoint = halfDegrees(value, key, FROST_MIN, FROST_MAX);
            await writeSettings(entity, SETTINGS_WRITE.user, (record) => record.set(bcdBytes(setpoint), SETTINGS.frostSetpoint));
        },
    },
    temperature_offset: {
        key: ["temperature_offset"],
        convertSet: async (entity, key, value) => {
            const offset = halfDegrees(value, key, OFFSET_MIN, OFFSET_MAX);
            await writeSettings(entity, SETTINGS_WRITE.user, (record) => record.set(signedBcdBytes(offset), SETTINGS.temperatureOffset));
        },
    },
    heat_control: {
        key: ["heat_control"],
        convertSet: async (entity, key, value) => {
            if (!Object.hasOwn(HEAT_CONTROL_SET, value)) {
                throw new Error(`${key} must be one of ${Object.keys(HEAT_CONTROL_SET).join(", ")}, got ${value}`);
            }
            await writeSettings(entity, SETTINGS_WRITE.admin, (record) => {
                record[SETTINGS.heatControl] = HEAT_CONTROL_SET[value];
            });
        },
    },
    wiring_centre_zones: {
        key: ["wiring_centre_zones"],
        convertSet: async (entity, key, value) => {
            const { zones, replace } = parseZones(key, value);
            await pairZones(entity, zones, replace);
        },
    },
    min_heat_setpoint: {
        key: ["min_heat_setpoint"],
        convertSet: async (entity, key, value) => {
            const setpoint = halfDegrees(value, key, SETPOINT_MIN, SETPOINT_MAX - HEAT_LIMIT_GAP);
            await writeSettings(entity, SETTINGS_WRITE.admin, (record) => {
                const most = bcdCelsius(record, SETTINGS.maxHeatSetpoint) - HEAT_LIMIT_GAP;
                if (setpoint > most) {
                    throw new Error(`${key} must be at most ${most} (the maximum heating setpoint less ${HEAT_LIMIT_GAP}), got ${value}`);
                }
                record.set(bcdBytes(setpoint), SETTINGS.minHeatSetpoint);
            });
        },
    },
    max_heat_setpoint: {
        key: ["max_heat_setpoint"],
        convertSet: async (entity, key, value) => {
            const setpoint = halfDegrees(value, key, SETPOINT_MIN + HEAT_LIMIT_GAP, SETPOINT_MAX);
            await writeSettings(entity, SETTINGS_WRITE.admin, (record) => {
                const least = bcdCelsius(record, SETTINGS.minHeatSetpoint) + HEAT_LIMIT_GAP;
                if (setpoint < least) {
                    throw new Error(`${key} must be at least ${least} (the minimum heating setpoint plus ${HEAT_LIMIT_GAP}), got ${value}`);
                }
                record.set(bcdBytes(setpoint), SETTINGS.maxHeatSetpoint);
            });
        },
    },
    display_resolution: {
        key: ["display_resolution"],
        convertSet: async (entity, key, value) => {
            const resolution = utils.toNumber(value, key);
            if (!Object.hasOwn(DISPLAY_RESOLUTION_SET, resolution)) {
                throw new Error(`${key} must be ${Object.keys(DISPLAY_RESOLUTION_SET).toSorted().join(" or ")}, got ${value}`);
            }
            await writeSettings(entity, SETTINGS_WRITE.admin, (record) => {
                record[SETTINGS.displayResolution] = DISPLAY_RESOLUTION_SET[resolution];
            });
        },
    },
    // A get on any zone asks for the whole table.
    zone_table: {
        key: ZONE_KEYS,
        convertGet: async (entity) => {
            utils.assertEndpoint(entity);
            await requestZoneTable(entity);
        },
    },
    // The two raw tools for protocol work are converters only, not exposes, so they stay out of Home Assistant; zigbee2mqtt finds the converter of
    // a /set message by its key, so they work over MQTT.
    // Sends any 0xFC00 frame the cluster declares, given as hex: the command ID, then the payload, e.g. "18 01080000ff0000".
    salus_frame: {
        key: ["salus_frame"],
        convertSet: async (entity, key, value) => {
            utils.assertEndpoint(entity);
            const bytes = hexBytes(key, value);
            const command = Object.values(salusCluster.commandsResponse).find((c) => c.ID === bytes[0]);
            if (!command) {
                throw new Error(`${key} must start with a declared command ID, got ${value}`);
            }
            await send(entity, command.name, bytes.subarray(1));
        },
    },
    // Sends any B-command given as hex without the handle, e.g. "42323101" for B21 01, or "4237307eaaaaa88000000078" for the zone table.
    salus_command: {
        key: ["salus_command"],
        convertSet: async (entity, key, value) => {
            const bytes = hexBytes(key, value);
            if (bytes.length < 3 || bytes[0] !== 0x42) {
                throw new Error(`${key} must be hex starting with a B-command code (42 ...), got ${value}`);
            }
            await writeBCommand(entity, bytes.subarray(0, 3).toString("latin1"), ...bytes.subarray(3));
        },
    },
};

// The device picture of the SQ610RFNH for the zigbee2mqtt frontend: images/SQ610RFNH.png as a 256x256 WebP data URI.
const THERMOSTAT_ICON =
    "data:image/webp;base64,UklGRkQWAABXRUJQVlA4WAoAAAAQAAAA/wAA/wAAQUxQSEQGAAABd8egbSRH5xx/1OUrgYjI4a8cuciZiwlJkNs8yofTyvPs2RJq20hS7p6x/4LxKPooov8TALR4uyB52HU65363YYWj87sQyNouTrIV2EF3+/80kvP7/SSZZo6xCnPSYcXJv8R9quvSMnWXLh0zVknHnBzjgCXP2vo9z1qWPeub0WV2sokIWLRtRW14GfpkqB7vAyJmrXzDf8EMW3YAfYmZA8QW0L8fXHtzwSW7pPXTth88L1sAQSRIZLEYJJSkIk6lytJodvK7b4GWoH58ApqTLaEUKBIZDSKZRCpTMkrkcJfIUhkNlUyVGEQUCRRe0uaz5z/jRWe7tUECICSRFGIYiywRcSaiRKrd8aYnklQmsYgypRy2CHMZMziHhwT6OUBcNkEiBQpJKhPxUKg0lmlESRYNBjJOZTyQlMYik6RE55DpplPsSAKArQDZN932Q9oytkQKKYrkMJZJLNNEqETFe2K5KxJpSnFci0pEhFvAFrjroLJlYrJQ/gjQX6k5sRApgVKKZECbnhpKmUkxGKpBJqNURYmQaSxjQaIzohaddoR7ZQSMpV+/6XX/VUpCkUiVGkYiSUUWU5RF6S4VpUoNJCWJjGMSChaa7fzH/MYFtH2l/U+8/Y6UqZSZlGoL9NMGt4XtQpulH9/syUWOX3hkXrYtJZeWEdzySG+zj+QGW4kWtsvZLDwOfTlsSFAQZuz372HsTbMAQUjX3gEY9E+lLG8JewILN0Do7VqoAn9Z5rAMvAsxhd5h2OnXeOf/atsADW33u8yr/hze7m8L7Jr/vJPBhv+P1X+1f/1u+N/t6v+6w1VAkZ3+jdf/q60BOLju39DKP5O3/Ruyq/9557a/w2t/DlwFOLjmf93Brv/fd/v/P9W2/zev/zur/81rfw6v/Tl25f+9C17/+97F2p/DGPqUB94leOyoDfwPb33gbqaw1+bQV0RcATS1/rfwvO1fza78c3jVnxiAV/y/O6YK/rQz+KmywX8JfprZsDfEOMHQv4xl6NM5Agi78z1QFfIn2Y8AQ16kUh8ClgG/5QDhrtuYAv0pG52vW1zaCxjEyyoMHtY+0xf+Pv4bEIaOdKuuNrTJ8/z8pl08ceLEn0ISBo80F8ZoXYwvjEajqR6N81wXs42yssA4AOwvIS6XaGoxPSFjTDG9OB6Np3o6mRptNjbKkpkRCREBmaGsqpIJ++NXlrygpBk7kWZjTK6LyeXRaDwxZy+RKYqNWlvM0CCN7khjgdlybRVbi/2VZjH9HKsFIo3QgXShTW7M9NIm6WmuJ1NdFEVZVRYsCuKas5c0c7Mc1NsZ2DHbZ+wIe/PjQAumrUJrnRf5xdF4PNF6kuuimJVVaRkAN81H2kHdhA31q1sOmBtN1QnZ9rrkiMBZvgjRpOtoGv19KtbaTKemMDNHW9wkDejQtGDZwxqgWQ+5UdbvNbdzz5dcEQVcPA9g+5r5zKOtvCbs9B8OaUdbFXNNmqBB2gVsm6HklPO0h+yF3Kklpx42zk2vCQWOz4PAqrKMW6QtwK7RlOdGX748mky0nuZOj+mQRkDy9B8NA+vKrEmamxHVLq820oweyOyph30nIorsrycAhSC2DqAOoLuRtkU+PWdtPrp8eTqpt+hZrS1rGRB8weRDzdZDmbGlI2HgVoU1hY0tmPlKXGGr8RCq6fFjL3/+Zyk9KxjoeJ2iKTf5+NJoMq61pScVl5V1+g//oOgzH2loeXUPr4HWh9kvKGTGJu8r/LeK1MRU8vtbx5595ppbbj56cI+nvXJmtDZG5/WgODW51no2m5XWsqMtQmJoIe3Gkoe3D7en/3RPa6vA2tDywi2jIhICp7uHfMJSsmff4UMDYcvZhpmZwhSzDT9oJ57mEBcwWLQAzdBqDgyeDa0dJ3s6DV7wtWMGrNskJZC5qiw4wQhI5M5vm3tnXd4AlsE7UHimQS2UkbmFMGOjaEsHysjLYMGS0WHJtsZMjZkPWgSw6LD1jgiNV1/PCRbQtgySftie8zqXupbCA+oHsDM+MvlbYABf9Hg01Xh4WXvjh7uEFCMvw2VrrlOjM4bGCN8NKLedj1bUfrEt22V7i75nEx106RfbUfv3aOl/d6vjbKPrP/BPBQN00xIyduDJyKG7x8n5UDTnaakltjOLAVZQOCDaDwAAcFIAnQEqAAEAAT5RJo9Go6IhoSCzOzhwCglpbnuO7mHr0oh+Bbr59/nvav/g/EnxY+nfZ3llvVffv9p53/6HwV+EuoR+L/zH/Qb23pnmC+zfz3/bf4X9z/fK9+/1H9O9Uvsh/cPcD/mX88/0/lQeEz9s/4n+k9wP+U/1H/c/4v8mfjr/1P83/nP2293P59/kv+37iH8v/qv+6/wP5GfOX7PfRH/XT/3D6b3U22jjT/ohJD73oCUMm/vRruwFBBorfT7EyEClclQiSwz72hOW36YS2eRwZZ14UO7Oc5LxN5TcYtMXmvSNB9/TlRIgcUcVu/mJqVNHKYHWS+w4qZu27dDzDTC7GbFVkWG8JI8W8mByasFJtJpa3hg6g7tWbHm9owuMmF3PsVOBqGhZvINRv3OUwTF6tzGk68G5UAWdaC2AZxAnC5VNUYoJoK+j+zkbvFFxx4tZe/WuadkZcfjIaITouHZAI3MZDIOUQNfd5nYWE5rESucdyiMHKCcCx+CKLQbvqeg7loXReiNF3Vo8QG0Vf89YwOs/PFfTJDrgY2iDQg1LdHLy53viv1bbouhakCr+00ll/t6izC9z0ueUF1N6yRN9Ev07Eac+3cYfCKkI9Zh+euWkv53YGIFBa8V1Hi5uTdA8na3b/lQE4wYNjofuwnY9jvpeZ04WklSgKDkbKONbYCi59/R0oiKdA5k4+d2I0cz+K+YDTYW17aS/iDqNR7E1Jb98+bASdH3sVuH6KuBXPzKVpk0CHc+QSXPEfxwffL72XCJWjG4BthPaPwDO8LI05QG6rLQRTWFB1r63lDzQ/4r0uHiTRpgt2IdmQUPjPa9KkXAg5Y2EefTDE1nwv6KISP/pt4Uhw6L3i0gEIaKqm+OWZ0XGBjAA/v4HCv/6allmjsd0w/zPOuiDoM2YNFd5OQ07Vh1ZB+KLeruPJkuhJlE6exWvsVzlLnq3hUfqgswRHpUbuctlUyvxFN4Rk4gxh9y2BfbvxW+MHebWONAT93f/xTyFjXhZmJQQ1kvfvolk7cZn5CgUtwrEPpy5yf8LBi4wF4wuSLqqbCIIs+MyXSGEDEZcUi//JYBIapBeK20HF48TA/2c5C22mH88wU81L/+y0Az2sHJcyDCZ/fL5A6jynSCaXLVf+gZQX6vKM/INwglOpj1UjGgrGWobi7zsiUeXc6p5AUJxBYKWt3oSOaf2UZp0ltAabHMygpc8aohC1Zpn6kX8e7/ZC8Tc0fUCTZglXzkGbRWfgEbNHyyuPJIovozv0SL4ypZWUhc57/QB4P/jQ9d7tnr8i/jj0N7pcPDuQPJYD1za8lsOkDFbzVgljuYA4ipL1Cc4CW0ZtfCzGQgSN0ij5XmCQn1XGxeL//GiEEtpq8VS3wQFPTi4fx7+KX8KQ3bR/Po42y//NPQowZ1R1RpvvpXH6JB7HUF/cndM0dRIqysY+H32/Sy1YKXAVkr+RqfjtsASG1UPa+ixa7fWS3eCWVqZbGv/oeEIdx/aZr1Wat2ZD2a9ncLOUQb2KpGNmH+LwpMzRZy9bOVbPWiq7OGCKjar0/DV/yVa2Twgv1eIlYy2Dutrwclr7eMgtMsdR/oDse9A068C9LfOTjZ0Ny1US5Iicv14Y+PNQwx2IxPCBO+bkXARC/DVPoBYj93y32OYE3t3fGmaeMl3Bd3celjRFu8w95sM5TsAMHZrnziLcHr/LfOvrpTaCb+sTUeKGXl0BpedfN32J6upV7Lm21lsA0hQfn3WR04ft4RholtuHKDtOZFAIlV8hCTsAdnnek1QoOG5piLbr7mi3RMNdTB6cRGBqPFAahti+qycxQGlPdc16GvTdGYLZWpVPGdVkwXj/id5KQZJBfzV9PYe5CWd4I3h+R/DWIxgDpEUMTQi8nKtLy3iBigf84iCv/CrVh8BzNkfY75UE4DI2/S6gzxbPy8r8cgKDqJO1zGGDaXcFTMo3kWiTSfbi4RgU0X5ue4Be+eYcevbx1qW8MUz+v3LnXjJgkrIzRCOibxy759nfxCliIoEgUGQ2pgj9T4bFMXBvvg04f3YCPraOestmZV33BCCdnTt698V/o9ap6+F6qAHauUKGf6LGCIxTZGps0vWEnIXzmPJf8cype8znHc/bR21RVJAC+EayxFJfQYSE9u2cqoilS/g79yS5JNzNYJytvDnENvGa8+iw3KoYKnSdKSFmJalt/lWkYq2CJZ671UawD9DNsS526+ViOsm2cmn4r3XaLbQIDK2y94BdfbAWluuEoc3mVRDNpvyQxAnf7WJX2GaZjU256oiEA17MZG6mb+6MlB0u1GFebxWSZk0oJjS5kaQbJJumiOMYB8J9vIOX8U6b8fMeB72QZXhGb5qb8fZWs6CJUaXltu/iFeE8LJm7oB6cGQuJpSbUoaovG6oF60OWjJyUqjm7Jo28+G25hDllLB8q9l+A3kqB2fOUnsBBFWVKb+V68AZoA8Ogh+m2eNF1AvKNaUF7qvOwbU4YBPMiO12z5VBxfKv5DHW/rZDh6YLzPFkfz+FGPWIwINsgb5hyG+uZDe4bOBLZZtBoA2xWIm3vqD+hQ0eb7laliUbANuLZlsnxit0m02r1H+J9xtX5En/28cXHcqKFxYus8uwnfPQQnc64V1IMqZo2fxPc7+gJ13fYcV4X7dW+JHaanIsNvD/yeQfqEEhntA3+xzkOsSFKRmJt7LAjWQAYbX4DE4gwy2QSsem1xQI40G3Capob/o7Mn3PszEVow7m+jZ2Kl6RwJAfDMh65GN8cd9MXPisLfngW8zUfO915ov7+V9UfyMBBQobbfuhdlNs5OO6ZkHiJRzlXioMoSMRzlnyS55U3TRlQa2kRWjlNAtYc5baVLpSmpqMWA2JUc4ohGVNFmcvrWAJOJZxFwh/WH9AKrZ3FQAFbkHRvz9os22M9Z+0vBYx7ymbDi3lIImfJU2odk3zkz8Lx9h9t1HjNgC8Vmepzi2Z1CfjU9hIilDWcuV/PAP9/9z3qwdWJz5DiPcQ+cM13e5zoc9ck3eWFWpGadWzS1YMzJAJzUdxC95uqGrXRL1fhDcEhUu/ot36arm3Oi2Wq/MdtxQaJ2VSFhLJu3AAi791dN5PKlgdnoYRKwcLFoV5xcqmUWXAOJvoVMYxBAxvAIfOtQRVy3f+J6wtydGl+i6YWelo6zDJo4jHVsoaUneOZUoi+S64kqftQY4P6V2DzLOhuy51xDJXtWzx3JgmLWHnhi2cjYnFeomJTO5h1axCMvveA0Y8sXxKx6VU/n7/KheynzhbAs/JpjBOpipW1YNClewReSpOO8+Z6Cv1eQKqV7yfN5zQey/MC082gaRFnC7j3LbjwdN/4NwYQgiWl/YxfOZ6SXnvl5H9I/ysAj4ICVEz23Kg2VXYjPXAZRIY6Z+xWIkLNWpb9LNl7K1fXBaT/CSZ9mCi66KtIxJnyBXHz3FT7fplFtlMvX06EsHP4eBs2GxhwbZtD50yx6rHl2HvlK/YBRBE8659/M07GVqDkJs3h89RTEohQYrOZMxT+/UtVQpMAp+b957pzKmtkUgKsPm5706oBv4VHZECkRP9aQLTNSAv+01HzypmhzEQuDTaf1Lz1QayWmoZyJaNWLAwoB1vfgn2eVBMwxzpEi+r0ZKY5gAhmJ24qgYHfqGEWgWaOXYJi2ieaUV6ECbGnaP3Gj/w6UCN88nc42cXEWsuxtjxA/qJHEmRGPxcLTQDxm+lL66a76c7jlj92ZDkNbMz1rQnaEvcRwzv/5B5DpQpHiFUg3qfxRF0XnPdfU3OijRgde1eNmVMaL3tK9D4ca0MMzjY+/9o/ItbS9jVZmpNsOzLwR5ENa7vYOKASMFxpf249cs0raCHTG6IkRdBHY6IuILhyFLDVh+YzcMdE+IWZ5oYHFsB0IS6jEQ4JxiCS4UMNJbZNP8uNu/REYmzgQhIMljqq/faS/tv1sz/US7EdJHECRsUUJ7SnoEoKiCuVZA0rIBLYpJqgKlNvAn9TOn32vq+9YR1XGGt+H8e1Xb5u5rq3Y3OXD9KQJeR92ahBM9PFMzIfvwJZwd7wubPApF6ljNaEgMOdGQaI/R64Qx49cW5pkzALUVwmBYemlHCyWePDL2XSl1t7RVXmoNa8dIMHoNdtVuJNFBKkG5FNsBrarAZio7gQTSoM700/7K5uSPlnXQyp9J/EEEz9sfJi4EEBPD4O4yHGsC4tN5A+MfdOKImtBe+we474K19b1YXQxPFD4leI8KZBaUVx44euufRms/o9/cihHRaS0dnOykfWhBRwuAo1NU/rzphLDBqyWJuUjfIpZAypm5sydH6eBnGrOvV+RMKdat6h/Ah/YVUlMyBU0xwfoz7TDsF5jthrEBzmqHcggvdYKwGC+kZyFTUAEvsx3yz8tBg4X/SYDXDps9rJsYeBdLIN+efzGaP8F8p9VGCxDt24mZRtKzyo3mlGdn11Y8n+yHySStMxG1aF8+NlzrYQ4B3y1HMjy4ZOF8PMG8oj1hT60W1XrH2eL7B5Pm/7wZYoCGCFEfX4ZFZSwq4SUPIoFMOmzx+JIrB5bF9irtD76qw5R8QKaBLw8k/tPCo+gYjTiO5z6DlZpptIZoTzd7hVyL6iRq5S0mUG8NHG/jpU0GVlVS28Vp4RHQxIC38pCtnYyquULd1UdMOCBLL4I/W73vVg9qsm8ziAEHHOaj1At9iynZoT+niJ3seFgv2M7VdZ5afH9h49v58WZJpVtFUrHls5v90eUALWQw9nLUzMBs1pN+sviojODm1ur+ul06l8pzOPsUKg8AaU4E5DWjtCe3wgVLmEnimdrjRIX0aaLvmFh4tt6H6w6YFzu7Ec3kUGy5ETxGidSE1sf6UzgAcip9okWRpenxt6KnDSeVuUa8/uPheOUWr008Ja4EM9sF7NCGJm1r5Wj6yFt9AI1AKPd27+7gw3xsqpOWdaq4o7uVYJFr0gmOf1vhgU3qm9Y6EKbn95W9sqMun0W0cCvYi9I0GLlkJ6Ed1Geqmid3Jd4ZPQCqga4v2zY5Tf5ECxYwhef6iMCNHGvzZM3P6qBJdf44aT3REE6PzzQPEOsvAvRbVzlti4V0M/C8UnY26YQvczMLcsgy89mS35BBjL0rNwnaE1YrGEMidsix/tsewQoJjdDcLq6VwsFVlXoqk/CeOzrrQ5fuazqAZ5I1bu5IOqm5vZpHRaJQSwu6tkuWscz7+zb4c4HD4EH7A4+Xb+D91XuIUgKYkTBFltvli2Vhf4t3gSm0B1249AMtBNnD7X9GP01Vw7HaoAIKGTWMOO0MB1CCv2Sy40o8QthfpkUjEp3hvGK2T7PZdKM4dwXFFeQ8FaOT3y8x//9H+qAuICtdQkQsImjr5szlqQFY8+2sTytw8ZF8uFCa/KwEZHSlKxKjDODN+W7hxKSpQgAAAAAA=";
// The device picture of the KL08RF for the zigbee2mqtt frontend: images/KL08RF.png as a 256x256 WebP data URI.
const WIRING_CENTRE_ICON =
    "data:image/webp;base64,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";

const thermostat = {
    zigbeeModel: ["SQ610RFNH"],
    model: "SQ610RFNH",
    vendor: "Salus Controls",
    description: "Quantum wireless thermostat (iT600)",
    icon: THERMOSTAT_ICON,
    extend: [m.deviceAddCustomCluster("genBasic", gatewayBasic), m.deviceAddCustomCluster(CLUSTER, salusCluster)],
    fromZigbee: [fzLocal.sync_request, fzLocal.record, fzLocal.clock_sync, fzLocal.write_echo, fzLocal.wiring_centre_request],
    toZigbee: [
        tzLocal.climate,
        tzLocal.child_lock,
        tzLocal.frost_setpoint,
        tzLocal.temperature_offset,
        tzLocal.heat_control,
        tzLocal.min_heat_setpoint,
        tzLocal.max_heat_setpoint,
        tzLocal.display_resolution,
        tzLocal.wiring_centre_zones,
        tzLocal.salus_command,
    ],
    exposes: [
        e
            .climate()
            .withSetpoint("current_heating_setpoint", SETPOINT_MIN, SETPOINT_MAX, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withSystemMode(["off", "heat", "cool"], ea.STATE_SET)
            .withRunningState(["idle", "heat"], ea.STATE)
            .withPreset(Object.keys(HOLD_TYPE_SET), "Settable hold type; a temporary hold (setpoint changed during the schedule) shows as schedule"),
        e.humidity(),
        e.battery(),
        new exposes.Enum("hold_type", ea.STATE, Object.values(HOLD_TYPES)).withDescription(
            "Hold type the thermostat reports, for diagnostics; standby means off. Change it with preset",
        ),
        e.numeric("schedule_setpoint", ea.STATE).withUnit("°C").withDescription("Heating setpoint the thermostat's schedule asks for now"),
        e.child_lock(),
        e
            .numeric("frost_setpoint", ea.STATE_SET)
            .withUnit("°C")
            .withValueMin(FROST_MIN)
            .withValueMax(FROST_MAX)
            .withValueStep(0.5)
            .withDescription("Setpoint the thermostat holds while it is off (standby heating)"),
        e
            .numeric("temperature_offset", ea.STATE_SET)
            .withUnit("°C")
            .withValueMin(OFFSET_MIN)
            .withValueMax(OFFSET_MAX)
            .withValueStep(0.5)
            .withDescription("Room temperature calibration"),
        new exposes.Enum("heat_control", ea.STATE_SET, Object.values(HEAT_CONTROL)).withDescription(
            "Heat control algorithm (admin setting): ITLC for underfloor, radiator or electric heating, a ±0.25 or ±0.5 °C span, or THB actuators. itlc_ufh is the factory value",
        ),
        e
            .numeric("min_heat_setpoint", ea.STATE_SET)
            .withUnit("°C")
            .withValueMin(SETPOINT_MIN)
            .withValueMax(SETPOINT_MAX - HEAT_LIMIT_GAP)
            .withValueStep(0.5)
            .withDescription("Lowest heating setpoint the thermostat accepts (admin setting), at least 0.5 below the highest"),
        e
            .numeric("max_heat_setpoint", ea.STATE_SET)
            .withUnit("°C")
            .withValueMin(SETPOINT_MIN + HEAT_LIMIT_GAP)
            .withValueMax(SETPOINT_MAX)
            .withValueStep(0.5)
            .withDescription("Highest heating setpoint the thermostat accepts (admin setting), at least 0.5 above the lowest"),
        e.numeric("min_cool_setpoint", ea.STATE).withUnit("°C").withDescription("Lowest cooling setpoint the thermostat accepts"),
        e.numeric("max_cool_setpoint", ea.STATE).withUnit("°C").withDescription("Highest cooling setpoint the thermostat accepts"),
        e
            .numeric("display_resolution", ea.STATE_SET)
            .withUnit("°C")
            .withValueMin(0.1)
            .withValueMax(0.5)
            .withValueStep(0.4)
            .withDescription("Temperature step shown on the display (admin setting): 0.5 or 0.1"),
        e
            .text("wiring_centre_zones", ea.SET)
            .withDescription(
                "Pairs the thermostat with zones of the wiring centre: zone numbers 1 to 8 separated by commas, e.g. 1,4. " +
                    "Put replace in front, e.g. replace 1,4, to take over zones that another thermostat holds. " +
                    "Done when the zone table of the wiring centre shows the thermostat in all of them",
            ),
    ],
    ota: true,
    endpoint: () => ({ default: THERMOSTAT_ENDPOINT }),
    onEvent: onJoin(THERMOSTAT_ENDPOINT),
};

const wiringCentre = {
    // Herdsman files a fingerprint without a modelID under the model "null", so this matches only a device that reports no modelId. The wiring
    // centre is a router with the one endpoint 8 on the home automation profile (260).
    fingerprint: [{ manufacturerName: "Computime", type: "Router", endpoints: [{ ID: WIRING_CENTRE_ENDPOINT, profileID: 260 }] }],
    model: "KL08RF",
    vendor: "Salus Controls",
    description: "iT600 8-zone wiring centre",
    icon: WIRING_CENTRE_ICON,
    extend: [m.deviceAddCustomCluster("genBasic", gatewayBasic), m.deviceAddCustomCluster(CLUSTER, salusCluster)],
    fromZigbee: [
        fzLocal.sync_request,
        fzLocal.write_echo,
        fzLocal.zone_table,
        fzLocal.sync_ack,
        fzLocal.replaced_thermostat,
        fzLocal.wiring_centre_request,
        fzLocal.pair_ack,
        fzLocal.pair_done,
        fzLocal.pair_button,
        fzLocal.unknown_command,
    ],
    toZigbee: [tzLocal.zone_table, tzLocal.salus_command, tzLocal.salus_frame],
    exposes: [
        ...ZONE_KEYS.map((key, index) =>
            e
                .text(key, ea.STATE_GET)
                .withDescription(`IEEE address of the thermostat in zone ${index + 1}, its short address while no device has it, null while the zone is free`),
        ),
        e
            .text("replaced_thermostat", ea.STATE)
            .withDescription("IEEE address of the thermostat the wiring centre last reported as replaced in a zone, its short address while no device has it"),
    ],
    // The OTA index lists the wiring centre's images under the manufacturer name SalusControls, and the device reports Computime.
    ota: { manufacturerName: "SalusControls" },
    endpoint: () => ({ default: WIRING_CENTRE_ENDPOINT }),
    onEvent: onWiringCentreEvent,
};

export default [thermostat, wiringCentre];
