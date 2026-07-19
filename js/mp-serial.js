/*
 * mp-serial.js - talk to a MicroPython board's raw REPL over the Web Serial API.
 * Needs a Chromium browser (Chrome, Edge, Opera) over HTTPS or localhost.
 *
 * Derived from MicroPython (https://micropython.org), MIT licensed:
 *   tools/mpremote/mpremote/transport_serial.py - raw REPL and raw-paste protocol.
 * Copyright (c) 2014-2021 Damien P. George
 * Copyright (c) 2017 Paul Sokolovsky
 * Copyright (c) 2023 Jim Mussared
 *
 * See THIRD_PARTY_NOTICES.md for the full upstream license text.
 */

/** Boards commonly running MicroPython. Raspberry Pi's VID covers RP2040/RP2350. */
export const MICROPYTHON_USB_FILTERS = [
  { usbVendorId: 0x2e8a }, // Raspberry Pi (RP2040 / RP2350, Pimoroni boards)
  { usbVendorId: 0xf055 }, // MicroPython / pyboard
  { usbVendorId: 0x303a }, // Espressif
  { usbVendorId: 0x0483 }, // STMicroelectronics
];

export class SerialTimeoutError extends Error {
  constructor(message, partial) {
    super(message);
    this.name = "SerialTimeoutError";
    this.partial = partial;
  }
}

export class RawReplError extends Error {
  constructor(message) {
    super(message);
    this.name = "RawReplError";
  }
}

/** Raised when code executed on the device raises an exception. */
export class MicroPythonExecError extends Error {
  constructor(output, traceback) {
    super(traceback.trim().split("\n").pop() || "exception on device");
    this.name = "MicroPythonExecError";
    this.output = output;
    this.traceback = traceback;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const bin = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const RAW_REPL_BANNER = bin("raw REPL; CTRL-B to exit\r\n");
const SOFT_REBOOT = bin("soft reboot\r\n");

/** Index of `needle` in `haystack`, or -1. */
function indexOfSeq(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function isWebSerialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export class MicroPythonSerial {
  #port = null;
  #writer = null;
  #reader = null;
  #pumpDone = null;
  #pumpError = null;
  #buf = new Uint8Array(0);
  #waiters = new Set();
  #useRawPaste = true;
  #inRawRepl = false;

  /**
   * @param {{baudRate?: number, timeout?: number, onLog?: (msg: string) => void,
   *          dtr?: boolean, rts?: boolean, settleMs?: number}} options
   *   timeout is the inter-byte read timeout in milliseconds.
   *   dtr/rts are the modem control lines to assert once the port is open.
   */
  constructor({ baudRate = 115200, timeout = 10000, onLog = null, dtr = true, rts = false, settleMs = 100 } = {}) {
    this.baudRate = baudRate;
    this.timeout = timeout;
    this.onLog = onLog;
    this.dtr = dtr;
    this.rts = rts;
    this.settleMs = settleMs;
  }

  get isOpen() {
    return this.#port !== null;
  }

  get inRawRepl() {
    return this.#inRawRepl;
  }

  /** Bytes buffered and not yet consumed, the equivalent of pyserial's inWaiting(). */
  get available() {
    return this.#buf.length;
  }

  #log(message) {
    this.onLog?.(message);
  }

  /* ---------------------------------------------------------------- */
  /* Connection                                                        */
  /* ---------------------------------------------------------------- */

  /** Prompt the user to pick a port. Must be called from a user gesture. */
  static async requestPort({ filters = MICROPYTHON_USB_FILTERS } = {}) {
    if (!isWebSerialSupported()) {
      throw new RawReplError("Web Serial is not supported in this browser");
    }
    return navigator.serial.requestPort(filters.length ? { filters } : {});
  }

  async open(port) {
    if (this.#port) throw new RawReplError("already open");
    this.#port = port ?? (await MicroPythonSerial.requestPort());
    await this.#port.open({ baudRate: this.baudRate });

    // MicroPython's USB CDC stack only writes to stdout once the host asserts
    // DTR. Web Serial leaves it deasserted after open(), so without this the
    // board looks alive but never answers. pyserial, and so mpremote, asserts
    // it for us; here we have to ask.
    try {
      await this.#port.setSignals?.({ dataTerminalReady: this.dtr, requestToSend: this.rts });
    } catch (err) {
      this.#log(`Could not set DTR/RTS: ${err.message}`);
    }

    this.#buf = new Uint8Array(0);
    this.#pumpError = null;
    this.#useRawPaste = true;
    this.#writer = this.#port.writable.getWriter();
    this.#pumpDone = this.#pump();

    // Give the CDC endpoint a moment; bytes written immediately can be dropped.
    if (this.settleMs) await sleep(this.settleMs);
    this.#log(`Connected at ${this.baudRate} baud`);
  }

  async close() {
    if (!this.#port) return;
    try {
      if (this.#inRawRepl) await this.exitRawRepl();
    } catch {
      /* Closing anyway. */
    }
    try {
      await this.#reader?.cancel();
    } catch {
      /* Already gone. */
    }
    await this.#pumpDone?.catch(() => {});
    try {
      this.#writer?.releaseLock();
    } catch {
      /* Already released. */
    }
    try {
      await this.#port.close();
    } finally {
      this.#port = null;
      this.#writer = null;
      this.#reader = null;
      this.#inRawRepl = false;
      this.#log("Disconnected");
    }
  }

  /** Continuously drain the port into #buf and wake any readers. */
  async #pump() {
    this.#reader = this.#port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        if (value?.length) {
          const merged = new Uint8Array(this.#buf.length + value.length);
          merged.set(this.#buf);
          merged.set(value, this.#buf.length);
          this.#buf = merged;
          this.#wake();
        }
      }
    } catch (err) {
      this.#pumpError = err;
      this.#wake();
    } finally {
      try {
        this.#reader.releaseLock();
      } catch {
        /* Already released. */
      }
    }
  }

  #wake() {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve(true);
  }

  /** Resolves true when bytes arrive, false on timeout. */
  #waitForData(timeoutMs) {
    if (this.#pumpError) throw this.#pumpError;
    return new Promise((resolve) => {
      let timer = null;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      this.#waiters.add(waiter);
      if (timeoutMs != null && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          this.#waiters.delete(waiter);
          resolve(false);
        }, Math.max(0, timeoutMs));
      }
    });
  }

  #consume(n) {
    const out = this.#buf.slice(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }

  async write(data) {
    if (!this.#writer) throw new RawReplError("port is not open");
    await this.#writer.write(data instanceof Uint8Array ? data : textEncoder.encode(data));
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  async readExactly(n, { timeout = this.timeout } = {}) {
    let lastRx = now();
    while (this.#buf.length < n) {
      if (this.#pumpError) throw this.#pumpError;
      const remaining = timeout == null ? null : timeout - (now() - lastRx);
      if (remaining != null && remaining <= 0) {
        throw new SerialTimeoutError(`timed out reading ${n} bytes`, this.#consume(this.#buf.length));
      }
      if (await this.#waitForData(remaining)) lastRx = now();
    }
    return this.#consume(n);
  }

  /**
   * Read until `ending` is seen, returning everything including `ending`.
   * `onData` receives output as it arrives, minus the trailing `ending`.
   */
  async readUntil(ending, { timeout = this.timeout, overallTimeout = null, onData = null } = {}) {
    const chunks = [];
    let total = 0;
    // Retain enough trailing bytes that `ending` can be matched across chunks.
    const keep = ending.length - 1;
    const started = now();
    let lastRx = started;

    const joined = () => {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
    };

    for (;;) {
      const idx = indexOfSeq(this.#buf, ending);
      if (idx >= 0) {
        const got = this.#consume(idx + ending.length);
        if (onData && idx > 0) onData(got.subarray(0, idx));
        chunks.push(got);
        total += got.length;
        return joined();
      }

      if (this.#buf.length > keep) {
        const safe = this.#consume(this.#buf.length - keep);
        onData?.(safe);
        chunks.push(safe);
        total += safe.length;
      }

      if (this.#pumpError) throw this.#pumpError;

      const charLeft = timeout == null ? Infinity : timeout - (now() - lastRx);
      const overallLeft = overallTimeout == null ? Infinity : overallTimeout - (now() - started);
      if (charLeft <= 0 || overallLeft <= 0) {
        // Hand back whatever did arrive, including the unmatched tail; without
        // it a hardware failure is just an opaque timeout.
        chunks.push(this.#consume(this.#buf.length));
        total = chunks.reduce((n, c) => n + c.length, 0);
        throw new SerialTimeoutError(
          `timed out waiting for ${JSON.stringify(textDecoder.decode(ending))}`,
          joined(),
        );
      }
      if (await this.#waitForData(Math.min(charLeft, overallLeft))) lastRx = now();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Raw REPL                                                          */
  /* ---------------------------------------------------------------- */

  /** Consume incoming bytes until the device stops talking, or `maxMs` elapses. */
  async #drainUntilQuiet(idleMs, maxMs) {
    const deadline = now() + maxMs;
    for (;;) {
      this.#consume(this.#buf.length);
      const remaining = deadline - now();
      if (remaining <= 0) return;
      if (!(await this.#waitForData(Math.min(idleMs, remaining)))) return; // Gone quiet.
    }
  }

  /**
   * Ctrl-C until the board stops running whatever it booted into. Badge firmware
   * usually has a main loop, and it needs a moment to unwind: sending Ctrl-A into
   * a program that is still printing achieves nothing, and its output would be
   * mistaken for a reply.
   */
  async interrupt({ times = 2, idleMs = 80, maxMs = 1500 } = {}) {
    for (let i = 0; i < times; i++) {
      await this.write(bin("\r\x03"));
      await this.#drainUntilQuiet(idleMs, maxMs);
    }
  }

  async #enterRawReplOnce({ softReset, timeout }) {
    await this.interrupt();
    await this.write(bin("\r\x01")); // Ctrl-A: raw REPL.

    if (softReset) {
      // Ctrl-A must come first: a board only re-runs main.py after a soft reset
      // when it is in the friendly REPL, so resetting from the raw REPL gives a
      // clean VM without restarting the firmware we just interrupted.
      await this.readUntil(concatBytes(RAW_REPL_BANNER, bin(">")), { overallTimeout: timeout });
      await this.write(bin("\x04")); // Ctrl-D: soft reset.
      // Wait for the reboot separately so boot.py output is not mistaken for the banner.
      await this.readUntil(SOFT_REBOOT, { overallTimeout: timeout });
    }

    await this.readUntil(RAW_REPL_BANNER, { overallTimeout: timeout });
  }

  async enterRawRepl({ softReset = true, timeout = 5000, attempts = 3 } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.#enterRawReplOnce({ softReset, timeout });
        this.#inRawRepl = true;
        this.#log("Entered raw REPL");
        return;
      } catch (err) {
        if (!(err instanceof SerialTimeoutError)) throw err;
        last = err;
        if (attempt < attempts) this.#log(`No response, interrupting and retrying (${attempt}/${attempts})...`);
      }
    }

    const heard = textDecoder.decode(last?.partial ?? new Uint8Array(0)).trim();
    throw new RawReplError(
      `Could not enter the raw REPL after ${attempts} attempts. The board may be running a ` +
        "program that ignores Ctrl-C, such as one that called micropython.kbd_intr(-1). " +
        (heard ? `Last thing it said: ${JSON.stringify(heard.slice(-120))}` : "It sent nothing at all."),
    );
  }

  async exitRawRepl() {
    await this.write(bin("\r\x02")); // Ctrl-B: friendly REPL.
    this.#inRawRepl = false;
  }

  /**
   * Hard reset the board with machine.reset().
   *
   * It never replies: the reset happens as soon as the command runs, and the USB
   * device drops off the bus mid-conversation. We send the command without
   * following its output, and treat a dead port as success rather than an error.
   */
  async reset() {
    try {
      await this.execRawNoFollow("import machine\nmachine.reset()");
    } catch (err) {
      // A board that resets before acknowledging is doing exactly what we asked.
      this.#log(`Board went away during reset (${err.message}), which is expected.`);
    }
    this.#inRawRepl = false;
  }

  /** Read the device's normal and error output, both terminated by 0x04. */
  async follow({ timeout = this.timeout, onData = null } = {}) {
    const eof = bin("\x04");
    const out = await this.readUntil(eof, { timeout, onData });
    const err = await this.readUntil(eof, { timeout });
    return { output: out.subarray(0, out.length - 1), error: err.subarray(0, err.length - 1) };
  }

  /** Send a command using raw-paste mode, which has flow control. */
  async #rawPasteWrite(commandBytes) {
    const header = await this.readExactly(2);
    const windowSize = header[0] | (header[1] << 8);
    let windowRemain = windowSize;

    let i = 0;
    while (i < commandBytes.length) {
      while (windowRemain === 0 || this.available > 0) {
        const [b] = await this.readExactly(1);
        if (b === 0x01) {
          windowRemain += windowSize; // Device can take another window.
        } else if (b === 0x04) {
          await this.write(bin("\x04")); // Device gave up; acknowledge.
          return;
        } else {
          throw new RawReplError(`unexpected byte during raw paste: 0x${b.toString(16)}`);
        }
      }
      const chunk = commandBytes.subarray(i, Math.min(i + windowRemain, commandBytes.length));
      await this.write(chunk);
      windowRemain -= chunk.length;
      i += chunk.length;
    }

    await this.write(bin("\x04")); // End of data.
    await this.readUntil(bin("\x04"));
  }

  async execRawNoFollow(command) {
    const commandBytes = typeof command === "string" ? textEncoder.encode(command) : command;

    await this.readUntil(bin(">")); // Wait for the raw REPL prompt.

    if (this.#useRawPaste) {
      await this.write(bin("\x05A\x01"));
      const response = await this.readExactly(2);
      if (response[0] === 0x52 && response[1] === 0x01) {
        return this.#rawPasteWrite(commandBytes); // Supported.
      }
      if (!(response[0] === 0x52 && response[1] === 0x00)) {
        // Not understood at all; the device echoed us back into the raw REPL.
        await this.readUntil(bin("w REPL; CTRL-B to exit\r\n>"));
      }
      this.#useRawPaste = false;
    }

    // Fall back to plain raw REPL: 256 bytes every 10ms.
    for (let i = 0; i < commandBytes.length; i += 256) {
      await this.write(commandBytes.subarray(i, Math.min(i + 256, commandBytes.length)));
      await sleep(10);
    }
    await this.write(bin("\x04"));

    const ok = await this.readExactly(2);
    if (textDecoder.decode(ok) !== "OK") {
      throw new RawReplError(`could not exec command (response: ${JSON.stringify(textDecoder.decode(ok))})`);
    }
  }

  async execRaw(command, { timeout = this.timeout, onData = null } = {}) {
    await this.execRawNoFollow(command);
    return this.follow({ timeout, onData });
  }

  /** Run code, returning stdout. Throws MicroPythonExecError on a device traceback. */
  async exec(command, { timeout = this.timeout, onData = null } = {}) {
    const { output, error } = await this.execRaw(command, { timeout, onData });
    if (error.length) {
      throw new MicroPythonExecError(textDecoder.decode(output), textDecoder.decode(error));
    }
    return output;
  }

  /** Evaluate an expression and return its printed form as a trimmed string. */
  async evalStr(expression, { timeout = this.timeout } = {}) {
    const out = await this.exec(`print(${expression})`, { timeout });
    return textDecoder.decode(out).trim();
  }

  async evalInt(expression, options) {
    const text = await this.evalStr(expression, options);
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value)) throw new RawReplError(`expected an int, got ${JSON.stringify(text)}`);
    return value;
  }

  async evalBool(expression, options) {
    const text = await this.evalStr(expression, options);
    if (text === "True") return true;
    if (text === "False") return false;
    throw new RawReplError(`expected a bool, got ${JSON.stringify(text)}`);
  }

  /** True if `code` runs without raising, used to probe for optional modules. */
  async tryExec(code, options) {
    try {
      await this.exec(code, options);
      return true;
    } catch (err) {
      if (err instanceof MicroPythonExecError) return false;
      throw err;
    }
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
