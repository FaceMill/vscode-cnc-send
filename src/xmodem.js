'use strict';

const { CancelledError, TransferError, throwIfAborted } = require('./errors');

const SOH = 0x01;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_REQUEST = 0x43; // 'C': receiver asks for CRC-16 mode
const SUB = 0x1a;
const BLOCK_SIZE = 128;

/** CRC-16/XMODEM: polynomial 0x1021, initial value 0. */
function crc16(buffer) {
    let crc = 0;
    for (let i = 0; i < buffer.length; i++) {
        crc ^= buffer[i] << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        }
    }
    return crc & 0xffff;
}

function checksum8(buffer) {
    let sum = 0;
    for (const byte of buffer) sum = (sum + byte) & 0xff;
    return sum;
}

/** Build one SOH frame: header, 128-byte payload padded with `padByte`, then CRC-16 or checksum. */
function buildBlock(blockNum, data, useCrc, padByte = SUB) {
    const payload = Buffer.alloc(BLOCK_SIZE, padByte);
    data.copy(payload);

    let trailer;
    if (useCrc) {
        const crc = crc16(payload);
        trailer = Buffer.from([(crc >> 8) & 0xff, crc & 0xff]);
    } else {
        trailer = Buffer.from([checksum8(payload)]);
    }

    const n = blockNum & 0xff;
    return Buffer.concat([Buffer.from([SOH, n, 0xff - n]), payload, trailer]);
}

/**
 * Sequential byte reader over a transport's data events.
 * read(ms) resolves with the next byte, or null on timeout.
 * close() wakes any pending read; further reads throw CancelledError.
 */
class ByteReader {
    constructor(transport) {
        this.pending = [];
        this.waiters = [];
        this.closed = false;
        this.subscription = transport.onData((chunk) => {
            for (const byte of chunk) {
                const waiter = this.waiters.shift();
                if (waiter) waiter(byte);
                else this.pending.push(byte);
            }
        });
    }

    clear() {
        this.pending.length = 0;
    }

    async read(timeoutMs) {
        if (this.closed) throw new CancelledError();
        if (this.pending.length) return this.pending.shift();

        const byte = await new Promise((resolve) => {
            const waiter = (value) => {
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w !== waiter);
                resolve(null);
            }, timeoutMs);
            this.waiters.push(waiter);
        });

        if (this.closed) throw new CancelledError();
        return byte;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.subscription.dispose();
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter(null);
    }
}

/** Wait for the receiver's start character. 'C' selects CRC mode; NAK selects checksum mode. */
async function waitForReceiver(ctx) {
    const deadline = Date.now() + ctx.startTimeoutMs;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new TransferError('Timed out waiting for the control to start receiving. Put the control in its receive mode first.');
        }
        const byte = await ctx.reader.read(remaining);
        if (byte === null) continue;
        if (byte === CRC_REQUEST) return true;
        if (byte === NAK) return false;
        if (byte === CAN) throw new TransferError('Control aborted the transfer (CAN) before it started.');
        // Anything else is line noise; keep waiting.
    }
}

/** Read the receiver's reply to a block or EOT. Returns ACK, NAK, or null on timeout. */
async function readReply(ctx) {
    const deadline = Date.now() + ctx.blockTimeoutMs;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const byte = await ctx.reader.read(remaining);
        if (byte === null) return null;
        if (byte === ACK || byte === NAK) return byte;
        if (byte === CAN) throw new TransferError('Control aborted the transfer (CAN).');
        // Ignore other bytes and keep waiting for ACK/NAK.
    }
}

async function sendWithRetries(ctx, frame, label) {
    for (let attempt = 0; ; attempt++) {
        throwIfAborted(ctx.signal);
        await ctx.transport.write(frame);
        const reply = await readReply(ctx);
        throwIfAborted(ctx.signal);
        if (reply === ACK) return;
        if (attempt >= ctx.maxRetries) {
            throw new TransferError(`Block ${label} was not acknowledged after ${ctx.maxRetries} retries.`);
        }
        ctx.log(`Block ${label}: ${reply === null ? 'timeout' : 'NAK'}, retry ${attempt + 1}/${ctx.maxRetries}`);
    }
}

async function sendEot(ctx) {
    for (let attempt = 0; ; attempt++) {
        throwIfAborted(ctx.signal);
        await ctx.transport.write(Buffer.from([EOT]));
        const reply = await readReply(ctx);
        if (reply === ACK) return;
        if (attempt >= ctx.maxRetries) {
            throw new TransferError('Control did not acknowledge end of transfer (EOT).');
        }
        ctx.log(`EOT: ${reply === null ? 'timeout' : 'NAK'}, retry ${attempt + 1}/${ctx.maxRetries}`);
    }
}

/**
 * Send `data` over XMODEM (128-byte blocks, CRC-16 or checksum decided by the receiver).
 *
 * options:
 *   blockTimeoutMs, startTimeoutMs, maxRetries, padByte
 *   signal      AbortSignal; aborting sends CAN CAN and rejects with CancelledError
 *   log         (message) => void
 *   onProgress  (blocksDone, blockCount) => void
 */
async function sendXmodem(data, transport, options = {}) {
    const {
        blockTimeoutMs = 10000,
        startTimeoutMs = 60000,
        maxRetries = 10,
        padByte = SUB,
        signal,
        log = () => {},
        onProgress,
    } = options;

    throwIfAborted(signal);
    const reader = new ByteReader(transport);
    const onAbort = () => reader.close();
    if (signal) signal.addEventListener('abort', onAbort);

    const ctx = { transport, reader, signal, log, blockTimeoutMs, startTimeoutMs, maxRetries };

    try {
        reader.clear();
        const useCrc = await waitForReceiver(ctx);
        log(`Control requested ${useCrc ? 'CRC-16' : 'checksum'} mode`);

        const blockCount = Math.ceil(data.length / BLOCK_SIZE);
        for (let n = 1; n <= blockCount; n++) {
            const start = (n - 1) * BLOCK_SIZE;
            const frame = buildBlock(n, data.subarray(start, start + BLOCK_SIZE), useCrc, padByte);
            await sendWithRetries(ctx, frame, `${n}/${blockCount}`);
            if (onProgress) onProgress(n, blockCount);
        }

        await sendEot(ctx);
        log('XMODEM transfer complete');
    } catch (err) {
        if (signal && signal.aborted) {
            await transport.write(Buffer.from([CAN, CAN])).catch(() => {});
            throw new CancelledError();
        }
        // Tell the control we are giving up so it does not sit in receive mode.
        await transport.write(Buffer.from([CAN, CAN])).catch(() => {});
        throw err;
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        reader.close();
    }
}

/** Wait for SOH, EOT, or CAN, ignoring other bytes. Returns null on timeout. */
async function waitForHeader(reader, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const byte = await reader.read(remaining);
        if (byte === null) return null;
        if (byte === SOH || byte === EOT || byte === CAN) return byte;
    }
}

/** Read exactly `count` bytes, each with its own timeout. Returns null if a byte is late. */
async function readExact(reader, count, timeoutMs) {
    const out = Buffer.alloc(count);
    for (let i = 0; i < count; i++) {
        const byte = await reader.read(timeoutMs);
        if (byte === null) return null;
        out[i] = byte;
    }
    return out;
}

/** The rest of an SOH frame after the header byte. Returns null if it is incomplete. */
async function readFrame(reader, useCrc, timeoutMs) {
    const head = await readExact(reader, 2, timeoutMs);
    if (!head) return null;
    const payload = await readExact(reader, BLOCK_SIZE, timeoutMs);
    if (!payload) return null;
    const trailer = await readExact(reader, useCrc ? 2 : 1, timeoutMs);
    if (!trailer) return null;
    return { n: head[0], complement: head[1], payload, trailer };
}

/** Remove trailing SUB (0x1A) padding that XMODEM adds to fill the last block. */
function stripPadding(buffer) {
    let end = buffer.length;
    while (end > 0 && buffer[end - 1] === SUB) end--;
    return buffer.subarray(0, end);
}

/**
 * Receive a file from the control. We are the XMODEM receiver: we request the transfer,
 * check each block, and ACK or NAK it. Start requests are 'C' (CRC-16); after three unanswered
 * requests we switch to NAK (checksum), which some controls expect.
 *
 * Returns the program bytes with trailing SUB padding removed.
 *
 * options:
 *   blockTimeoutMs, startTimeoutMs, maxRetries
 *   requestIntervalMs  wait between start requests (default 3000)
 *   signal             AbortSignal; aborting sends CAN CAN and rejects with CancelledError
 *   log                (message) => void
 *   onProgress         (blocksReceived) => void
 */
async function receiveXmodem(transport, options = {}) {
    const {
        blockTimeoutMs = 10000,
        startTimeoutMs = 60000,
        maxRetries = 10,
        requestIntervalMs = 3000,
        signal,
        log = () => {},
        onProgress,
    } = options;

    throwIfAborted(signal);
    const reader = new ByteReader(transport);
    const onAbort = () => reader.close();
    if (signal) signal.addEventListener('abort', onAbort);

    const chunks = [];
    let expected = 1;
    let retries = 0;
    let useCrc = true;
    let requests = 0;
    const send = (byte) => transport.write(Buffer.from([byte]));
    const retry = async (reason) => {
        retries++;
        if (retries > maxRetries) {
            throw new TransferError(`Too many errors receiving block ${expected & 0xff} (${reason}).`);
        }
        log(`Block ${expected & 0xff}: ${reason}, NAK (retry ${retries}/${maxRetries})`);
        await send(NAK);
    };

    try {
        reader.clear();

        // Start handshake: request until the control sends a block or EOT.
        let header = null;
        const startDeadline = Date.now() + startTimeoutMs;
        while (header === null) {
            throwIfAborted(signal);
            if (Date.now() >= startDeadline) {
                throw new TransferError('Timed out waiting for the control to send. Start the send on the control first.');
            }
            if (requests >= 3) useCrc = false;
            await send(useCrc ? CRC_REQUEST : NAK);
            requests++;
            const wait = Math.min(requestIntervalMs, Math.max(1, startDeadline - Date.now()));
            header = await waitForHeader(reader, wait);
            if (header === CAN) throw new TransferError('Control aborted the transfer (CAN) before it started.');
        }
        log(`Control is sending in ${useCrc ? 'CRC-16' : 'checksum'} mode`);

        for (;;) {
            throwIfAborted(signal);
            if (header === null) {
                header = await waitForHeader(reader, blockTimeoutMs);
                if (header === null) {
                    await retry('timeout');
                    continue;
                }
            }
            const current = header;
            header = null;

            if (current === EOT) {
                await send(ACK);
                break;
            }
            if (current === CAN) throw new TransferError('Control aborted the transfer (CAN).');

            const frame = await readFrame(reader, useCrc, blockTimeoutMs);
            if (!frame) {
                await retry('incomplete block');
                continue;
            }
            const { n, complement, payload, trailer } = frame;
            if (((n + complement) & 0xff) !== 0xff) {
                await retry('bad block header');
                continue;
            }
            const valid = useCrc
                ? crc16(payload) === trailer.readUInt16BE(0)
                : checksum8(payload) === trailer[0];
            if (!valid) {
                await retry(useCrc ? 'CRC error' : 'checksum error');
                continue;
            }
            if (n === ((expected - 1) & 0xff)) {
                // Our ACK was lost and the control resent the block we already have.
                await send(ACK);
                continue;
            }
            if (n !== (expected & 0xff)) {
                throw new TransferError(`Block ${n} arrived but block ${expected & 0xff} was expected.`);
            }

            chunks.push(Buffer.from(payload));
            expected++;
            retries = 0;
            await send(ACK);
            if (onProgress) onProgress(chunks.length);
        }
    } catch (err) {
        // Tell the control we are stopping so it does not wait in send mode.
        await transport.write(Buffer.from([CAN, CAN])).catch(() => {});
        if (signal && signal.aborted) throw new CancelledError();
        throw err;
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        reader.close();
    }

    return stripPadding(Buffer.concat(chunks));
}

module.exports = {
    sendXmodem,
    receiveXmodem,
    buildBlock,
    crc16,
    checksum8,
    ByteReader,
    BLOCK_SIZE,
    SOH,
    EOT,
    ACK,
    NAK,
    CAN,
    CRC_REQUEST,
};
