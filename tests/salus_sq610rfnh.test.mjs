// Tests of the converter against records from a real thermostat, with a simulated thermostat for the writes,
// and against frames from a real wiring centre, with a simulated one that records what it is sent.
// Needs zigbee-herdsman and zigbee-herdsman-converters to resolve, for example from a copy of this repo
// under /app in the zigbee2mqtt container. Run `node --test` from the repo root.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

// The converter gives the devices the clock of the host it runs on, which is TZ in Docker. These tests are written for Copenhagen;
// the tests of other zones set TZ for their own length.
process.env.TZ = "Europe/Copenhagen";

// The logger has to be replaced through require before the converter imports it: an ES import would freeze the original.
const require = createRequire(import.meta.url);
const warnings = [];
const infos = [];
const debugs = [];
require("zigbee-herdsman-converters/lib/logger").setLogger({
    debug: (message) => debugs.push(message),
    info: (message) => infos.push(message),
    warning: (message) => warnings.push(message),
    error() {},
});
const { access } = require("zigbee-herdsman-converters/lib/exposes");
const { Zcl } = require("zigbee-herdsman");
const zhc = require("zigbee-herdsman-converters");
const { default: definitions } = await import("../converters/salus_sq610rfnh.mjs");
const [definition, wiringCentre] = definitions;

const hex = (text) => Buffer.from(text.replace(/\s+/g, ""), "hex");
const parseEcho = definition.fromZigbee.find((candidate) => candidate.type === "commandEcho");
const setter = (key) => definition.toZigbee.find((candidate) => candidate.key.includes(key));
const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

// Counts the timers that were set and have neither fired nor been cleared. `restore` puts the real functions back; call it before mock.timers.reset.
function countTimers() {
    const { setTimeout: set, clearTimeout: clear } = globalThis;
    const open = new Set();
    globalThis.setTimeout = (callback, ms) => {
        const timer = set(() => {
            open.delete(timer);
            callback();
        }, ms);
        open.add(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => {
        open.delete(timer);
        clear(timer);
    };
    return {
        get open() {
            return open.size;
        },
        restore() {
            globalThis.setTimeout = set;
            globalThis.clearTimeout = clear;
        },
    };
}

// What a promise did so far: still pending, resolved, or rejected with an error.
function watch(promise) {
    const watched = { state: "pending", error: undefined };
    promise.then(
        () => (watched.state = "resolved"),
        (error) => {
            watched.state = "rejected";
            watched.error = error;
        },
    );
    return watched;
}

// Runs the converters for a 0x31 record the way zigbee2mqtt does and merges what they publish.
function publish(record, device = parser) {
    const msg = { data: { payload: record }, device: { ieeeAddr: device.ieee }, endpoint: device.endpoint };
    const results = definition.fromZigbee
        .filter((candidate) => candidate.type === "commandRecord")
        .map((candidate) => candidate.convert(definition, msg));
    const published = results.filter((result) => result !== undefined);
    return published.length ? Object.assign({}, ...published) : undefined;
}

// Bytes 0-47 of a 0x72 from a thermostat on factory settings (report counter 7, no PIN).
const FACTORY =
    "72 07 01 00 00 01 05 00 40 50 00 00 00 01 04 00 27 00 10 00 06 00 35 00 05 00 40 00 05 00 01 00 00 00 01 01 80 00 00 00 0d fe 00 00 00 00 01 00";

// Sets the report counter of a 0x72 and scrambles the PIN (0xFFFF = none) into bytes 40-41 with it, the way the thermostat does.
function withCounter(record, counter, pin = 0xffff) {
    record[1] = counter;
    record[40] = ((pin >> 8) + 2 * counter) & 0xff;
    record[41] = ((pin & 0xff) - (counter >> 2)) & 0xff;
    return record;
}

function settingsRecord(changes = {}, counter = 7) {
    const record = Buffer.concat([hex(FACTORY), Buffer.alloc(27, 0xff), Buffer.alloc(2)]);
    for (const [index, value] of Object.entries(changes)) {
        record[index] = value;
    }
    return withCounter(record, counter);
}

// `mode` is byte 15: 4 heat, 3 cool. `setpoint` is bytes 9-10, the active setpoint of that mode, `schedule` bytes 11-12.
function statusRecord({ hold = 2, temperature = [0x22, 0x50], mode = 4, setpoint = [0x21, 0x00], schedule = [0x19, 0x50] } = {}) {
    const record = Buffer.alloc(77);
    record[0] = 0x71;
    record[3] = hold;
    record.set(temperature, 4);
    record.set(setpoint, 9);
    record.set(schedule, 11);
    record[15] = mode;
    record[23] = 1;
    record[24] = 0x55;
    record[49] = 4;
    return record;
}

// The converter only accepts an object whose class is called Endpoint.
class Endpoint {
    constructor(thermostat) {
        this.thermostat = thermostat;
        this.ID = 9;
        this.deviceIeeeAddress = thermostat.ieee;
        this.deviceNetworkAddress = 0x1201;
    }

    async commandResponse(cluster, command, { payload }) {
        if (command === "wiringCentreResponse") {
            this.thermostat.wiringCentreAnswers.push(payload);
        } else if (command !== "syncResponse") {
            this.thermostat.receive(payload);
        } else if (this.thermostat.failSync) {
            throw new Error("no route");
        } else {
            this.thermostat.syncs.push(payload);
        }
    }
}

const USER_BYTES = [2, 3, 4, 5, 6, 7, 8, 9, 42, 45];
const ADMIN_BYTES = [...Array.from({ length: 30 }, (_, index) => index + 10), 43, 46, 47];
let thermostats = 0;

// Answers like the real one: echoes every B-command, applies B11 and follows B74 with a 0x72.
class Thermostat {
    constructor(settings = settingsRecord(), pin = 0xffff) {
        this.ieee = `0x001e5e${String(++thermostats).padStart(10, "0")}`;
        this.settings = settings;
        this.counter = settings[1] - 1;
        this.pin = pin;
        this.frames = [];
        this.handles = [];
        this.published = [];
        this.syncs = [];
        this.wiringCentreAnswers = [];
        this.failSync = false;
        this.silent = new Set();
        this.reportsB74 = "after";
        this.hold = false;
        this.held = [];
        this.endpoint = new Endpoint(this);
    }

    receive(payload) {
        const code = payload.subarray(1, 4).toString("latin1");
        this.frames.push(payload.subarray(1).toString("hex"));
        this.handles.push(payload[0]);
        // "B74" is never echoed, "B74:2" only the second B74.
        if (this.silent.has(code) || this.silent.has(`${code}:${this.codes.filter((sent) => sent === code).length}`)) {
            return;
        }
        setImmediate(() => {
            if (code === "B74" && this.reportsB74 === "before") {
                this.report();
            }
            parseEcho.convert(definition, { data: { payload }, device: { ieeeAddr: this.ieee } });
            if (code === "B11") {
                this.store(payload.subarray(4));
            }
            if (code === "B74" && this.reportsB74 === "after") {
                setImmediate(() => this.report());
            }
        });
    }

    store(record) {
        const admin = record[0] === 0x73;
        for (const index of admin ? [...USER_BYTES, ...ADMIN_BYTES] : USER_BYTES) {
            this.settings[index] = record[index];
        }
        if (admin) {
            this.pin = (((record[40] - 2 * record[1]) & 0xff) << 8) | ((record[41] + (record[1] >> 2)) & 0xff);
        }
    }

    // While `hold` is set the 0x72 records stay on their way, as if the network delayed them, until `release` delivers one.
    report() {
        this.counter += 1;
        const record = withCounter(Buffer.from(this.settings), this.counter, this.pin);
        if (this.hold) {
            this.held.push(record);
        } else {
            this.published.push(publish(record, this));
        }
    }

    release(index) {
        this.published.push(publish(this.held[index], this));
    }

    set(key, value) {
        return setter(key).convertSet(this.endpoint, key, value, { message: { [key]: value } });
    }

    // Runs a /set message the way zigbee2mqtt does: the keys in the order they are written, and a converter that has several of them only
    // once, for the first. `lastState` is the state zigbee2mqtt holds for the device. Returns the state the converters publish.
    async send(message, lastState) {
        const used = new Set();
        const state = {};
        for (const [key, value] of Object.entries(message)) {
            const converter = setter(key);
            if (!used.has(converter)) {
                used.add(converter);
                Object.assign(state, (await converter.convertSet(this.endpoint, key, value, { message: { ...message }, state: lastState }))?.state);
            }
        }
        return state;
    }

    // The code of every frame received, e.g. B74, B11.
    get codes() {
        return this.frames.map((frame) => Buffer.from(frame.slice(0, 6), "hex").toString("latin1"));
    }

    // Record bytes 0-47 of the last B11 received.
    get written() {
        return Buffer.from(this.frames.filter((frame) => frame.startsWith("423131")).at(-1), "hex").subarray(3);
    }
}

const parser = new Thermostat();

test("the record helper reproduces the real counter and PIN bytes", () => {
    assert.equal(settingsRecord().subarray(0, 48).toString("hex"), hex(FACTORY).toString("hex"));
    const real = { 1: "01ff", 2: "03ff", 3: "05ff", 4: "07fe", 5: "09fe", 6: "0bfe", 7: "0dfe" };
    for (const [counter, bytes] of Object.entries(real)) {
        assert.equal(settingsRecord({}, Number(counter)).subarray(40, 42).toString("hex"), bytes);
    }
});

test("a real 0x72 publishes the settings", () => {
    assert.deepEqual(publish(settingsRecord()), {
        frost_setpoint: 5,
        temperature_offset: 0,
        heat_control: "itlc_ufh",
        min_heat_setpoint: 5,
        max_heat_setpoint: 35,
        min_cool_setpoint: 5,
        max_cool_setpoint: 40,
        display_resolution: 0.5,
    });
});

test("the temperature offset decodes as signed BCD", () => {
    const offsets = [
        [[0x00, 0x50], 0.5],
        [[0x80, 0x50], -0.5],
        [[0x00, 0x00], 0],
        [[0x80, 0x00], 0],
        [[0x03, 0x00], 3],
        [[0x83, 0x00], -3],
        [[0x83, 0x50], -3.5],
    ];
    for (const [bytes, expected] of offsets) {
        const record = settingsRecord({ 3: bytes[0], 4: bytes[1] });
        assert.equal(publish(record).temperature_offset, expected);
    }
});

test("heat control codes map to names and unknown codes stay unpublished", () => {
    const names = ["itlc_ufh", "itlc_rad", "itlc_elect", "span_0.25", "span_0.5", "thb_actuator"];
    names.forEach((name, code) => assert.equal(publish(settingsRecord({ 12: code })).heat_control, name));
    assert.equal("heat_control" in publish(settingsRecord({ 12: 6 })), false);
});

test("display resolution and setpoint limits come from their bytes", () => {
    const published = publish(settingsRecord({ 11: 1, 22: 0x25, 24: 0x15, 26: 0x30, 28: 0x10 }));
    assert.equal(published.display_resolution, 0.1);
    assert.equal(published.max_heat_setpoint, 25);
    assert.equal(published.min_heat_setpoint, 15);
    assert.equal(published.max_cool_setpoint, 30);
    assert.equal(published.min_cool_setpoint, 10);
});

test("a short 0x72 is ignored, so it does not answer the B74 of a write", async () => {
    const device = new Thermostat();
    device.reportsB74 = "never";
    let done = false;
    const write = device.set("frost_setpoint", 7).then(() => (done = true));
    await settled();
    assert.equal(publish(settingsRecord().subarray(0, 47), device), undefined);
    await settled();
    assert.equal(done, false);
    assert.deepEqual(device.codes, ["B74"]);
    device.report();
    await write;
    assert.deepEqual(device.codes, ["B74", "B11", "B74"]);
});

test("a status record keeps its fields", () => {
    const expected = {
        local_temperature: 22.5,
        current_heating_setpoint: 21,
        schedule_setpoint: 19.5,
        system_mode: "heat",
        hold_type: "permanent_hold",
        preset: "permanent_hold",
        running_state: "idle",
        child_lock: "LOCK",
        humidity: 55,
        battery: 75,
    };
    assert.deepEqual(publish(statusRecord()), expected);
    const standby = { ...expected, system_mode: "off", hold_type: "standby" };
    delete standby.preset;
    assert.deepEqual(publish(statusRecord({ hold: 7 })), standby);
});

test("a status record with the temperature 12.34 keeps everything but the temperature", () => {
    const published = publish(statusRecord({ temperature: [0x12, 0x34] }));
    assert.equal("local_temperature" in published, false);
    assert.deepEqual(published, {
        current_heating_setpoint: 21,
        schedule_setpoint: 19.5,
        system_mode: "heat",
        hold_type: "permanent_hold",
        preset: "permanent_hold",
        running_state: "idle",
        child_lock: "LOCK",
        humidity: 55,
        battery: 75,
    });
    assert.equal(publish(statusRecord({ temperature: [0x12, 0x35] })).local_temperature, 12.35);
});

test("the system mode comes from byte 15, and standby is off in either mode", () => {
    assert.equal(publish(statusRecord({ mode: 4 })).system_mode, "heat");
    assert.equal(publish(statusRecord({ mode: 3 })).system_mode, "cool");
    for (const mode of [4, 3, 0]) {
        assert.equal(publish(statusRecord({ hold: 7, mode })).system_mode, "off");
    }
});

test("an unknown system mode leaves only the mode unpublished", () => {
    for (const mode of [0, 1, 2, 5, 255]) {
        const published = publish(statusRecord({ mode }));
        assert.equal("system_mode" in published, false, `mode ${mode}`);
        assert.equal(published.current_heating_setpoint, 21, `mode ${mode}`);
        assert.equal(published.hold_type, "permanent_hold");
    }
});

test("bytes 9 and 10 are the one setpoint whatever the system mode, and no cooling setpoint is published next to it", () => {
    const states = [
        { mode: 4, hold: 2 },
        { mode: 3, hold: 2 },
        { mode: 0, hold: 2 },
        { mode: 4, hold: 7 },
        { mode: 3, hold: 7 },
    ];
    for (const { mode, hold } of states) {
        const published = publish(statusRecord({ mode, hold, setpoint: [0x19, 0x50] }));
        assert.equal(published.current_heating_setpoint, 19.5, `mode ${mode} hold ${hold}`);
        assert.deepEqual(
            Object.keys(published).filter((key) => key.endsWith("_setpoint")),
            ["current_heating_setpoint", "schedule_setpoint"],
        );
        assert.equal(published.schedule_setpoint, 19.5, `mode ${mode} hold ${hold}`);
    }
});

test("the hold type is published as hold_type and as the preset, with standby having no preset", () => {
    const cases = [
        [0, "schedule", "schedule"],
        [1, "temporary_hold", "schedule"],
        [2, "permanent_hold", "permanent_hold"],
        [6, "away", "away"],
        [7, "standby", undefined],
    ];
    for (const [hold, holdType, preset] of cases) {
        const published = publish(statusRecord({ hold }));
        assert.equal(published.hold_type, holdType);
        assert.equal(published.preset, preset);
        assert.equal("preset" in published, preset !== undefined);
    }
});

test("the schedule setpoint is bytes 11 and 12 of the status record, whatever the hold type and the setpoint", () => {
    for (const hold of [0, 1, 2, 6, 7]) {
        const published = publish(statusRecord({ hold, setpoint: [0x28, 0x00], schedule: [0x20, 0x50] }));
        assert.equal(published.schedule_setpoint, 20.5, `hold ${hold}`);
        assert.equal(published.current_heating_setpoint, 28, `hold ${hold}`);
    }
});

test("hold type codes outside the table are left unpublished, including 10 (eco)", () => {
    for (const hold of [3, 4, 10, 255]) {
        const published = publish(statusRecord({ hold }));
        assert.equal("hold_type" in published, false, `hold ${hold}`);
        assert.equal("preset" in published, false, `hold ${hold}`);
        assert.equal(published.system_mode, "heat");
    }
});

// 2026-06-10 12:00 in Copenhagen, far from a summer time change.
const SUMMER_NOON = Date.UTC(2026, 5, 10, 10, 0, 0);
const HOUR = 60 * 60 * 1000;

test("a status record syncs the clock once, then again after a day", () => {
    mock.timers.enable({ apis: ["Date"], now: SUMMER_NOON });
    try {
        const device = new Thermostat();
        publish(settingsRecord(), device);
        assert.equal(device.syncs.length, 0);
        publish(statusRecord(), device);
        publish(statusRecord(), device);
        assert.equal(device.syncs.length, 1);
        mock.timers.tick(HOUR);
        publish(statusRecord(), device);
        assert.equal(device.syncs.length, 1);
        mock.timers.tick(23 * HOUR);
        publish(statusRecord(), device);
        assert.equal(device.syncs.length, 1);
        mock.timers.tick(1);
        publish(statusRecord(), device);
        assert.equal(device.syncs.length, 2);
        assert.equal(device.syncs[1].readUInt32LE(2) + 946684800, Date.UTC(2026, 5, 11, 12, 0, 0) / 1000);
    } finally {
        mock.timers.reset();
    }
});

test("a sync after the join counts, so the next status record does not repeat it", async () => {
    const device = new Thermostat();
    await definition.onEvent({ type: "deviceAnnounce", data: { device: { getEndpoint: () => device.endpoint } } });
    publish(statusRecord(), device);
    assert.equal(device.syncs.length, 1);
});

test("a status record syncs the clock again when summer time starts or ends", () => {
    const changes = [
        { at: Date.UTC(2026, 2, 29, 1, 0, 0), before: 0, after: 1, first: "01:00", second: "03:01" },
        { at: Date.UTC(2026, 9, 25, 1, 0, 0), before: 1, after: 0, first: "02:00", second: "02:01" },
    ];
    for (const { at, before, after, first: firstClock, second: secondClock } of changes) {
        mock.timers.enable({ apis: ["Date"], now: at - HOUR });
        try {
            const device = new Thermostat();
            publish(statusRecord(), device);
            mock.timers.tick(HOUR / 2);
            publish(statusRecord(), device);
            assert.equal(device.syncs.length, 1);
            mock.timers.tick(HOUR / 2 + 60 * 1000);
            publish(statusRecord(), device);
            assert.equal(device.syncs.length, 2);
            const [first, second] = device.syncs;
            assert.equal(first[6] & 0x01, before);
            assert.equal(second[6] & 0x01, after);
            const local = (payload) => new Date((payload.readUInt32LE(2) + 946684800) * 1000).toISOString().slice(11, 16);
            assert.equal(local(first), firstClock);
            assert.equal(local(second), secondClock);
        } finally {
            mock.timers.reset();
        }
    }
});

// Runs `run` with the time zone of the host set to `zone`, as TZ does for zigbee2mqtt in Docker.
async function inTimeZone(zone, run) {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
        return await run();
    } finally {
        process.env.TZ = before;
    }
}

// The sync response a thermostat gets from a status record at `at`, or undefined when none is sent.
function syncAt(at) {
    mock.timers.enable({ apis: ["Date"], now: at });
    try {
        const device = new Thermostat();
        publish(statusRecord(), device);
        return device.syncs[0];
    } finally {
        mock.timers.reset();
    }
}

test("the sync response follows the time zone of the host: clock, summer time flag, gateway time zone index and summer time hours", async () => {
    const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
    const summer = Date.UTC(2026, 5, 10, 10, 0, 0);
    // [zone, instant, summer time flag, index in the gateway's table, summer time offset in hours, local hours ahead of UTC]
    const zones = [
        ["Europe/Copenhagen", winter, 0, 14, 1, 1],
        ["Europe/Copenhagen", summer, 1, 14, 1, 2],
        ["Europe/London", winter, 0, 13, 1, 0],
        ["Europe/London", summer, 1, 13, 1, 1],
        ["UTC", summer, 0, 13, 0, 0],
        ["Asia/Tokyo", summer, 0, 22, 0, 9],
        ["America/New_York", winter, 0, 8, 1, -5],
        ["America/New_York", summer, 1, 8, 1, -4],
        ["Pacific/Honolulu", summer, 0, 3, 0, -10],
        // Southern summer time is in January.
        ["Australia/Sydney", winter, 1, 23, 1, 11],
        ["Australia/Sydney", summer, 0, 23, 1, 10],
        ["Pacific/Auckland", winter, 1, 25, 1, 13],
        ["Pacific/Kiritimati", summer, 0, 27, 0, 14],
        // Zones with minutes in their offset are in the second part of the table.
        ["Asia/Kolkata", summer, 0, 34, 0, 5.5],
        ["Asia/Kathmandu", summer, 0, 35, 0, 5.75],
        ["America/St_Johns", summer, 1, 30, 1, -2.5],
        ["Pacific/Chatham", winter, 1, 41, 1, 13.75],
    ];
    for (const [zone, instant, dst, index, dstHours, hours] of zones) {
        await inTimeZone(zone, () => {
            const payload = syncAt(instant);
            assert.deepEqual([...payload.subarray(6, 9)], [0x02 | dst, index, dstHours], `${zone} ${new Date(instant).toISOString()}`);
            assert.equal(payload.readUInt32LE(2) + 946684800, instant / 1000 + hours * 3600, `${zone} clock`);
        });
    }
});

test("an offset that the gateway's table lacks gets the nearest index, with one warning", async () => {
    // North Korea was UTC+8:30 from 2015 to 2018, between the table's +8:00 and +8:45.
    const at = Date.UTC(2016, 5, 1, 0, 0, 0);
    await inTimeZone("Asia/Pyongyang", () => {
        const before = warnings.length;
        const [first, second] = [syncAt(at), syncAt(at + 60000)];
        assert.deepEqual([...first.subarray(6, 9)], [0x02, 37, 0]);
        assert.deepEqual([...second.subarray(6, 9)], [0x02, 37, 0]);
        assert.equal(first.readUInt32LE(2) + 946684800, at / 1000 + 8.5 * 3600);
        assert.equal(warnings.length, before + 1);
        assert.match(warnings.at(-1), /Asia\/Pyongyang.*30600 s.*lacks.*index 37 \(31500 s\)/);
    });
});

test("zigbee2mqtt starting on a host in UTC or in a zone without a region gets one warning that TZ is not set", async () => {
    const device = new Thermostat();
    const start = { type: "start", data: { device: { getEndpoint: () => device.endpoint } } };
    const wiringCentreStart = { type: "start", data: { device: joinedDevice(new WiringCentreEndpoint()) } };
    const before = warnings.length;
    await definition.onEvent(start);
    await wiringCentre.onEvent(wiringCentreStart);
    assert.equal(warnings.length, before);
    await inTimeZone("UTC", async () => {
        await definition.onEvent(start);
        await wiringCentre.onEvent(wiringCentreStart);
        await definition.onEvent(start);
    });
    assert.equal(warnings.length, before + 1);
    assert.match(warnings.at(-1), /time zone of the host is UTC.*Set TZ.*TZ=Europe\/Copenhagen/);
    await inTimeZone("Etc/GMT-2", () => definition.onEvent(start));
    assert.equal(warnings.length, before + 2);
    assert.match(warnings.at(-1), /time zone of the host is Etc\/GMT-2/);
    await inTimeZone("Europe/London", () => definition.onEvent(start));
    assert.equal(warnings.length, before + 2);
});

test("a sync that fails is tried again with the next status record", async () => {
    const device = new Thermostat();
    device.failSync = true;
    publish(statusRecord(), device);
    await settle();
    assert.match(warnings.at(-1), /Sync response to 0x[0-9a-f]+ failed \(no route\)/);
    device.failSync = false;
    publish(statusRecord(), device);
    assert.equal(device.syncs.length, 1);
});

// The B11 writes that a real thermostat accepted and read back (PROTOCOL.md section 6.4).
const PROVEN_WRITES = [
    ["frost_setpoint", 7, "4231317201010000010700405000000001040027001000060035000500400005000100000001018000000001ff000000000100"],
    ["temperature_offset", 0.5, "4231317201010050010500405000000001040027001000060035000500400005000100000001018000000001ff000000000100"],
    ["temperature_offset", -0.5, "4231317201018050010500405000000001040027001000060035000500400005000100000001018000000001ff000000000100"],
    ["heat_control", "itlc_rad", "4231317301010000010500405000000101040027001000060035000500400005000100000001018000000001ff000000000100"],
    ["heat_control", "thb_actuator", "4231317301010000010500405000000501040027001000060035000500400005000100000001018000000001ff000000000100"],
];

test("the B11 write equals the proven command whatever the thermostat's counter is", async () => {
    for (const [key, value, expected] of PROVEN_WRITES) {
        for (let counter = 1; counter <= 7; counter++) {
            const device = new Thermostat(settingsRecord({}, counter));
            await device.set(key, value);
            assert.equal(device.frames[1], expected, `${key} ${value} with counter ${counter}`);
            assert.equal(device.pin, 0xffff);
        }
    }
});

test("setpoints and offsets are rounded to 0.5 and encoded as BCD", async () => {
    const written = async (key, value) => {
        const device = new Thermostat();
        await device.set(key, value);
        return device.written;
    };
    assert.equal((await written("frost_setpoint", 7.3)).subarray(6, 8).toString("hex"), "0750");
    assert.equal((await written("frost_setpoint", "12")).subarray(6, 8).toString("hex"), "1200");
    assert.equal((await written("frost_setpoint", 35)).subarray(6, 8).toString("hex"), "3500");
    assert.equal((await written("temperature_offset", -0.2)).subarray(3, 5).toString("hex"), "0000");
    assert.equal((await written("temperature_offset", 3)).subarray(3, 5).toString("hex"), "0300");
    assert.equal((await written("temperature_offset", -3)).subarray(3, 5).toString("hex"), "8300");
    assert.equal((await written("temperature_offset", 3.5)).subarray(3, 5).toString("hex"), "0350");
    assert.equal((await written("temperature_offset", -3.5)).subarray(3, 5).toString("hex"), "8350");
});

// The admin settings are written with 's' (0x73), and the thermostat applies them as the user settings.
test("display_resolution, min_heat_setpoint and max_heat_setpoint are written with B11 's', each into its own bytes of the record", async () => {
    const written = async (key, value, settings) => {
        const device = new Thermostat(settingsRecord(settings));
        await device.set(key, value);
        await settle();
        return device;
    };
    let device = await written("display_resolution", 0.1);
    assert.deepEqual([device.written[0], device.written[11]], [0x73, 1]);
    assert.equal(device.published.at(-1).display_resolution, 0.1);
    device = await written("display_resolution", "0.5", { 11: 1 });
    assert.deepEqual([device.written[0], device.written[11]], [0x73, 0]);
    assert.equal(device.published.at(-1).display_resolution, 0.5);

    device = await written("max_heat_setpoint", 25.3);
    assert.deepEqual([device.written[0], device.written.subarray(22, 24).toString("hex")], [0x73, "2550"]);
    assert.equal(device.published.at(-1).max_heat_setpoint, 25.5);
    assert.equal(device.written.subarray(24, 26).toString("hex"), "0500");
    device = await written("min_heat_setpoint", 15);
    assert.deepEqual([device.written[0], device.written.subarray(24, 26).toString("hex")], [0x73, "1500"]);
    assert.equal(device.published.at(-1).min_heat_setpoint, 15);
    assert.equal(device.written.subarray(22, 24).toString("hex"), "3500");
    assert.equal(device.written[12], 0);
});

test("the heating setpoint limits stay 0.5 apart, and display_resolution takes 0.1 or 0.5 only", async () => {
    // A value out of range is refused before anything is sent. The gap to the other limit needs the record, so the B74 comes first.
    const cases = [
        ["min_heat_setpoint", 35, {}, /min_heat_setpoint must be at most 34.5 .*got 35/, ["B74"]],
        ["min_heat_setpoint", 4.5, {}, /min_heat_setpoint must be between 5 and 39.5, got 4.5/, []],
        ["min_heat_setpoint", 40, {}, /min_heat_setpoint must be between 5 and 39.5, got 40/, []],
        ["min_heat_setpoint", 25, { 22: 0x25 }, /min_heat_setpoint must be at most 24.5 .*got 25/, ["B74"]],
        ["max_heat_setpoint", 5, {}, /max_heat_setpoint must be between 5.5 and 40, got 5/, []],
        ["max_heat_setpoint", 40.5, {}, /max_heat_setpoint must be between 5.5 and 40, got 40.5/, []],
        ["max_heat_setpoint", 15, { 24: 0x15 }, /max_heat_setpoint must be at least 15.5 .*got 15/, ["B74"]],
        ["display_resolution", 0.2, {}, /display_resolution must be 0.1 or 0.5, got 0.2/, []],
        ["display_resolution", 1, {}, /display_resolution must be 0.1 or 0.5, got 1/, []],
        ["display_resolution", "fine", {}, /'display_resolution' is not a number/, []],
    ];
    for (const [key, value, settings, error, codes] of cases) {
        const device = new Thermostat(settingsRecord(settings));
        await assert.rejects(device.set(key, value), error, `${key} ${value}`);
        assert.deepEqual(device.codes, codes, `${key} ${value}`);
    }
    const device = new Thermostat();
    await device.set("min_heat_setpoint", 34.5);
    await device.set("max_heat_setpoint", 35);
    await device.set("max_heat_setpoint", 35);
    assert.deepEqual(device.codes, ["B74", "B11", "B74", "B74", "B11", "B74", "B74", "B11", "B74"]);
});

test("the heating setpoint limits and the display resolution are refused for a thermostat with a PIN", async () => {
    const device = new Thermostat(settingsRecord(), 0x1234);
    for (const [key, value] of [["display_resolution", 0.1], ["min_heat_setpoint", 15], ["max_heat_setpoint", 25]]) {
        await assert.rejects(device.set(key, value), /PIN/);
    }
    assert.deepEqual(device.codes, ["B74", "B74", "B74"]);
});

test("values outside the ranges are refused before anything is sent", async () => {
    const refused = [
        ["frost_setpoint", 4.5],
        ["frost_setpoint", 35.5],
        ["temperature_offset", 4],
        ["temperature_offset", -4],
        ["heat_control", "span_1.0"],
    ];
    for (const [key, value] of refused) {
        const device = new Thermostat();
        await assert.rejects(device.set(key, value), /must be/);
        assert.deepEqual(device.frames, []);
    }
});

test("a thermostat with a PIN is not written, including the PIN 0000", async () => {
    for (const pin of [0x1234, 0x0000, 0xff00, 0x00ff]) {
        const device = new Thermostat(settingsRecord(), pin);
        await assert.rejects(device.set("frost_setpoint", 7), /PIN/);
        await assert.rejects(device.set("heat_control", "itlc_rad"), /PIN/);
        assert.deepEqual(device.codes, ["B74", "B74"]);
    }
});

test("a write asks for the settings first, then writes them, then asks again", async () => {
    const device = new Thermostat();
    await device.set("frost_setpoint", 7);
    await settle();
    assert.deepEqual(device.codes, ["B74", "B11", "B74"]);
    assert.equal(device.published.length, 2);
    assert.equal(device.published[0].frost_setpoint, 5);
    assert.equal(device.published[1].frost_setpoint, 7);
});

test("the setters do not publish anything themselves", async () => {
    const device = new Thermostat();
    assert.equal(await device.set("temperature_offset", 0.5), undefined);
});

test("writes at the same time do not undo each other", async () => {
    const device = new Thermostat();
    await Promise.all([device.set("frost_setpoint", 7), device.set("temperature_offset", 0.5), device.set("heat_control", "itlc_rad")]);
    await settle();
    assert.deepEqual(device.codes, ["B74", "B11", "B74", "B74", "B11", "B74", "B74", "B11", "B74"]);
    assert.deepEqual(device.published.at(-1), {
        frost_setpoint: 7,
        temperature_offset: 0.5,
        heat_control: "itlc_rad",
        min_heat_setpoint: 5,
        max_heat_setpoint: 35,
        min_cool_setpoint: 5,
        max_cool_setpoint: 40,
        display_resolution: 0.5,
    });
});

test("a 0x72 that arrives late does not take back a newer write", async () => {
    const device = new Thermostat();
    device.hold = true;
    device.report();
    device.hold = false;
    await device.set("frost_setpoint", 7);
    await device.set("temperature_offset", 0.5);
    await settle();
    // The record from before the first write arrives after both were echoed, and shows neither of them.
    assert.equal(device.held[0].subarray(3, 5).toString("hex"), "0000");
    assert.equal(device.held[0].subarray(6, 8).toString("hex"), "0500");
    device.release(0);
    await device.set("heat_control", "itlc_rad");
    assert.equal(device.written.subarray(3, 5).toString("hex"), "0050");
    assert.equal(device.written.subarray(6, 8).toString("hex"), "0700");
    assert.equal(device.written[12], 1);
});

test("a change made at the thermostat right after a write is not overwritten by the next write", async () => {
    const device = new Thermostat();
    await device.set("frost_setpoint", 7);
    await settle();
    device.settings[3] = 0x01;
    device.report();
    await device.set("heat_control", "itlc_rad");
    assert.equal(device.written.subarray(3, 5).toString("hex"), "0100");
    assert.equal(device.written.subarray(6, 8).toString("hex"), "0700");
    assert.deepEqual(device.codes, ["B74", "B11", "B74", "B74", "B11", "B74"]);
});

test("nine writes in a row keep the thermostat at no PIN", async () => {
    const device = new Thermostat();
    for (let write = 0; write < 9; write++) {
        await device.set("heat_control", write % 2 ? "itlc_ufh" : "itlc_rad");
        await settle();
        assert.equal(device.pin, 0xffff);
        assert.deepEqual([device.written[1], device.written[40], device.written[41]], [0x01, 0x01, 0xff]);
    }
});

test("a 0x72 that arrives before the B74 echo is not missed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.reportsB74 = "before";
        const write = device.set("frost_setpoint", 7);
        for (let hop = 0; hop < 10; hop++) {
            await settle();
        }
        mock.timers.tick(30000);
        await write;
        assert.deepEqual(device.codes, ["B74", "B11", "B74"]);
    } finally {
        mock.timers.reset();
    }
});

test("a missing echo fails the write after 30 s, and the next write goes through", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.silent.add("B11");
        let done = false;
        const write = device.set("frost_setpoint", 7);
        const failed = assert.rejects(write, /No B11 echo from 0x[0-9a-f]+ within 30000 ms/);
        write.then(
            () => (done = true),
            () => (done = true),
        );
        await settled();
        mock.timers.tick(29999);
        await settle();
        assert.equal(done, false);
        mock.timers.tick(1);
        await failed;

        device.silent.clear();
        await device.set("frost_setpoint", 7);
        assert.deepEqual(device.codes, ["B74", "B11", "B74", "B11", "B74"]);
    } finally {
        mock.timers.reset();
    }
});

test("after a write without an echo the next write is built on what the thermostat reports", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        await device.set("frost_setpoint", 7);
        await settle();
        device.silent.add("B11");
        const failed = assert.rejects(device.set("frost_setpoint", 8), /No B11 echo/);
        await settled();
        mock.timers.tick(30000);
        await failed;
        device.silent.clear();
        await device.set("temperature_offset", 0.5);
        assert.deepEqual(device.codes, ["B74", "B11", "B74", "B74", "B11", "B74", "B11", "B74"]);
        assert.equal(device.written.subarray(3, 8).toString("hex"), "0050010700");
    } finally {
        mock.timers.reset();
    }
});

test("without a 0x72 within 30 s of B74 the write fails and nothing is written", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.reportsB74 = "never";
        const failed = assert.rejects(device.set("frost_setpoint", 7), /No settings record \(0x72\) from 0x[0-9a-f]+ within 30000 ms after B74/);
        await settle();
        mock.timers.tick(30000);
        await failed;
        assert.deepEqual(device.codes, ["B74"]);
    } finally {
        mock.timers.reset();
    }
});

test("a write fails when the B74 before it is not echoed, and nothing is written", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.silent.add("B74");
        const failed = assert.rejects(device.set("frost_setpoint", 7), /No B74 echo from 0x[0-9a-f]+ within 30000 ms/);
        await settled();
        mock.timers.tick(30000);
        await failed;
        assert.deepEqual(device.codes, ["B74"]);
    } finally {
        mock.timers.reset();
    }
});

test("a B74 that is never echoed after the write only logs a warning", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.silent.add("B74:2");
        let done = false;
        const write = device.set("frost_setpoint", 7).then(() => (done = true));
        await settled();
        assert.equal(done, false);
        mock.timers.tick(30000);
        await write;
        assert.match(warnings.at(-1), /Settings request to 0x[0-9a-f]+ failed \(No B74 echo/);
        assert.equal(device.settings[6], 0x07);
    } finally {
        mock.timers.reset();
    }
});

// An echo as the thermostat sends it: the payload of the write that it answers.
const echoOf = (device, text) => parseEcho.convert(definition, { data: { payload: hex(text) }, device: { ieeeAddr: device.ieee } });

test("a handle that waits for its echo is not handed out again when the handles wrap", async () => {
    const device = new Thermostat();
    device.silent.add("B21");
    const waiting = watch(device.set("salus_command", "42323101"));
    for (let command = 0; command < 130; command++) {
        await device.set("child_lock", "LOCK");
    }
    assert.equal(device.handles.filter((handle) => handle === 1).length, 1);
    assert.equal(waiting.state, "pending");
    echoOf(device, "01 42 32 31 01");
    await settle();
    assert.equal(waiting.state, "resolved");
});

test("an echo completes only a waiter for the same B-code, whatever the handle", async () => {
    const device = new Thermostat();
    device.silent.add("B21");
    const waiting = watch(device.set("salus_command", "42323101"));
    await settle();
    echoOf(device, "01 42 37 30 00");
    await settle();
    assert.equal(waiting.state, "pending");
    echoOf(device, "01 42 32 31 01");
    await settle();
    assert.equal(waiting.state, "resolved");
});

test("a device whose 127 handles all wait for an echo gets an error and not a hang", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.silent.add("B21");
        const waiting = Array.from({ length: 127 }, () => watch(device.set("salus_command", "42323101")));
        await settle();
        const extra = watch(device.set("salus_command", "42323101"));
        await settle();
        assert.equal(extra.state, "rejected");
        assert.match(extra.error.message, /All 127 handles/);
        assert.equal(new Set(device.handles).size, 127);
        mock.timers.tick(30000);
        await settle();
        assert.ok(waiting.every((watched) => watched.state === "rejected"));
    } finally {
        mock.timers.reset();
    }
});

test("the stop event fails what waits for an echo, and clears its timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const timers = countTimers();
    try {
        const device = reporting(4);
        device.silent.add("B20");
        const sent = watch(device.send({ system_mode: "cool" }));
        await settle();
        assert.equal(timers.open, 1);
        await definition.onEvent({ type: "stop", data: { ieeeAddr: device.ieee } });
        await settle();
        assert.equal(sent.state, "rejected");
        assert.match(sent.error.message, /stopped/);
        assert.equal(timers.open, 0);
        assert.deepEqual(device.codes, ["B20"]);
    } finally {
        timers.restore();
        mock.timers.reset();
    }
});

test("the stop event fails a write that waits for a 0x72, and clears its timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const timers = countTimers();
    try {
        const device = new Thermostat();
        device.reportsB74 = "never";
        const write = watch(device.set("frost_setpoint", 7));
        await settled();
        assert.equal(timers.open, 1);
        await definition.onEvent({ type: "stop", data: { ieeeAddr: device.ieee } });
        await settle();
        assert.equal(write.state, "rejected");
        assert.match(write.error.message, /stopped/);
        assert.equal(timers.open, 0);
        assert.deepEqual(device.codes, ["B74"]);
    } finally {
        timers.restore();
        mock.timers.reset();
    }
});

test("the stop event fails queued work without running it, and the thermostat works again afterwards", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = new Thermostat();
        device.reportsB74 = "never";
        const queued = [
            watch(device.set("frost_setpoint", 7)),
            watch(device.set("temperature_offset", 0.5)),
            watch(device.send({ system_mode: "cool" })),
        ];
        await settled();
        await definition.onEvent({ type: "stop", data: { ieeeAddr: device.ieee } });
        await settled();
        for (const watched of queued) {
            assert.equal(watched.state, "rejected");
            assert.match(watched.error.message, /stopped/);
        }
        assert.deepEqual(device.codes, ["B74"]);
        device.reportsB74 = "after";
        await device.set("frost_setpoint", 7);
        assert.deepEqual(device.codes, ["B74", "B74", "B11", "B74"]);
    } finally {
        mock.timers.reset();
    }
});

// The frames below are '<B-code><arguments>' in hex without the handle: B20 is 423230, B33 is 423333, B34 is 423334 and B48 is 423438.

// A thermostat that has sent a 0x71 with this byte 15 (none when undefined), and a 0x72 with these changes when given.
function reporting(mode, settings) {
    const device = new Thermostat();
    if (mode !== undefined) {
        publish(statusRecord({ mode }), device);
    }
    if (settings) {
        publish(settingsRecord(settings), device);
    }
    return device;
}

test("system mode off is B20 07, heat is B20 02 then B48 04 and cool is B20 02 then B48 03", async () => {
    const expected = { off: ["42323007"], heat: ["42323002", "42343804"], cool: ["42323002", "42343803"] };
    for (const [mode, frames] of Object.entries(expected)) {
        const device = new Thermostat();
        assert.deepEqual(await device.send({ system_mode: mode }), { system_mode: mode });
        assert.deepEqual(device.frames, frames);
    }
});

test("a system mode other than off, heat and cool is refused before anything is sent", async () => {
    for (const mode of ["auto", "dry", "fan_only", "", null]) {
        const device = new Thermostat();
        await assert.rejects(device.send({ system_mode: mode }), /system_mode must be off, heat or cool/);
        assert.deepEqual(device.frames, []);
    }
});

test("the setpoint is B33 when byte 15 of the last 0x71 is 3 and B34 otherwise, rounded to 0.5", async () => {
    // 30 is the proven B33 5c: the byte is the setpoint over 0.5, plus 0x20.
    const cases = [
        { mode: 3, command: "423333", value: 30, byte: "5c", setpoint: 30 },
        { mode: 3, command: "423333", value: 21.3, byte: "4b", setpoint: 21.5 },
        { mode: 3, command: "423333", value: "25", byte: "52", setpoint: 25 },
        { mode: 3, command: "423333", value: 40, byte: "70", setpoint: 40 },
        { mode: 4, command: "423334", value: 21, byte: "4a", setpoint: 21 },
        { mode: 4, command: "423334", value: 5, byte: "2a", setpoint: 5 },
        { mode: 4, command: "423334", value: 35, byte: "66", setpoint: 35 },
        { mode: 0, command: "423334", value: 21, byte: "4a", setpoint: 21 },
    ];
    for (const { mode, command, value, byte, setpoint } of cases) {
        const device = reporting(mode);
        assert.deepEqual(await device.send({ current_heating_setpoint: value }), { current_heating_setpoint: setpoint });
        assert.deepEqual(device.frames, [`${command}${byte}`]);
    }
});

test("until a 0x71 has been seen the setpoint is B34", async () => {
    const device = reporting(undefined);
    await device.send({ current_heating_setpoint: 21 });
    assert.deepEqual(device.frames, ["4233344a"]);
});

test("every 0x71 updates the mode byte, and each thermostat has its own", async () => {
    const device = reporting(3);
    const other = reporting(undefined);
    await device.send({ current_heating_setpoint: 21 });
    publish(statusRecord({ mode: 4 }), device);
    await device.send({ current_heating_setpoint: 21 });
    publish(statusRecord({ mode: 3 }), device);
    await device.send({ current_heating_setpoint: 21 });
    await other.send({ current_heating_setpoint: 21 });
    assert.deepEqual(device.frames, ["4233334a", "4233344a", "4233334a"]);
    assert.deepEqual(other.frames, ["4233344a"]);
});

test("a setpoint after a system mode that was echoed uses the command of that mode, without a 0x71 in between", async () => {
    for (const reported of [4, 3, undefined]) {
        const device = reporting(reported);
        await device.send({ system_mode: "cool" });
        await device.send({ current_heating_setpoint: 25 });
        await device.send({ system_mode: "heat" });
        await device.send({ current_heating_setpoint: 21 });
        assert.deepEqual(device.frames, ["42323002", "42343803", "42333352", "42323002", "42343804", "4233344a"], `reported ${reported}`);
    }
});

test("a system mode that gets no echo leaves the mode of the setpoint command as it was", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = reporting(4);
        device.silent.add("B48");
        const failed = assert.rejects(device.send({ system_mode: "cool" }), /No B48 echo/);
        await settle();
        mock.timers.tick(30000);
        await failed;
        await device.send({ current_heating_setpoint: 21 });
        assert.deepEqual(device.frames.at(-1), "4233344a");
    } finally {
        mock.timers.reset();
    }
});

test("off keeps the mode of the setpoint command: the mode byte is the one of the last cool or heat", async () => {
    const device = reporting(undefined);
    await device.send({ system_mode: "cool" });
    await device.send({ system_mode: "off" });
    await device.send({ current_heating_setpoint: 25 });
    assert.deepEqual(device.frames, ["42323002", "42343803", "42323007", "42333352"]);
});

test("without a 0x71 yet the system mode zigbee2mqtt last published decides the command, else heat, and a 0x71 overrules it", async () => {
    const cases = [
        { state: { system_mode: "cool" }, command: "423333" },
        { state: { system_mode: "heat" }, command: "423334" },
        { state: { system_mode: "off" }, command: "423334" },
        { state: { system_mode: "auto" }, command: "423334" },
        { state: { system_mode: "constructor" }, command: "423334" },
        { state: {}, command: "423334" },
        { state: undefined, command: "423334" },
    ];
    for (const { state, command } of cases) {
        const device = reporting(undefined);
        await device.send({ current_heating_setpoint: 21 }, state);
        assert.deepEqual(device.frames, [`${command}4a`], JSON.stringify(state));
    }
    const heating = reporting(4);
    await heating.send({ current_heating_setpoint: 21 }, { system_mode: "cool" });
    assert.deepEqual(heating.frames, ["4233344a"]);
});

test("the setpoint is not refused while off: standby keeps the mode byte", async () => {
    for (const [mode, command] of [
        [3, "423333"],
        [4, "423334"],
    ]) {
        const device = new Thermostat();
        assert.equal(publish(statusRecord({ hold: 7, mode }), device).system_mode, "off");
        await device.send({ current_heating_setpoint: 21 });
        assert.deepEqual(device.frames, [`${command}4a`]);
    }
});

test("a system mode in the same message decides the command and is written first, whatever the order of the keys", async () => {
    const cool = ["42323002", "42343803", "42333352"];
    const heat = ["42323002", "42343804", "4233344a"];
    const cases = [
        { reported: 4, message: { system_mode: "cool", current_heating_setpoint: 25 }, frames: cool },
        { reported: 4, message: { current_heating_setpoint: 25, system_mode: "cool" }, frames: cool },
        { reported: undefined, message: { current_heating_setpoint: 25, system_mode: "cool" }, frames: cool },
        { reported: 3, message: { system_mode: "heat", current_heating_setpoint: 21 }, frames: heat },
        { reported: 3, message: { current_heating_setpoint: 21, system_mode: "heat" }, frames: heat },
        // Off is no mode for the setpoint: standby keeps the mode byte as it was.
        { reported: 3, message: { current_heating_setpoint: 25, system_mode: "off" }, frames: ["42323007", "42333352"] },
        { reported: 4, message: { system_mode: "off", current_heating_setpoint: 21 }, frames: ["42323007", "4233344a"] },
    ];
    for (const { reported, message, frames } of cases) {
        const device = reporting(reported);
        assert.deepEqual(await device.send(message), message);
        assert.deepEqual(device.frames, frames, JSON.stringify(message));
    }
});

test("messages that overlap are written one after the other, so a setpoint uses the command of the mode that was sent before it", async () => {
    const device = reporting(4);
    const sent = await Promise.all([
        device.send({ system_mode: "cool" }),
        device.send({ current_heating_setpoint: 25 }),
        device.send({ system_mode: "heat" }),
        device.send({ current_heating_setpoint: 21 }),
    ]);
    assert.deepEqual(sent, [{ system_mode: "cool" }, { current_heating_setpoint: 25 }, { system_mode: "heat" }, { current_heating_setpoint: 21 }]);
    assert.deepEqual(device.frames, ["42323002", "42343803", "42333352", "42323002", "42343804", "4233344a"]);
});

test("a climate message waits for a settings write that is under way", async () => {
    const device = new Thermostat();
    await Promise.all([device.set("frost_setpoint", 7), device.send({ system_mode: "cool" })]);
    assert.deepEqual(device.codes, ["B74", "B11", "B74", "B20", "B48"]);
});

test("the setpoint is limited to 5 to 35 in heat and 5 to 40 in cool until a 0x72 has been seen", async () => {
    for (const [mode, max] of [
        [4, 35],
        [3, 40],
    ]) {
        const device = reporting(mode);
        const refused = new RegExp(`current_heating_setpoint must be between 5 and ${max}, got`);
        for (const value of [4.5, max + 0.5]) {
            await assert.rejects(device.send({ current_heating_setpoint: value }), refused);
        }
        assert.deepEqual(device.frames, []);
        await device.send({ current_heating_setpoint: max });
        assert.equal(device.frames.length, 1);
    }
});

test("after a 0x72 the setpoint is limited to the thermostat's own limits for its mode", async () => {
    // Heating limits 15 to 25 (bytes 24-25 and 22-23), cooling limits 10 to 30 (bytes 28-29 and 26-27).
    const settings = { 22: 0x25, 24: 0x15, 26: 0x30, 28: 0x10 };
    for (const { mode, min, max } of [
        { mode: 4, min: 15, max: 25 },
        { mode: 3, min: 10, max: 30 },
    ]) {
        const device = reporting(mode, settings);
        for (const value of [min - 0.5, max + 0.5]) {
            await assert.rejects(device.send({ current_heating_setpoint: value }), new RegExp(`must be between ${min} and ${max}, got`));
        }
        assert.deepEqual(device.frames, []);
        await device.send({ current_heating_setpoint: min });
        await device.send({ current_heating_setpoint: max });
        assert.equal(device.frames.length, 2);
    }
});

test("the limits follow the mode written in the same message", async () => {
    const settings = { 22: 0x25, 24: 0x15, 26: 0x30, 28: 0x10 };
    // 28 is above the heating limit of 25 and within the cooling limit of 30.
    const cooling = reporting(4, settings);
    await cooling.send({ system_mode: "cool", current_heating_setpoint: 28 });
    assert.deepEqual(cooling.frames, ["42323002", "42343803", "42333358"]);
    const heating = reporting(3, settings);
    await assert.rejects(heating.send({ system_mode: "heat", current_heating_setpoint: 28 }), /must be between 15 and 25, got 28/);
    assert.deepEqual(heating.frames, []);
});

test("a message with a bad mode or a bad setpoint writes nothing", async () => {
    const cases = [
        [{ system_mode: "auto", current_heating_setpoint: 21 }, /system_mode must be off, heat or cool, got auto/],
        [{ current_heating_setpoint: 21, system_mode: "auto" }, /system_mode must be off, heat or cool, got auto/],
        [{ system_mode: "cool", current_heating_setpoint: 45 }, /must be between 5 and 40, got 45/],
        [{ current_heating_setpoint: 45, system_mode: "cool" }, /must be between 5 and 40, got 45/],
    ];
    for (const [message, error] of cases) {
        const device = reporting(4);
        await assert.rejects(device.send(message), error);
        assert.deepEqual(device.frames, []);
    }
});

test("when the system mode gets no echo the setpoint is not written after it", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = reporting(4);
        device.silent.add("B20");
        const sent = assert.rejects(
            device.send({ system_mode: "cool", current_heating_setpoint: 25 }),
            /No B20 echo from 0x[0-9a-f]+ within 30000 ms/,
        );
        await settle();
        mock.timers.tick(30000);
        await sent;
        assert.deepEqual(device.codes, ["B20"]);
    } finally {
        mock.timers.reset();
    }
});

test("presets set the hold type: schedule is B20 00, permanent_hold B20 02 and away B20 06", async () => {
    const expected = { schedule: "42323000", permanent_hold: "42323002", away: "42323006" };
    for (const [preset, frame] of Object.entries(expected)) {
        const device = new Thermostat();
        assert.deepEqual(await device.set("preset", preset), { state: { preset, hold_type: preset } });
        assert.deepEqual(device.frames, [frame]);
    }
});

test("a preset in the same message as a system mode is written after it, so the preset is the hold type that is left", async () => {
    const cases = [
        { message: { preset: "schedule", system_mode: "heat" }, frames: ["42323002", "42343804", "42323000"] },
        { message: { system_mode: "heat", preset: "schedule" }, frames: ["42323002", "42343804", "42323000"] },
        { message: { preset: "away", system_mode: "cool" }, frames: ["42323002", "42343803", "42323006"] },
        { message: { system_mode: "cool", preset: "away" }, frames: ["42323002", "42343803", "42323006"] },
        { message: { preset: "permanent_hold", system_mode: "heat" }, frames: ["42323002", "42343804", "42323002"] },
    ];
    for (const { message, frames } of cases) {
        const device = reporting(4);
        assert.deepEqual(await device.send(message), { ...message, hold_type: message.preset }, JSON.stringify(message));
        assert.deepEqual(device.frames, frames, JSON.stringify(message));
    }
});

test("a preset and a setpoint in one message are written in that order, whatever the order of the keys", async () => {
    const scheduleInCool = ["42323002", "42343803", "42323000", "42333352"];
    const cases = [
        { message: { preset: "away", current_heating_setpoint: 18 }, frames: ["42323006", "42333444"] },
        { message: { current_heating_setpoint: 18, preset: "away" }, frames: ["42323006", "42333444"] },
        { message: { current_heating_setpoint: 25, preset: "schedule", system_mode: "cool" }, frames: scheduleInCool },
        { message: { preset: "schedule", system_mode: "cool", current_heating_setpoint: 25 }, frames: scheduleInCool },
    ];
    for (const { message, frames } of cases) {
        const device = reporting(4);
        assert.deepEqual(await device.send(message), { ...message, hold_type: message.preset }, JSON.stringify(message));
        assert.deepEqual(device.frames, frames, JSON.stringify(message));
    }
});

test("a preset with system mode off is refused, as are a bad preset or a bad mode next to a good one, and nothing is written", async () => {
    const cases = [
        [{ preset: "schedule", system_mode: "off" }, /preset cannot be set together with system_mode off/],
        [{ system_mode: "off", preset: "away" }, /preset cannot be set together with system_mode off/],
        [{ system_mode: "heat", preset: "eco" }, /preset must be one of schedule, permanent_hold, away, got eco/],
        [{ preset: "standby", system_mode: "cool" }, /preset must be one of schedule, permanent_hold, away, got standby/],
        [{ preset: "away", system_mode: "auto" }, /system_mode must be off, heat or cool, got auto/],
        [{ preset: "away", current_heating_setpoint: 45 }, /must be between 5 and 35, got 45/],
        [{ preset: "away", current_heating_setpoint: 21, system_mode: "dry" }, /system_mode must be off, heat or cool, got dry/],
    ];
    for (const [message, error] of cases) {
        const device = reporting(4);
        await assert.rejects(device.send(message), error, JSON.stringify(message));
        assert.deepEqual(device.frames, [], JSON.stringify(message));
    }
});

test("when the system mode gets no echo the preset is not written after it", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const device = reporting(4);
        device.silent.add("B48");
        const sent = assert.rejects(device.send({ system_mode: "cool", preset: "away" }), /No B48 echo/);
        await settle();
        mock.timers.tick(30000);
        await sent;
        assert.deepEqual(device.codes, ["B20", "B48"]);
    } finally {
        mock.timers.reset();
    }
});

test("only the settable presets are accepted, and hold_type itself cannot be set", async () => {
    for (const preset of ["temporary_hold", "standby", "eco", "heat", ""]) {
        const device = new Thermostat();
        await assert.rejects(device.set("preset", preset), /preset must be one of schedule, permanent_hold, away, got/);
        assert.deepEqual(device.frames, []);
    }
    assert.equal(setter("hold_type"), undefined);
});

const climate = definition.exposes.find((expose) => expose.type === "climate");
const featuresOf = (expose) => Object.fromEntries(expose.features.map((feature) => [feature.name, feature]));

test("the climate has one setpoint, the three system modes and the three settable presets", () => {
    // A second setpoint would turn zigbee2mqtt's Home Assistant discovery into a low and high pair instead of one temperature.
    const features = featuresOf(climate);
    assert.deepEqual(Object.keys(features), ["current_heating_setpoint", "local_temperature", "system_mode", "running_state", "preset"]);
    const setpoint = features.current_heating_setpoint;
    assert.deepEqual([setpoint.value_min, setpoint.value_max, setpoint.value_step, setpoint.access], [5, 40, 0.5, access.STATE_SET]);
    assert.deepEqual(features.system_mode.values, ["off", "heat", "cool"]);
    assert.equal(features.system_mode.access, access.STATE_SET);
    assert.deepEqual(features.running_state.values, ["idle", "heat"]);
    assert.equal(features.running_state.access, access.STATE);
    assert.deepEqual(features.preset.values, ["schedule", "permanent_hold", "away"]);
    assert.equal(features.preset.access, access.STATE_SET);
});

test("hold_type is exposed read-only with the five hold types and no eco", () => {
    const holdType = definition.exposes.find((expose) => expose.property === "hold_type");
    assert.deepEqual(holdType.values, ["schedule", "temporary_hold", "permanent_hold", "away", "standby"]);
    assert.equal(holdType.access, access.STATE);
});

test("the cooling limits and the schedule setpoint are exposed read-only, the heating limits and the display resolution settable, in degrees", () => {
    const readOnly = ["min_cool_setpoint", "max_cool_setpoint", "schedule_setpoint"];
    const settable = ["min_heat_setpoint", "max_heat_setpoint", "display_resolution"];
    for (const property of [...readOnly, ...settable]) {
        const expose = definition.exposes.find((candidate) => candidate.property === property);
        const expected = readOnly.includes(property) ? access.STATE : access.STATE_SET;
        assert.deepEqual([expose?.type, expose?.access, expose?.unit], ["numeric", expected, "°C"], property);
    }
});

test("the settable exposes and the converters have the same keys, and salus_command is a converter only", () => {
    const features = definition.exposes.flatMap((expose) => expose.features ?? [expose]);
    const settable = features.filter((feature) => feature.access & access.SET).map((feature) => feature.property);
    assert.deepEqual(settable.toSorted(), [
        "child_lock",
        "current_heating_setpoint",
        "display_resolution",
        "frost_setpoint",
        "heat_control",
        "max_heat_setpoint",
        "min_heat_setpoint",
        "preset",
        "system_mode",
        "temperature_offset",
        "wiring_centre_zones",
    ]);
    // zigbee2mqtt picks the converter of a /set message by its key and does not look at the exposes, so it works over MQTT without one.
    assert.deepEqual(definition.toZigbee.flatMap((converter) => converter.key).toSorted(), [...settable, "salus_command"].toSorted());
    assert.equal(features.some((feature) => feature.property === "salus_command"), false);
});

// The KL08RF / it600WC wiring centre. The zone table, with placeholder short addresses, and the 0x37 are from captures of a real one,
// the sync request from zigbee-herdsman-converters issue 3354.

const CLUSTER = "manuSpecificSalusIt600";
// The zone table it sends unprompted when it boots, as the payload of a 0x33 with handle 0. Zone 8 is free.
const ZONE_TABLE_AT_BOOT = "00423730000000000008120100120200120300120100120400120500120600ffff00ffff00ffff00ffff00ffff000000007eaaaaa8800000000078";
// herdsman's Device class is not exported by the package, but it is the class of the msg.device that a converter gets, and its lookup by
// network address is how the zone table names a thermostat. This one knows the thermostats at 0x1201 to 0x1205 and not the one at 0x1206.
const ieeeOf = (short) => `0x001e5e${short.toString(16).padStart(10, "0")}`;
class Device {
    static byNetworkAddress(address) {
        return address >= 0x1201 && address <= 0x1205 ? new Device(ieeeOf(address)) : undefined;
    }

    constructor(ieeeAddr) {
        this.ieeeAddr = ieeeAddr;
    }
}
const AT_BOOT = {
    zone_1: ieeeOf(0x1201),
    zone_2: ieeeOf(0x1202),
    zone_3: ieeeOf(0x1203),
    zone_4: ieeeOf(0x1201),
    zone_5: ieeeOf(0x1204),
    zone_6: ieeeOf(0x1205),
    zone_7: "0x1206",
    zone_8: null,
};
// What the gateway sends to ask for the table: handle 1, B70 and its arguments.
const ZONE_TABLE_REQUEST = "014237307eaaaaa88000000078";
const SYNC_REQUEST = "ff 00 ff 22 03 18 20";
const ZONE_KEYS = Array.from({ length: 8 }, (_, index) => `zone_${index + 1}`);

// A frame as it is on air: frame control, manufacturer code 0x1078, sequence number, command and payload. The wiring centre sends frame
// control 0x15, which has the client-to-server bit, and the thermostat 0x1d, which has the server-to-client bit.
const frame = (frameControl, command, payload) => Buffer.concat([Buffer.from([frameControl, 0x78, 0x10, 0x28, command]), hex(payload)]);

// The custom clusters herdsman holds for a device of this definition once its extends have added them.
function customClustersOf(candidate) {
    const clusters = {};
    for (const extension of candidate.extend) {
        for (const configure of extension.configure) {
            configure({ addCustomCluster: (name, cluster) => (clusters[name] = cluster) });
        }
    }
    return clusters;
}

const parseFrame = (candidate, buffer) => Zcl.Frame.fromBuffer(0xfc00, Zcl.Header.fromBuffer(buffer), buffer, customClustersOf(candidate));

// Runs the wiring centre's converters for a message the way zigbee2mqtt does and merges what they publish.
async function fromWiringCentre(endpoint, type, data, device = new Device(endpoint.deviceIeeeAddress)) {
    const msg = { type, cluster: CLUSTER, data, device, endpoint };
    const converters = wiringCentre.fromZigbee.filter((candidate) => candidate.cluster === CLUSTER && [candidate.type].flat().includes(type));
    assert.ok(converters.length > 0, `no converter for ${type}`);
    const results = [];
    for (const converter of converters) {
        results.push(await converter.convert(wiringCentre, msg));
    }
    const published = results.filter((result) => result !== undefined);
    return published.length ? Object.assign({}, ...published) : undefined;
}

const received = (endpoint, type, payload) => fromWiringCentre(endpoint, type, { payload: hex(payload) });

let wiringCentres = 0;

// A wiring centre as the converter sees it, with the short address 0xfffe (none) until a test sets one. It records what is sent to it as
// [command, payload in hex] and echoes every B-command except the codes in `silent`. The class has to be called Endpoint.
const WiringCentreEndpoint = class Endpoint {
    constructor() {
        this.ID = 8;
        this.deviceIeeeAddress = `0x001e5f${String(++wiringCentres).padStart(10, "0")}`;
        this.deviceNetworkAddress = 0xfffe;
        this.sent = [];
        this.failing = new Set();
        this.silent = new Set();
    }

    async commandResponse(cluster, command, { payload }) {
        if (this.failing.has(command)) {
            throw new Error("no route");
        }
        this.sent.push([command, payload.toString("hex")]);
        if (command === "write" && !this.silent.has(payload.subarray(1, 4).toString("latin1"))) {
            setImmediate(() => fromWiringCentre(this, "commandEcho", { payload }));
        }
    }

    get commands() {
        return this.sent.map(([command]) => command);
    }
};

const joinedDevice = (endpoint) => ({ getEndpoint: (id) => (id === 8 ? endpoint : undefined) });

// A wiring centre with the placeholder short address 0x5678 that has sent its sync request.
async function greetedWiringCentre() {
    const endpoint = new WiringCentreEndpoint();
    endpoint.deviceNetworkAddress = 0x5678;
    await received(endpoint, "commandSyncRequest", SYNC_REQUEST);
    return endpoint;
}

test("the converter file defines the thermostat first and the wiring centre second", () => {
    assert.deepEqual(
        definitions.map((candidate) => [candidate.model, candidate.vendor]),
        [
            ["SQ610RFNH", "Salus Controls"],
            ["KL08RF", "Salus Controls"],
        ],
    );
    assert.equal(wiringCentre.description, "iT600 8-zone wiring centre");
    assert.equal(wiringCentre.zigbeeModel, undefined);
    assert.deepEqual(wiringCentre.fingerprint, [{ manufacturerName: "Computime", type: "Router", endpoints: [{ ID: 8, profileID: 260 }] }]);
    assert.deepEqual([definition.endpoint({}), wiringCentre.endpoint({})], [{ default: 9 }, { default: 8 }]);
});

test("each definition has a device picture that is a WebP data URI under 20 kB, because zigbee2mqtt sends it in bridge/devices", () => {
    for (const candidate of definitions) {
        const picture = candidate.icon.match(/^data:image\/webp;base64,([A-Za-z0-9+/]+=*)$/);
        assert.ok(picture, `${candidate.model} has no WebP data URI as its icon`);
        const bytes = Buffer.from(picture[1], "base64");
        assert.equal(bytes.toString("latin1", 0, 4), "RIFF");
        assert.equal(bytes.toString("latin1", 8, 12), "WEBP");
        assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, `the WebP of ${candidate.model} is cut short`);
        assert.ok(candidate.icon.length < 20_000, `${candidate.model} icon is ${candidate.icon.length} characters`);
    }
    assert.notEqual(definition.icon, wiringCentre.icon);
});

test("herdsman parses the commands a wiring centre sends, which have the client-to-server bit", () => {
    const commands = [
        [0x10, SYNC_REQUEST, "syncRequest"],
        [0x33, ZONE_TABLE_AT_BOOT, "echo"],
        [0x37, "11 00 00", "syncAck"],
        [0x1a, "01 00 34 12", "replacedThermostat"],
        [0x16, "01", "wiringCentreRequest"],
        [0x88, "00 ff 00 00 00 00 00", "pairAck"],
        [0x84, "00 08 00", "pairDone"],
        [0xa9, "", "pairButton"],
    ];
    for (const [command, payload, name] of commands) {
        const buffer = frame(0x15, command, payload);
        assert.equal(Zcl.Header.fromBuffer(buffer).frameControl.direction, Zcl.Direction.CLIENT_TO_SERVER);
        const parsed = parseFrame(wiringCentre, buffer);
        assert.equal(parsed.command.name, name);
        assert.equal(parsed.payload.payload.toString("hex"), hex(payload).toString("hex"));
    }
});

test("the thermostat's commands, which have the server-to-client bit, still parse", () => {
    const commands = [
        [0x10, "ff 42 ff 50 00 00 00", "syncRequest"],
        [0x12, "02 01 00 07", "zoneReport"],
        [0x31, "71 01 00", "record"],
        [0x33, "01 42 32 30 07", "echo"],
        [0x16, "01", "wiringCentreRequest"],
    ];
    for (const [command, payload, name] of commands) {
        const buffer = frame(0x1d, command, payload);
        assert.equal(Zcl.Header.fromBuffer(buffer).frameControl.direction, Zcl.Direction.SERVER_TO_CLIENT);
        assert.equal(parseFrame(definition, buffer).command.name, name);
    }
});

test("a command the cluster does not declare is not parsed, so herdsman passes it on as a raw message of the cluster", () => {
    assert.throws(() => parseFrame(wiringCentre, frame(0x15, 0x42, "aa bb")), /manuSpecificSalusIt600/);
    // The cluster name herdsman puts on a raw message is the one the converter for it is registered under.
    assert.equal(Zcl.Utils.getCluster(0xfc00, 0x1078, customClustersOf(wiringCentre)).name, CLUSTER);
});

test("a sync request from the wiring centre is answered with device number 1 and the clock", async () => {
    mock.timers.enable({ apis: ["Date"], now: SUMMER_NOON });
    try {
        const endpoint = new WiringCentreEndpoint();
        assert.equal(await received(endpoint, "commandSyncRequest", SYNC_REQUEST), undefined);
        // Device number 1, then 12:00 local time in summer: flags 03 (summer time, 24 hour clock), time zone index 14, summer time offset 1 hour.
        assert.deepEqual(endpoint.sent, [["syncResponse", "0100400ebc31030e01ffffffff3100"]]);
        assert.equal(Buffer.from(endpoint.sent[0][1], "hex").readUInt32LE(2) + 946684800, Date.UTC(2026, 5, 10, 12, 0, 0) / 1000);
    } finally {
        mock.timers.reset();
    }
});

test("the sync response gives a thermostat device number 0x20 and a wiring centre device number 1", async () => {
    const device = new Thermostat();
    await definition.onEvent({ type: "deviceAnnounce", data: { device: { getEndpoint: () => device.endpoint } } });
    const endpoint = new WiringCentreEndpoint();
    await wiringCentre.onEvent({ type: "deviceAnnounce", data: { device: joinedDevice(endpoint) } });
    assert.deepEqual([device.syncs[0][0], endpoint.sent[0][1].slice(0, 2)], [0x20, "01"]);
});

test("a wiring centre that announces itself or finishes its interview gets the sync response and then the zone table request", async () => {
    for (const event of [
        { type: "deviceAnnounce", data: {} },
        { type: "deviceInterview", data: { status: "successful" } },
    ]) {
        const endpoint = new WiringCentreEndpoint();
        await wiringCentre.onEvent({ ...event, data: { ...event.data, device: joinedDevice(endpoint) } });
        assert.deepEqual(endpoint.commands, ["syncResponse", "write"]);
        assert.equal(endpoint.sent[0][1].length / 2, 15);
        assert.deepEqual(endpoint.sent[1], ["write", ZONE_TABLE_REQUEST]);
    }
});

test("nothing is sent to a wiring centre for other events, a failed interview or a device without endpoint 8", async () => {
    const endpoint = new WiringCentreEndpoint();
    const device = joinedDevice(endpoint);
    for (const event of [
        { type: "start", data: { device } },
        { type: "deviceInterview", data: { device, status: "failed" } },
        { type: "deviceNetworkAddressChanged", data: { device } },
        { type: "deviceAnnounce", data: { device: { getEndpoint: () => undefined } } },
    ]) {
        await wiringCentre.onEvent(event);
    }
    assert.deepEqual(endpoint.sent, []);
});

test("a zone table request that fails after the join only logs a warning", async () => {
    const endpoint = new WiringCentreEndpoint();
    endpoint.failing.add("write");
    await wiringCentre.onEvent({ type: "deviceAnnounce", data: { device: joinedDevice(endpoint) } });
    assert.deepEqual(endpoint.commands, ["syncResponse"]);
    assert.match(warnings.at(-1), /Zone table request to 0x[0-9a-f]+ failed \(no route\)/);
});

test("the zone table at boot publishes zone_1 to zone_8 as the IEEE address of each thermostat, with null for the free zone", async () => {
    assert.deepEqual(await received(new WiringCentreEndpoint(), "commandEcho", ZONE_TABLE_AT_BOOT), AT_BOOT);
});

test("a zone whose short address no device has shows the short address, and so does every zone when the lookup is missing", async () => {
    assert.equal(AT_BOOT.zone_7, "0x1206");
    const withoutLookup = { ieeeAddr: "0x001e5f0000000000" };
    const published = await fromWiringCentre(new WiringCentreEndpoint(), "commandEcho", { payload: hex(ZONE_TABLE_AT_BOOT) }, withoutLookup);
    assert.deepEqual(published, { ...AT_BOOT, zone_1: "0x1201", zone_2: "0x1202", zone_3: "0x1203", zone_4: "0x1201", zone_5: "0x1204", zone_6: "0x1205" });
});

test("the zone table is read whatever its handle, and addresses keep their leading zeros", async () => {
    // 0x8a is the handle of the table the wiring centre sends after a pairing, and the zone 8 is taken then.
    const table = hex(ZONE_TABLE_AT_BOOT);
    table[0] = 0x8a;
    table.writeUInt16BE(0x1234, 10 + 3 * 7);
    table.writeUInt16BE(0x00ab, 10);
    const published = await received(new WiringCentreEndpoint(), "commandEcho", table.toString("hex"));
    assert.deepEqual(published, { ...AT_BOOT, zone_1: "0x00ab", zone_8: "0x1234" });
});

test("an echo of another B-command, or a zone table that is cut short, publishes nothing", async () => {
    const endpoint = new WiringCentreEndpoint();
    assert.equal(await received(endpoint, "commandEcho", "09 42 32 31 01"), undefined);
    assert.equal(await received(endpoint, "commandEcho", ZONE_TABLE_AT_BOOT.slice(0, 33 * 2)), undefined);
    assert.deepEqual(await received(endpoint, "commandEcho", ZONE_TABLE_AT_BOOT.slice(0, 34 * 2)), AT_BOOT);
});

test("the 0x1a report publishes the thermostat that was replaced: its IEEE address if a device has the short address, else the short address", async () => {
    const endpoint = new WiringCentreEndpoint();
    assert.deepEqual(await received(endpoint, "commandReplacedThermostat", "01 00 34 12"), { replaced_thermostat: "0x1234" });
    assert.deepEqual(await received(endpoint, "commandReplacedThermostat", "01 00 01 12"), { replaced_thermostat: ieeeOf(0x1201) });
    assert.equal(await received(endpoint, "commandReplacedThermostat", "01 00 34"), undefined);
});

test("replaced_thermostat is a read-only text expose of the wiring centre", () => {
    const expose = wiringCentre.exposes.find((candidate) => candidate.property === "replaced_thermostat");
    assert.deepEqual([expose.type, expose.access], ["text", access.STATE]);
    assert.match(expose.description, /^IEEE address of the thermostat .*replaced.*short address while no device has it$/);
});

test("the pairing frames of the wiring centre are logged: 0x88 and 0x84 at debug with their payload, 0xa9 at info", async () => {
    const endpoint = new WiringCentreEndpoint();
    debugs.length = 0;
    infos.length = 0;
    assert.equal(await received(endpoint, "commandPairAck", "01 ff 00 00 00 00 00"), undefined);
    assert.equal(await received(endpoint, "commandPairDone", "00 08 00"), undefined);
    assert.equal(await received(endpoint, "commandPairButton", ""), undefined);
    assert.equal(debugs.length, 2);
    assert.match(debugs[0], /^Zone pairing ack \(0x88\) from 0x[0-9a-f]+, payload 01ff0000000000$/);
    assert.match(debugs[1], /^Zone pairing done \(0x84\) from 0x[0-9a-f]+, payload 000800$/);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /^Command 0xa9 \(probably the Pair button\) from 0x[0-9a-f]+, payload empty$/);
    assert.deepEqual(endpoint.sent, []);
});

test("the 0x37 after the sync request publishes and sends nothing", async () => {
    const endpoint = new WiringCentreEndpoint();
    assert.equal(await received(endpoint, "commandSyncAck", "11 00 00"), undefined);
    assert.deepEqual(endpoint.sent, []);
});

// A thermostat sends 0x16 with this payload; returns the 0x86 payloads it was sent back, in hex.
async function asksForWiringCentre(device, payload) {
    const request = definition.fromZigbee.find((candidate) => candidate.type === "commandWiringCentreRequest");
    const before = device.wiringCentreAnswers.length;
    await request.convert(definition, { data: { payload: hex(payload) }, device: { ieeeAddr: device.ieee }, endpoint: device.endpoint });
    return device.wiringCentreAnswers.slice(before).map((answer) => answer.toString("hex"));
}

test("the answer to 0x16 is command 0x86 of the cluster, built with the server-to-client bit like the sync response", () => {
    for (const candidate of definitions) {
        const answer = Zcl.Frame.create(
            Zcl.FrameType.SPECIFIC,
            Zcl.Direction.SERVER_TO_CLIENT,
            true,
            0x1078,
            0x28,
            "wiringCentreResponse",
            0xfc00,
            { payload: hex("01 78 56") },
            customClustersOf(candidate),
        );
        assert.equal(answer.toBuffer().toString("hex"), "1d78102886017856");
    }
});

test("a thermostat that asks for wiring centre 1 is told the short address of the wiring centre, little-endian", async () => {
    await greetedWiringCentre();
    const device = new Thermostat();
    infos.length = 0;
    assert.deepEqual(await asksForWiringCentre(device, "01"), ["017856"]);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /^0x[0-9a-f]+ asked for wiring centre 1, answering 017856$/);
});

test("the wiring centre is known from its join, its interview, its sync request and the start of zigbee2mqtt", async () => {
    // Each case has a wiring centre of its own, so every answer shows which one was learned last.
    const cases = [
        [0x9a00, "01009a", (endpoint) => wiringCentre.onEvent({ type: "deviceAnnounce", data: { device: joinedDevice(endpoint) } })],
        [
            0x9a01,
            "01019a",
            (endpoint) => wiringCentre.onEvent({ type: "deviceInterview", data: { device: joinedDevice(endpoint), status: "successful" } }),
        ],
        [0x9a02, "01029a", (endpoint) => received(endpoint, "commandSyncRequest", SYNC_REQUEST)],
        [0x9a03, "01039a", (endpoint) => wiringCentre.onEvent({ type: "start", data: { device: joinedDevice(endpoint) } })],
    ];
    const device = new Thermostat();
    for (const [short, answer, learn] of cases) {
        const endpoint = new WiringCentreEndpoint();
        endpoint.deviceNetworkAddress = short;
        await learn(endpoint);
        assert.deepEqual(await asksForWiringCentre(device, "01"), [answer]);
    }
});

test("the wiring centre's short address is read when it is asked for, so a new one after a rejoin is followed", async () => {
    const endpoint = await greetedWiringCentre();
    const device = new Thermostat();
    assert.deepEqual(await asksForWiringCentre(device, "01"), ["017856"]);
    endpoint.deviceNetworkAddress = 0x9abc;
    assert.deepEqual(await asksForWiringCentre(device, "01"), ["01bc9a"]);
});

test("a number that no wiring centre holds is answered 00 ff ff, and a thermostat's own number is not a wiring centre", async () => {
    await greetedWiringCentre();
    const device = new Thermostat();
    await definition.onEvent({ type: "deviceAnnounce", data: { device: { getEndpoint: () => device.endpoint } } });
    for (const number of ["00", "02", "09", "20", "ff"]) {
        assert.deepEqual(await asksForWiringCentre(device, number), ["00ffff"], number);
    }
});

test("a request without a number is not answered", async () => {
    const device = new Thermostat();
    infos.length = 0;
    assert.deepEqual(await asksForWiringCentre(device, ""), []);
    assert.deepEqual(infos, []);
});

test("the wiring centre answers a request for itself too, and an answer that cannot be sent only logs a warning", async () => {
    const endpoint = await greetedWiringCentre();
    assert.equal(await received(endpoint, "commandWiringCentreRequest", "01"), undefined);
    assert.deepEqual(endpoint.sent.slice(1), [["wiringCentreResponse", "017856"]]);
    endpoint.failing.add("wiringCentreResponse");
    assert.equal(await received(endpoint, "commandWiringCentreRequest", "01"), undefined);
    assert.match(warnings.at(-1), /Wiring centre answer to 0x[0-9a-f]+ failed \(no route\)/);
});

test("an unknown command is logged at info with its id and payload, but only if it is cluster specific", async () => {
    const endpoint = new WiringCentreEndpoint();
    infos.length = 0;
    assert.equal(await fromWiringCentre(endpoint, "raw", frame(0x15, 0x42, "aa bb 01")), undefined);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /^Unknown command 0x42 from 0x[0-9a-f]+: aabb01$/);
    assert.equal(await fromWiringCentre(endpoint, "raw", hex("08 01 0b 42 00")), undefined);
    assert.equal(infos.length, 1);
});

test("a get on any zone sends the zone table request, and nothing else", async () => {
    for (const key of ZONE_KEYS) {
        const endpoint = new WiringCentreEndpoint();
        const converter = wiringCentre.toZigbee.find((candidate) => candidate.key.includes(key));
        assert.equal(converter.convertSet, undefined);
        await converter.convertGet(endpoint, key, {});
        assert.deepEqual(endpoint.sent, [["write", ZONE_TABLE_REQUEST]]);
    }
    assert.equal(
        wiringCentre.toZigbee.find((candidate) => candidate.key.includes("zone_9")),
        undefined,
    );
});

test("a get on a zone fails when the request cannot be sent", async () => {
    const endpoint = new WiringCentreEndpoint();
    endpoint.failing.add("write");
    await assert.rejects(wiringCentre.toZigbee.find((candidate) => candidate.key.includes("zone_1")).convertGet(endpoint, "zone_1", {}), /no route/);
});

test("a zone table request takes its handle from the allocator of the B-commands, so the table cannot resolve a command that is waiting", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const endpoint = new WiringCentreEndpoint();
        endpoint.silent.add("B21");
        const salusCommand = wiringCentre.toZigbee.find((candidate) => candidate.key.includes("salus_command"));
        const zone = wiringCentre.toZigbee.find((candidate) => candidate.key.includes("zone_1"));
        let done = false;
        const waiting = salusCommand.convertSet(endpoint, "salus_command", "42323101", {});
        const failed = assert.rejects(waiting, /No B21 echo from 0x[0-9a-f]+ within 30000 ms/);
        waiting.then(
            () => (done = true),
            () => (done = true),
        );
        await settle();
        await zone.convertGet(endpoint, "zone_1", {});
        await zone.convertGet(endpoint, "zone_1", {});
        assert.deepEqual(
            endpoint.sent.map(([command, payload]) => [command, payload.slice(0, 8)]),
            [
                ["write", "01423231"],
                ["write", "02423730"],
                ["write", "03423730"],
            ],
        );
        // The wiring centre answers with its zone table under the handle of the request.
        for (const handle of [2, 3]) {
            const table = hex(ZONE_TABLE_AT_BOOT);
            table[0] = handle;
            assert.deepEqual(await received(endpoint, "commandEcho", table.toString("hex")), AT_BOOT);
        }
        await settle();
        assert.equal(done, false);
        mock.timers.tick(30000);
        await failed;
    } finally {
        mock.timers.reset();
    }
});

test("salus_command sends the B-command to the wiring centre's endpoint and waits for the echo", async () => {
    const endpoint = new WiringCentreEndpoint();
    const converter = wiringCentre.toZigbee.find((candidate) => candidate.key.includes("salus_command"));
    await converter.convertSet(endpoint, "salus_command", "42 37 30 7e aa aa a8 80 00 00 00 78", {});
    assert.deepEqual(endpoint.sent, [["write", ZONE_TABLE_REQUEST]]);
    await assert.rejects(converter.convertSet(endpoint, "salus_command", "3132", {}), /must be hex starting with a B-command code/);
});

test("salus_frame sends a whole 0x12 zone report of 18 bytes: 02 01, demand, zone, temperature, setpoint, frost", async () => {
    const endpoint = new WiringCentreEndpoint();
    const converter = wiringCentre.toZigbee.find((candidate) => candidate.key.includes("salus_frame"));
    await converter.convertSet(endpoint, "salus_frame", "12 0201010800ff0000000000ff3409b80bdc05", {});
    assert.deepEqual(endpoint.sent, [["zoneReport", "0201010800ff0000000000ff3409b80bdc05"]]);
});

test("salus_command and salus_frame refuse hex that is not whole bytes, instead of sending what Buffer.from keeps of it", async () => {
    const endpoint = new WiringCentreEndpoint();
    const cases = [
        ["salus_command", ""],
        ["salus_command", "   "],
        ["salus_command", "4237307"],
        ["salus_command", "42 37 30 7e aa aa a8 80 00 00 00 78 zz"],
        ["salus_command", "4237307eaaaaa88000000078z"],
        ["salus_command", "0x4237307eaaaaa88000000078"],
        ["salus_command", "42-37-30"],
        ["salus_frame", ""],
        ["salus_frame", "18010"],
        ["salus_frame", "18 01 08 00 00 ff 00 0"],
        ["salus_frame", "18 01 08 00 00 ff 00 0g"],
        ["salus_frame", "0x18"],
    ];
    for (const [key, value] of cases) {
        const converter = wiringCentre.toZigbee.find((candidate) => candidate.key.includes(key));
        await assert.rejects(converter.convertSet(endpoint, key, value, {}), new RegExp(`^Error: ${key} must be hex in whole bytes`), `${key} ${value}`);
    }
    assert.deepEqual(endpoint.sent, []);
    const frame = wiringCentre.toZigbee.find((candidate) => candidate.key.includes("salus_frame"));
    await frame.convertSet(endpoint, "salus_frame", "18 01 08 00 00 FF 00 00", {});
    assert.deepEqual(endpoint.sent, [["pairRequest", "01080000ff0000"]]);
});

test("zone_1 to zone_8 are text exposes that are read and requested, and salus_command and salus_frame are converters only", () => {
    const zones = wiringCentre.exposes.filter((expose) => expose.property?.startsWith("zone_"));
    assert.deepEqual(
        zones.map((expose) => expose.property),
        ZONE_KEYS,
    );
    for (const zone of zones) {
        assert.equal(zone.type, "text");
        assert.equal(zone.access, access.STATE_GET);
        assert.match(zone.description, /^IEEE address of the thermostat in zone [1-8], its short address while no device has it, null while the zone is free$/);
    }
    // zigbee2mqtt picks the converter of a /set message by its key and does not look at the exposes, so the raw tools work over MQTT without one.
    const exposed = wiringCentre.exposes.filter((expose) => expose.access & (access.SET | access.GET)).map((expose) => expose.property);
    assert.deepEqual(wiringCentre.toZigbee.flatMap((converter) => converter.key).toSorted(), [...exposed, "salus_command", "salus_frame"].toSorted());
    assert.deepEqual(wiringCentre.exposes.map((expose) => expose.property).filter((property) => property.startsWith("salus_")), []);
    const gettable = wiringCentre.exposes.filter((expose) => expose.access & access.GET).map((expose) => expose.property);
    assert.deepEqual(wiringCentre.toZigbee.filter((converter) => converter.convertGet).flatMap((converter) => converter.key), gettable);
});

// A zone table as the wiring centre sends it: the short addresses of the thermostats by zone, null for a free zone.
function zoneTable(shorts) {
    const table = hex(ZONE_TABLE_AT_BOOT);
    table[0] = 0x8a;
    shorts.forEach((short, index) => table.writeUInt16BE(short ?? 0xffff, 10 + 3 * index));
    return table.toString("hex");
}

const NO_ZONES = Array(8).fill(null);
const zonesWith = (short, zones) => NO_ZONES.map((_, index) => (zones.includes(index + 1) ? short : null));

// B47 for the wiring centre 0x5678 (78 56): the code, 00 11, the wiring centre number 1, its short address, fe, the replace flag, one flag per
// zone and 17 zeros.
function pairFrame(zones, { replace = 0, short = "7856" } = {}) {
    const flags = Array.from({ length: 8 }, (_, index) => (zones.includes(index + 1) ? "01" : "00")).join("");
    return `423437 0011 0100 ${short} fe 0${replace} ${flags} ${"00".repeat(17)}`.replaceAll(" ", "");
}

// B47 in the reset form that comes before the pairing form of a replace: the code, 00 11, ff ff for the wiring centre number, ff ff for its short
// address, fd, then zeros.
const RESET_FRAME = `423437 0011 ffff ffff fd ${"00".repeat(26)}`.replaceAll(" ", "");

// Lets the thermostat's B47 be sent and echoed.
async function settled() {
    for (let hop = 0; hop < 10; hop++) {
        await settle();
    }
}

test("wiring_centre_zones sends the B47 of the captured pairing and is done when the zone table shows the thermostat in the zone", async () => {
    const centre = await greetedWiringCentre();
    const device = new Thermostat();
    let done = false;
    const pairing = device.set("wiring_centre_zones", "8").then((result) => {
        done = true;
        return result;
    });
    await settled();
    // The frame of docs/wiring-centre.md for the wiring centre 0x5678 and zone 8.
    assert.deepEqual(device.frames, ["423437001101007856fe0000000000000000010000000000000000000000000000000000"]);
    assert.equal(device.frames[0], pairFrame([8]));
    assert.equal(done, false);
    await received(centre, "commandEcho", zoneTable(zonesWith(0x1201, [8])));
    assert.equal(await pairing, undefined);
});

test("wiring_centre_zones waits for every zone, and for the thermostat's own short address in it", async () => {
    const centre = await greetedWiringCentre();
    const device = new Thermostat();
    let done = false;
    const pairing = device.set("wiring_centre_zones", "1,4").then(() => (done = true));
    await settled();
    assert.deepEqual(device.frames, [pairFrame([1, 4])]);
    for (const table of [zonesWith(0x1201, [1]), [0x1201, null, null, 0x1202, null, null, null, null], zonesWith(0x1202, [1, 4])]) {
        await received(centre, "commandEcho", zoneTable(table));
        await settled();
        assert.equal(done, false);
    }
    await received(centre, "commandEcho", zoneTable([0x1201, null, null, 0x1201, null, null, null, 0x1203]));
    await pairing;
    assert.equal(done, true);
});

test("wiring_centre_zones takes zone numbers as text or as numbers, in any order, and replace in front of them", async () => {
    const centre = await greetedWiringCentre();
    const cases = [
        { value: "1,4", zones: [1, 4], replace: 0 },
        { value: "4, 1 4", zones: [1, 4], replace: 0 },
        { value: [1, 4], zones: [1, 4], replace: 0 },
        { value: 8, zones: [8], replace: 0 },
        { value: "replace 1,4", zones: [1, 4], replace: 1 },
        { value: "Replace 8", zones: [8], replace: 1 },
        { value: "replace,2", zones: [2], replace: 1 },
    ];
    for (const { value, zones, replace } of cases) {
        const device = new Thermostat();
        const pairing = device.set("wiring_centre_zones", value);
        await settled();
        assert.deepEqual(device.frames, [...(replace ? [RESET_FRAME] : []), pairFrame(zones, { replace })], JSON.stringify(value));
        await received(centre, "commandEcho", zoneTable(zonesWith(0x1201, zones)));
        await pairing;
    }
});

test("wiring_centre_zones sends the reset form of B47 and waits for its echo before the pairing form when the value starts with replace", async () => {
    const centre = await greetedWiringCentre();
    const device = new Thermostat();
    device.silent.add("B47:1");
    const pairing = watch(device.set("wiring_centre_zones", "replace 8"));
    await settled();
    assert.deepEqual(device.frames, [RESET_FRAME]);
    echoOf(device, `01 ${RESET_FRAME}`);
    await settled();
    assert.deepEqual(device.frames, [RESET_FRAME, pairFrame([8], { replace: 1 })]);
    assert.equal(pairing.state, "pending");
    await received(centre, "commandEcho", zoneTable(zonesWith(0x1201, [8])));
    await settle();
    assert.equal(pairing.state, "resolved");
});

test("wiring_centre_zones reads the short address of the wiring centre when it is called, so a rejoin is followed", async () => {
    const centre = await greetedWiringCentre();
    centre.deviceNetworkAddress = 0x9abc;
    const device = new Thermostat();
    const pairing = device.set("wiring_centre_zones", "2");
    await settled();
    assert.deepEqual(device.frames, [pairFrame([2], { short: "bc9a" })]);
    await received(centre, "commandEcho", zoneTable(zonesWith(0x1201, [2])));
    await pairing;
});

test("wiring_centre_zones fails when the zone table does not show the thermostat in time, as when the wiring centre refuses a taken zone", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const centre = await greetedWiringCentre();
        const device = new Thermostat();
        const pairing = device.set("wiring_centre_zones", "1,4");
        const failed = assert.rejects(pairing, /^Error: The zone table of the wiring centre does not show 0x[0-9a-f]+ in zone 1, 4 within 40 s of the B47.*replace/);
        await settled();
        await received(centre, "commandEcho", zoneTable(zonesWith(0x1202, [1, 4])));
        mock.timers.tick(39999);
        await settle();
        mock.timers.tick(1);
        await failed;
        // A table that comes after the failure changes nothing.
        await received(centre, "commandEcho", zoneTable(zonesWith(0x1201, [1, 4])));
    } finally {
        mock.timers.reset();
    }
});

test("wiring_centre_zones does not wait for the zone table when the thermostat does not echo the B47", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        await greetedWiringCentre();
        const device = new Thermostat();
        device.silent.add("B47");
        const failed = assert.rejects(device.set("wiring_centre_zones", "3"), /No B47 echo from 0x[0-9a-f]+ within 30000 ms/);
        await settle();
        mock.timers.tick(30000);
        await failed;
    } finally {
        mock.timers.reset();
    }
});

test("the stop event fails the zone pairing of that thermostat and no other, and clears its timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const timers = countTimers();
    try {
        const centre = await greetedWiringCentre();
        const device = new Thermostat();
        const other = new Thermostat();
        other.endpoint.deviceNetworkAddress = 0x1202;
        const stopped = watch(device.set("wiring_centre_zones", "8"));
        const kept = watch(other.set("wiring_centre_zones", "1"));
        await settled();
        assert.equal(timers.open, 2);
        await definition.onEvent({ type: "stop", data: { ieeeAddr: device.ieee } });
        await settle();
        assert.equal(stopped.state, "rejected");
        assert.match(stopped.error.message, /stopped/);
        assert.equal(kept.state, "pending");
        assert.equal(timers.open, 1);
        await received(centre, "commandEcho", zoneTable(zonesWith(0x1202, [1])));
        await settle();
        assert.equal(kept.state, "resolved");
        assert.equal(timers.open, 0);
    } finally {
        timers.restore();
        mock.timers.reset();
    }
});

test("wiring_centre_zones does not send the pairing form when the reset form is not echoed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        await greetedWiringCentre();
        const device = new Thermostat();
        device.silent.add("B47");
        const failed = assert.rejects(device.set("wiring_centre_zones", "replace 3"), /No B47 echo from 0x[0-9a-f]+ within 30000 ms/);
        await settled();
        mock.timers.tick(30000);
        await failed;
        assert.deepEqual(device.frames, [RESET_FRAME]);
    } finally {
        mock.timers.reset();
    }
});

test("wiring_centre_zones refuses what is not zones 1 to 8, with replace in front, before anything is sent", async () => {
    await greetedWiringCentre();
    for (const value of ["", "  ", "replace", "0", "9", "1,x", "1.5", "-1", "01", "1;4", "1,4 replace", "replace replace 1", null, {}, true]) {
        const device = new Thermostat();
        await assert.rejects(device.set("wiring_centre_zones", value), /^Error: wiring_centre_zones must be zone numbers 1 to 8/, JSON.stringify(value));
        assert.deepEqual(device.frames, [], JSON.stringify(value));
    }
});

test("wiring_centre_zones says so when no wiring centre is known, before anything is sent", async () => {
    // A copy of the converter has no wiring centre, as after a restart of zigbee2mqtt with a wiring centre that has not joined.
    const { default: copy } = await import("../converters/salus_sq610rfnh.mjs?without-a-wiring-centre");
    const converter = copy[0].toZigbee.find((candidate) => candidate.key.includes("wiring_centre_zones"));
    const device = new Thermostat();
    await assert.rejects(converter.convertSet(device.endpoint, "wiring_centre_zones", "1", {}), /^Error: No wiring centre is known/);
    assert.deepEqual(device.frames, []);
});

// A device as herdsman's definition lookup reads it: by default a router with endpoint 8 on the home automation profile.
function lookupDevice(properties, endpointIds = [[8, 0x0104]]) {
    const endpoints = endpointIds.map(([ID, profileID]) => ({ ID, profileID, inputClusters: [0x0000, 0xfc00], outputClusters: [] }));
    const getEndpoint = (id) => endpoints.find((endpoint) => endpoint.ID === id);
    return { type: "Router", ieeeAddr: "0x001e5f00000000ff", endpoints, getEndpoint, ...properties };
}

test("herdsman picks the wiring centre for a Computime device that reports no modelId, and the thermostat by its modelId", async () => {
    const converter = "salus_sq610rfnh.mjs";
    for (const candidate of definitions) {
        zhc.addExternalDefinition({ ...candidate, externalConverterName: converter });
    }
    try {
        const centre = await zhc.findByDevice(lookupDevice({ manufacturerName: "Computime" }));
        assert.equal(centre.model, "KL08RF");
        assert.deepEqual(centre.ota, { manufacturerName: "SalusControls" });
        assert.equal(centre.icon, wiringCentre.icon);
        const thermostat = await zhc.findByDevice(lookupDevice({ manufacturerName: "Computime", modelID: "SQ610RFNH" }, [[9, 0x0104]]));
        assert.equal(thermostat.model, "SQ610RFNH");
        assert.equal(thermostat.ota, true);
        assert.equal(thermostat.icon, definition.icon);
        assert.equal(await zhc.findByDevice(lookupDevice({ manufacturerName: "Somebody else" })), undefined);
        assert.equal(await zhc.findByDevice(lookupDevice({ manufacturerName: "Computime", modelID: "SQ999" })), undefined);
    } finally {
        zhc.removeExternalDefinitions(converter);
    }
    assert.equal(await zhc.findByDevice(lookupDevice({ manufacturerName: "Computime" })), undefined);
});

test("a device without a modelId is the wiring centre only as a Computime router with endpoint 8 alone, on the home automation profile", async () => {
    const converter = "salus_sq610rfnh.mjs";
    for (const candidate of definitions) {
        zhc.addExternalDefinition({ ...candidate, externalConverterName: converter });
    }
    try {
        const modelOf = async (properties, endpointIds) => (await zhc.findByDevice(lookupDevice(properties, endpointIds)))?.model;
        const computime = { manufacturerName: "Computime" };
        assert.equal(await modelOf(computime), "KL08RF");
        assert.equal(await modelOf({ ...computime, type: "EndDevice" }), undefined);
        assert.equal(await modelOf({ ...computime, type: "Coordinator" }), undefined);
        assert.equal(await modelOf(computime, [[9, 0x0104]]), undefined);
        assert.equal(await modelOf(computime, [[8, 0x0104], [9, 0x0104]]), undefined);
        assert.equal(await modelOf(computime, [[8, 0xc05e]]), undefined);
        assert.equal(await modelOf({ manufacturerName: "Somebody else" }), undefined);
    } finally {
        zhc.removeExternalDefinitions(converter);
    }
});
