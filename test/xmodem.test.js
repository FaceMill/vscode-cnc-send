'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendXmodem, buildBlock, crc16, checksum8, SOH, EOT, ACK, NAK, CAN, CRC_REQUEST } = require('../src/xmodem');
const { CancelledError, TransferError } = require('../src/errors');
const { fakeLine } = require('./helpers');

const FAST = { blockTimeoutMs: 100, startTimeoutMs: 300 };

function program(length) {
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) buf[i] = 0x30 + (i % 40);
    return buf;
}

test('CRC-16/XMODEM matches the standard check value', () => {
    assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
});

test('buildBlock lays out header, padded payload, and CRC', () => {
    const frame = buildBlock(5, Buffer.from('G0 X1'), true);
    assert.equal(frame.length, 3 + 128 + 2);
    assert.equal(frame[0], SOH);
    assert.equal(frame[1], 5);
    assert.equal(frame[2], 0xff - 5);
    const payload = frame.subarray(3, 131);
    assert.equal(payload.subarray(0, 5).toString(), 'G0 X1');
    assert.ok(payload.subarray(5).every((b) => b === 0x1a), 'padding is SUB');
    assert.equal(frame.readUInt16BE(131), crc16(payload));
});

test('checksum mode frame ends with one-byte sum', () => {
    const frame = buildBlock(1, Buffer.from([1, 2, 3]), false);
    assert.equal(frame.length, 3 + 128 + 1);
    assert.equal(frame[131], checksum8(frame.subarray(3, 131)));
});

test('CRC mode: multi-block transfer, every block ACKed, EOT at the end', async () => {
    const data = program(300);
    const line = fakeLine(() => ACK);
    const progress = [];
    const done = sendXmodem(data, line, { ...FAST, onProgress: (n, total) => progress.push([n, total]) });
    line.emit([CRC_REQUEST]);
    await done;

    assert.equal(line.written.length, 3 + 1, 'three blocks plus EOT');
    line.written.slice(0, 3).forEach((frame, i) => {
        assert.equal(frame.length, 133);
        assert.equal(frame[1], i + 1);
        assert.equal(frame[2], 0xff - (i + 1));
        assert.equal(frame.readUInt16BE(131), crc16(frame.subarray(3, 131)));
    });
    const last = line.written[2].subarray(3, 131);
    assert.equal(last.subarray(0, 44).toString(), data.subarray(256).toString());
    assert.ok(last.subarray(44).every((b) => b === 0x1a));
    assert.deepEqual(line.written[3], Buffer.from([EOT]));
    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

test('checksum mode is chosen when the control sends NAK', async () => {
    const line = fakeLine(() => ACK);
    const done = sendXmodem(program(10), line, FAST);
    line.emit([NAK]);
    await done;
    assert.equal(line.written[0].length, 132);
    assert.equal(line.written[0][131], checksum8(line.written[0].subarray(3, 131)));
});

test('line noise before the start character is ignored', async () => {
    const line = fakeLine(() => ACK);
    const done = sendXmodem(program(4), line, FAST);
    line.emit([0x00, 0x55, 0xff, CRC_REQUEST]);
    await done;
    assert.equal(line.written[0].length, 133);
});

test('a NAK retransmits the same block', async () => {
    let firstBlock = true;
    const line = fakeLine((frame) => {
        if (frame[0] === SOH && firstBlock) {
            firstBlock = false;
            return NAK;
        }
        return ACK;
    });
    const done = sendXmodem(program(20), line, FAST);
    line.emit([CRC_REQUEST]);
    await done;
    assert.equal(line.written.length, 3, 'block, retried block, EOT');
    assert.deepEqual(line.written[0], line.written[1]);
});

test('a NAK on EOT is retried until ACK', async () => {
    let eotCount = 0;
    const line = fakeLine((frame) => {
        if (frame.length === 1 && frame[0] === EOT) {
            eotCount++;
            return eotCount === 1 ? NAK : ACK;
        }
        return ACK;
    });
    const done = sendXmodem(program(20), line, FAST);
    line.emit([CRC_REQUEST]);
    await done;
    assert.equal(eotCount, 2);
});

test('an empty program sends only EOT', async () => {
    const line = fakeLine(() => ACK);
    const done = sendXmodem(Buffer.alloc(0), line, FAST);
    line.emit([CRC_REQUEST]);
    await done;
    assert.deepEqual(line.written, [Buffer.from([EOT])]);
});

test('no start character times out with a clear message and CAN CAN', async () => {
    const line = fakeLine(() => ACK);
    const done = sendXmodem(program(10), line, { blockTimeoutMs: 50, startTimeoutMs: 80 });
    await assert.rejects(done, (err) => err instanceof TransferError && /Timed out waiting/.test(err.message));
    assert.deepEqual(line.written.at(-1), Buffer.from([CAN, CAN]));
});

test('a silent control exhausts retries, then fails with CAN CAN', async () => {
    const line = fakeLine(() => null);
    const done = sendXmodem(program(10), line, { blockTimeoutMs: 20, startTimeoutMs: 300, maxRetries: 2 });
    line.emit([CRC_REQUEST]);
    await assert.rejects(done, (err) => err instanceof TransferError && /after 2 retries/.test(err.message));
    assert.equal(line.written.length, 3 + 1, 'original plus two retries, then CAN CAN');
    assert.deepEqual(line.written.at(-1), Buffer.from([CAN, CAN]));
});

test('CAN from the control aborts the transfer', async () => {
    const line = fakeLine(() => CAN);
    const done = sendXmodem(program(10), line, FAST);
    line.emit([CRC_REQUEST]);
    await assert.rejects(done, (err) => err instanceof TransferError && /CAN/.test(err.message));
});

test('aborting mid-transfer rejects with CancelledError and cancels the control', async () => {
    const controller = new AbortController();
    const line = fakeLine(() => null);
    const done = sendXmodem(program(10), line, { ...FAST, blockTimeoutMs: 5000, signal: controller.signal });
    line.emit([CRC_REQUEST]);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(done, CancelledError);
    assert.deepEqual(line.written.at(-1), Buffer.from([CAN, CAN]));
});

test('an already-aborted signal sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const line = fakeLine(() => ACK);
    await assert.rejects(sendXmodem(program(10), line, { ...FAST, signal: controller.signal }), CancelledError);
    assert.equal(line.written.length, 0);
});
