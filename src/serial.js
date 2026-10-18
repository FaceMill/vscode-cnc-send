'use strict';

// The only module that touches serialport. Everything else talks to the Transport interface:
//   write(buffer) -> Promise, drain() -> Promise, onData(cb) -> { dispose() }

const { SerialPort } = require('serialport');

async function listPorts() {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
        path: p.path,
        description: [p.manufacturer, p.serialNumber].filter(Boolean).join(' '),
    }));
}

function toOpenOptions(s) {
    const software = s.flowControl === 'software';
    return {
        path: s.port,
        baudRate: s.baudRate,
        dataBits: s.dataBits,
        parity: s.parity,
        stopBits: s.stopBits,
        rtscts: s.flowControl === 'hardware',
        xon: software,
        xoff: software,
        dtr: s.dtr,
        rts: s.rts,
        lock: true, // exclusive access; a second open fails instead of corrupting the transfer
        autoOpen: false,
    };
}

function openPort(s) {
    return new Promise((resolve, reject) => {
        let port;
        try {
            port = new SerialPort(toOpenOptions(s));
        } catch (err) {
            return reject(err);
        }
        port.open((err) => (err ? reject(err) : resolve(port)));
    });
}

function closePort(port) {
    return new Promise((resolve) => {
        if (!port || !port.isOpen) return resolve();
        port.close(() => resolve());
    });
}

function createTransport(port) {
    return {
        write: (buffer) => new Promise((resolve, reject) => {
            port.write(buffer, (err) => (err ? reject(err) : resolve()));
        }),
        drain: () => new Promise((resolve, reject) => {
            port.drain((err) => (err ? reject(err) : resolve()));
        }),
        onData(callback) {
            port.on('data', callback);
            return { dispose: () => port.off('data', callback) };
        },
    };
}

/** Open the port, wait briefly so the line settles, and close it again. Resolves with a short report. */
async function testPort(s) {
    const port = await openPort(s);
    try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return `Opened ${s.port} at ${s.baudRate} baud, ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}, flow: ${s.flowControl}.`;
    } finally {
        await closePort(port);
    }
}

module.exports = { listPorts, openPort, closePort, createTransport, testPort, toOpenOptions };
