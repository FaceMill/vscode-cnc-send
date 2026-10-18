'use strict';

const { throwIfAborted, TransferError } = require('./errors');
const { ByteReader } = require('./xmodem');

const TRAILERS = { none: null, EOT: 0x04, ctrlZ: 0x1a };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Index just past the next CR, LF, or CRLF at or after `start`, or the buffer end. */
function nextLineEnd(bytes, start) {
    for (let i = start; i < bytes.length; i++) {
        if (bytes[i] === 0x0a) return i + 1;
        if (bytes[i] === 0x0d) return bytes[i + 1] === 0x0a ? i + 2 : i + 1;
    }
    return bytes.length;
}

/**
 * Stream program text to the control with no block framing.
 * The control has no acknowledgements here, so flow control is the serial driver's job
 * (XON/XOFF or RTS/CTS, set when the port is opened). We pace by writing one line at a time
 * and waiting for the OS output buffer to drain.
 *
 * options:
 *   charDelayMs   pause after every byte (for controls that drop characters when fed fast)
 *   lineDelayMs   pause after every line
 *   trailer       'none' | 'EOT' | 'ctrlZ' appended once at the end
 *   signal, log, onProgress(bytesDone, bytesTotal)
 */
async function sendStream(bytes, transport, options = {}) {
    const {
        charDelayMs = 0,
        lineDelayMs = 0,
        trailer = 'none',
        signal,
        log = () => {},
        onProgress,
    } = options;

    throwIfAborted(signal);

    if (charDelayMs > 0) {
        for (let i = 0; i < bytes.length; i++) {
            throwIfAborted(signal);
            await transport.write(bytes.subarray(i, i + 1));
            await delay(charDelayMs);
            if (onProgress) onProgress(i + 1, bytes.length);
        }
    } else {
        let start = 0;
        while (start < bytes.length) {
            throwIfAborted(signal);
            const end = nextLineEnd(bytes, start);
            await transport.write(bytes.subarray(start, end));
            await transport.drain();
            if (lineDelayMs > 0) await delay(lineDelayMs);
            start = end;
            if (onProgress) onProgress(start, bytes.length);
        }
    }

    const trailerByte = TRAILERS[trailer];
    if (trailerByte !== null && trailerByte !== undefined) {
        throwIfAborted(signal);
        await transport.write(Buffer.from([trailerByte]));
    }
    await transport.drain();
    log(`Stream transfer complete (${bytes.length} bytes)`);
}

/**
 * Capture text the control sends with no framing. Waits up to `startTimeoutMs` for the first byte,
 * then stops once the line has been silent for `idleMs`.
 * Trailing NUL and SUB bytes are removed; they are padding, not program text.
 *
 * options: startTimeoutMs, idleMs, maxBytes, signal, onProgress(bytesReceived)
 */
async function receiveStream(transport, options = {}) {
    const {
        startTimeoutMs = 60000,
        idleMs = 3000,
        maxBytes = 1024 * 1024,
        signal,
        onProgress,
    } = options;

    throwIfAborted(signal);
    const reader = new ByteReader(transport);
    const onAbort = () => reader.close();
    if (signal) signal.addEventListener('abort', onAbort);

    const bytes = [];
    try {
        reader.clear();
        for (;;) {
            const byte = await reader.read(bytes.length ? idleMs : startTimeoutMs);
            if (byte === null) break;
            bytes.push(byte);
            if (bytes.length >= maxBytes) {
                throw new TransferError(`Stopped after ${maxBytes} bytes. The control keeps sending.`);
            }
            if (onProgress && bytes.length % 256 === 0) onProgress(bytes.length);
        }
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        reader.close();
    }

    if (!bytes.length) {
        throw new TransferError('Timed out: nothing received. Start the output on the control first.');
    }
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x1a)) end--;
    return Buffer.from(bytes.slice(0, end));
}

module.exports = { sendStream, receiveStream, nextLineEnd, TRAILERS };
