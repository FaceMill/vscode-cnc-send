'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { receiveXmodem, buildBlock, ACK, NAK, CAN, EOT, CRC_REQUEST } = require('../src/xmodem');
const { receiveStream } = require('../src/stream');
const { CancelledError, TransferError } = require('../src/errors');
const { fakeLine } = require('./helpers');

const FAST = { blockTimeoutMs: 200, startTimeoutMs: 500, requestIntervalMs: 20 };

/** A control that answers each byte the receiver writes with the next scripted reply (null = silence). */
function scriptedControl(replies) {
    const queue = [...replies];
    return fakeLine(() => (queue.length ? queue.shift() : null));
}

function program(length) {
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) buf[i] = 0x30 + (i % 40);
    return buf;
}

/** Frames for `data`, numbered from 1, the way a control sends them. */
function framesFor(data, useCrc = true) {
    const frames = [];
    for (let i = 0; i * 128 < data.length; i++) {
        frames.push(buildBlock(i + 1, data.subarray(i * 128, (i + 1) * 128), useCrc));
    }
    return frames;
}

test('CRC receive: blocks are ACKed and the padding is removed', async () => {
    const data = program(300);
    const [f1, f2, f3] = framesFor(data);
    const line = scriptedControl([f1, f2, f3, Buffer.from([EOT])]);
    const received = await receiveXmodem(line, FAST);

    assert.deepEqual(received, data);
    assert.equal(line.written[0][0], CRC_REQUEST, 'first request is C');
    assert.deepEqual(line.written.slice(1, 4).map((b) => b[0]), [ACK, ACK, ACK]);
    assert.deepEqual(line.written[4], Buffer.from([ACK]), 'EOT is ACKed');
});

test('checksum fallback: after three C requests the receiver sends NAK', async () => {
    const data = program(200);
    const [f1, f2] = framesFor(data, false);
    const line = scriptedControl([null, null, null, f1, f2, Buffer.from([EOT])]);
    const received = await receiveXmodem(line, FAST);

    assert.deepEqual(received, data);
    assert.deepEqual(line.written.slice(0, 3).map((b) => b[0]), [CRC_REQUEST, CRC_REQUEST, CRC_REQUEST]);
    assert.equal(line.written[3][0], NAK);
});

test('a block with a bad CRC is NAKed and then received on the retry', async () => {
    const data = program(200);
    const [f1, f2] = framesFor(data);
    const bad = Buffer.from(f1);
    bad[10] ^= 0xff;
    const line = scriptedControl([bad, f1, f2, Buffer.from([EOT])]);
    const received = await receiveXmodem(line, FAST);

    assert.deepEqual(received, data);
    assert.equal(line.written[1][0], NAK, 'bad block was NAKed');
});

test('a duplicate block (lost ACK) is ACKed again and not stored twice', async () => {
    const data = program(200);
    const [f1, f2] = framesFor(data);
    const line = scriptedControl([f1, f1, f2, Buffer.from([EOT])]);
    const received = await receiveXmodem(line, FAST);

    assert.deepEqual(received, data);
    assert.equal(received.length, 200);
});

test('an out-of-sequence block aborts with CAN CAN', async () => {
    const data = program(200);
    const [f1] = framesFor(data);
    const wrong = buildBlock(3, Buffer.alloc(10, 0x41), true);
    const line = scriptedControl([f1, wrong]);

    await assert.rejects(receiveXmodem(line, FAST), (err) => err instanceof TransferError && /Block 3 arrived but block 2/.test(err.message));
    assert.deepEqual(line.written.at(-1), Buffer.from([CAN, CAN]));
});

test('no data from the control times out with a clear message', async () => {
    const line = scriptedControl([]);
    await assert.rejects(
        receiveXmodem(line, { blockTimeoutMs: 50, startTimeoutMs: 120, requestIntervalMs: 20 }),
        (err) => err instanceof TransferError && /Timed out waiting for the control to send/.test(err.message),
    );
});

test('an empty program (immediate EOT) returns no bytes', async () => {
    const line = scriptedControl([Buffer.from([EOT])]);
    const received = await receiveXmodem(line, FAST);
    assert.equal(received.length, 0);
});

test('aborting while waiting sends CAN CAN and rejects with CancelledError', async () => {
    const controller = new AbortController();
    const line = scriptedControl([]);
    const done = receiveXmodem(line, { ...FAST, requestIntervalMs: 1000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(done, CancelledError);
    assert.deepEqual(line.written.at(-1), Buffer.from([CAN, CAN]));
});

test('stream receive captures text until the line goes quiet', async () => {
    const line = fakeLine(() => null);
    const pending = receiveStream(line, { startTimeoutMs: 500, idleMs: 40 });
    setTimeout(() => line.emit(Buffer.from('%\nO1234\nG0 X0\nM30\n%\n')), 10);
    const text = (await pending).toString('latin1');
    assert.equal(text, '%\nO1234\nG0 X0\nM30\n%\n');
});

test('stream receive strips trailing NUL and Ctrl-Z padding', async () => {
    const line = fakeLine(() => null);
    const pending = receiveStream(line, { startTimeoutMs: 500, idleMs: 40 });
    setTimeout(() => line.emit(Buffer.from('M30\n\x00\x1a\x00')), 10);
    assert.equal((await pending).toString('latin1'), 'M30\n');
});

test('stream receive with nothing sent times out with a clear message', async () => {
    const line = fakeLine(() => null);
    await assert.rejects(receiveStream(line, { startTimeoutMs: 50, idleMs: 20 }), (err) => err instanceof TransferError && /nothing received/.test(err.message));
});
