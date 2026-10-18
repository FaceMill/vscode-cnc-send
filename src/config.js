'use strict';

// Single source of truth for every cncDnc.* setting. package.json must
// declare the same keys and defaults; test/config.test.js enforces that.
const DEFAULTS = Object.freeze({
    // Serial line
    port: '',
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none', // none | hardware (RTS/CTS) | software (XON/XOFF)
    dtr: true,
    rts: true,

    // Transfer
    protocol: 'xmodem', // xmodem | stream
    lineEnding: 'asIs', // asIs | LF | CRLF | CR
    wrapWithPercent: false,
    trailer: 'none', // none | EOT | ctrlZ

    // Timing
    charDelayMs: 0, // stream only: pause after each byte
    lineDelayMs: 0, // stream only: pause after each line
    receiveIdleMs: 3000, // stream receive: end after this much silence
    blockTimeoutMs: 10000, // xmodem: wait for ACK/NAK per block
    startTimeoutMs: 60000, // xmodem: wait for the control to start the receive
    maxRetries: 10, // xmodem: retransmissions per block
});

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const DATA_BITS = [5, 6, 7, 8];
const PARITIES = ['none', 'even', 'odd', 'mark', 'space'];
const STOP_BITS = [1, 1.5, 2];
const FLOW_CONTROL = ['none', 'hardware', 'software'];
const PROTOCOLS = ['xmodem', 'stream'];
const LINE_ENDINGS = ['asIs', 'LF', 'CRLF', 'CR'];
const TRAILERS = ['none', 'EOT', 'ctrlZ'];

const NUMERIC = ['baudRate', 'dataBits', 'stopBits', 'charDelayMs', 'lineDelayMs', 'receiveIdleMs', 'blockTimeoutMs', 'startTimeoutMs', 'maxRetries'];
const BOOLEAN = ['dtr', 'rts', 'wrapWithPercent'];

// Starting points for common controls. Applying a profile only fills the form;
// nothing is saved until the user presses Save. Verify each against the
// control's own RS-232 / communication settings screen.
const MACHINE_PROFILES = Object.freeze({
    haas: {
        label: 'Haas (XMODEM)',
        settings: {
            baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none',
            protocol: 'xmodem', lineEnding: 'asIs', wrapWithPercent: false, trailer: 'none',
        },
    },
    fanuc: {
        label: 'FANUC (stream, XON/XOFF)',
        settings: {
            baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'software',
            protocol: 'stream', lineEnding: 'CRLF', wrapWithPercent: true, trailer: 'none',
            charDelayMs: 0, lineDelayMs: 0,
        },
    },
    xmodem: {
        label: 'Generic XMODEM',
        settings: {
            baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none',
            protocol: 'xmodem', lineEnding: 'asIs', wrapWithPercent: false, trailer: 'none',
        },
    },
    stream: {
        label: 'Generic text stream',
        settings: {
            baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none',
            protocol: 'stream', lineEnding: 'LF', wrapWithPercent: false, trailer: 'none',
            charDelayMs: 0, lineDelayMs: 0,
        },
    },
});

/**
 * Build a complete settings object from any getter (VS Code configuration or a plain object).
 * Values are coerced to the right types so webview form strings become numbers/booleans.
 */
function readSettings(getter) {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
        let value = getter(key);
        if (value === undefined || value === null) value = DEFAULTS[key];
        if (NUMERIC.includes(key)) value = Number(value);
        else if (BOOLEAN.includes(key)) value = value === true || value === 'true' || value === 'on';
        else value = String(value);
        out[key] = value;
    }
    return out;
}

function fromObject(obj) {
    return readSettings((key) => (obj ? obj[key] : undefined));
}

/** Return a list of human-readable problems. Empty list means the settings can be used. */
function validate(s, { requirePort = true } = {}) {
    const problems = [];
    if (requirePort && !s.port) problems.push('No serial port selected.');
    if (!BAUD_RATES.includes(s.baudRate) && !(Number.isInteger(s.baudRate) && s.baudRate > 0)) {
        problems.push(`Unsupported baud rate: ${s.baudRate}.`);
    }
    if (!DATA_BITS.includes(s.dataBits)) problems.push(`Data bits must be one of ${DATA_BITS.join(', ')}.`);
    if (!PARITIES.includes(s.parity)) problems.push(`Parity must be one of ${PARITIES.join(', ')}.`);
    if (!STOP_BITS.includes(s.stopBits)) problems.push(`Stop bits must be one of ${STOP_BITS.join(', ')}.`);
    if (!FLOW_CONTROL.includes(s.flowControl)) problems.push(`Flow control must be one of ${FLOW_CONTROL.join(', ')}.`);
    if (!PROTOCOLS.includes(s.protocol)) problems.push(`Protocol must be one of ${PROTOCOLS.join(', ')}.`);
    if (!LINE_ENDINGS.includes(s.lineEnding)) problems.push(`Line ending must be one of ${LINE_ENDINGS.join(', ')}.`);
    if (!TRAILERS.includes(s.trailer)) problems.push(`Trailer must be one of ${TRAILERS.join(', ')}.`);

    for (const key of ['charDelayMs', 'lineDelayMs', 'receiveIdleMs', 'blockTimeoutMs', 'startTimeoutMs', 'maxRetries']) {
        if (!Number.isFinite(s[key]) || s[key] < 0) problems.push(`${key} must be a number of 0 or more.`);
    }

    if (s.protocol === 'xmodem') {
        // XMODEM carries raw binary blocks, so the line has to be a clean 8-bit, no-parity link.
        if (s.dataBits !== 8) problems.push('XMODEM needs 8 data bits.');
        if (s.parity !== 'none') problems.push('XMODEM needs parity set to none.');
        if (s.flowControl === 'software') {
            problems.push('XMODEM cannot use XON/XOFF: bytes 0x11/0x13 occur in binary blocks. Use hardware or none.');
        }
    }
    return problems;
}

/**
 * Read the saved profile list. `stored` is the cncDnc.profiles array.
 * With no saved profiles, one "Default" profile is built from the legacy flat settings (if any) or the defaults.
 */
function profilesFrom(stored, getter) {
    const cleaned = (Array.isArray(stored) ? stored : [])
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({ name: String(p.name || '').trim(), ...fromObject(p) }))
        .filter((p) => p.name);
    if (cleaned.length) return cleaned;
    return [{ name: 'Default', ...readSettings(getter || (() => undefined)) }];
}

/** Profiles plus the active profile name, read through one getter (VS Code configuration or a plain object). */
function loadState(getter) {
    const profiles = profilesFrom(getter('profiles'), getter);
    return { profiles, activeProfile: String(getter('activeProfile') || '') };
}

/** The named profile, or the first one when the name is missing or stale. */
function resolveProfile(profiles, name) {
    return profiles.find((p) => p.name === name) || profiles[0];
}

/** Null when the name is usable, otherwise a message for the user. `exceptName` lets a profile keep its own name. */
function validateProfileName(name, profiles, exceptName) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return 'Profile name cannot be empty.';
    if (trimmed.length > 40) return 'Profile name is too long (40 characters at most).';
    if (profiles.some((p) => p.name === trimmed && p.name !== exceptName)) {
        return `A profile named "${trimmed}" already exists.`;
    }
    return null;
}

module.exports = {
    DEFAULTS,
    profilesFrom,
    loadState,
    resolveProfile,
    validateProfileName,
    MACHINE_PROFILES,
    BAUD_RATES,
    DATA_BITS,
    PARITIES,
    STOP_BITS,
    FLOW_CONTROL,
    PROTOCOLS,
    LINE_ENDINGS,
    TRAILERS,
    readSettings,
    fromObject,
    validate,
};
