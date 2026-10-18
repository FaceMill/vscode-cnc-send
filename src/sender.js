'use strict';

const { validate } = require('./config');
const { prepareProgram } = require('./text');
const { sendXmodem, receiveXmodem } = require('./xmodem');
const { sendStream, receiveStream } = require('./stream');
const { openPort, closePort, createTransport } = require('./serial');
const { CancelledError, ConfigError } = require('./errors');

let busy = false;

/**
 * Open the port for the settings, run `work(transport, common)`, and always close the port.
 * Only one transfer runs at a time. A serial error mid-transfer stops the work immediately.
 */
async function runTransfer(settings, options, work) {
    const { signal, log = () => {} } = options;

    const problems = validate(settings);
    if (problems.length) throw new ConfigError(problems);
    if (busy) throw new Error('A transfer is already in progress.');

    busy = true;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onExternalAbort);
    }

    let port;
    let portError = null;
    try {
        log(`Opening ${settings.port} at ${settings.baudRate} baud, ${settings.dataBits}${settings.parity[0].toUpperCase()}${settings.stopBits}, flow ${settings.flowControl}`);

        port = await openPort(settings);
        const fail = (err) => {
            if (!portError) portError = err;
            controller.abort();
        };
        port.on('error', fail);
        port.on('close', () => fail(new Error('Serial port closed during the transfer.')));

        const transport = createTransport(port);
        return await work(transport, { signal: controller.signal, log, onProgress: options.onProgress });
    } catch (err) {
        throw portError || err;
    } finally {
        if (signal) signal.removeEventListener('abort', onExternalAbort);
        await closePort(port);
        busy = false;
    }
}

/** Send program text to the control using the protocol in `settings`. */
function sendProgram(text, settings, options = {}) {
    const payload = Buffer.from(prepareProgram(text, settings), 'latin1');
    return runTransfer(settings, options, (transport, common) => {
        if (settings.protocol === 'xmodem') {
            return sendXmodem(payload, transport, {
                ...common,
                blockTimeoutMs: settings.blockTimeoutMs,
                startTimeoutMs: settings.startTimeoutMs,
                maxRetries: settings.maxRetries,
            });
        }
        return sendStream(payload, transport, {
            ...common,
            charDelayMs: settings.charDelayMs,
            lineDelayMs: settings.lineDelayMs,
            trailer: settings.trailer,
        });
    });
}

/**
 * Receive a file from the control. Resolves with the raw bytes (latin1 text for stream mode).
 * The control has to be told to send before the start timeout runs out.
 */
function receiveProgram(settings, options = {}) {
    return runTransfer(settings, options, (transport, common) => {
        if (settings.protocol === 'xmodem') {
            return receiveXmodem(transport, {
                ...common,
                blockTimeoutMs: settings.blockTimeoutMs,
                startTimeoutMs: settings.startTimeoutMs,
                maxRetries: settings.maxRetries,
            });
        }
        return receiveStream(transport, {
            ...common,
            startTimeoutMs: settings.startTimeoutMs,
            idleMs: settings.receiveIdleMs,
        });
    });
}

function isBusy() {
    return busy;
}

module.exports = { sendProgram, receiveProgram, isBusy, CancelledError };
