/*
 * install.js - install .ppf fonts onto a MicroPython badge from the explore page.
 *
 * Fonts live in the badge's ROMFS partition. Installing one reads the partition's
 * current image, merges the font file into it (so firmware files survive), and
 * writes the repacked image back. The badge is restarted on disconnect so it
 * remounts /rom and sees the new files.
 *
 * The ROMFS format, the repack and the serial transport all come from
 * js/romfs.js, js/romfs-deploy.js and js/mp-serial.js.
 */

import { MICROPYTHON_USB_FILTERS, MicroPythonSerial, isWebSerialSupported } from "./mp-serial.js";
import { deployRomfs, queryRomfs, readRomfsImage, verifyRomfs } from "./romfs-deploy.js";
import { mergeRomfs, unpackRomfs } from "./romfs.js";

/** ROMFS partition to install into, where it mounts, and the fonts subdir. */
const PARTITION = 0;
const ROM_MOUNT = "/rom";
const FONT_DIR = "fonts";

/** Plain-language line per deploy phase, so the status is never blank. */
const PHASE_HINTS = {
  connecting: "Talking to the badge...",
  reading: "Reading what is on the badge...",
  erasing: "Making room...",
  writing: "Writing the font...",
  done: "Written.",
};

/**
 * Wire up the connect button and font install buttons.
 *
 * @param {{connectButton: HTMLElement, statusEl: HTMLElement}} deps
 * @returns {{refreshButtons: () => void}} refreshButtons re-syncs every
 *   `.install-btn` with the connection state; call it after re-rendering groups.
 */
export function initInstall({ connectButton, statusEl }) {
  /** @type {MicroPythonSerial|null} */
  let mp = null;
  let busy = false;

  function status(message, kind = "") {
    statusEl.textContent = message ?? "";
    statusEl.className = `istatus ${kind}`;
  }

  function connected() {
    return mp !== null && mp.isOpen;
  }

  function refreshButtons() {
    const ready = connected() && !busy;
    for (const btn of document.querySelectorAll(".install-btn")) {
      btn.disabled = !ready;
    }
    connectButton.disabled = busy;
    connectButton.textContent = connected() ? "Restart badge & disconnect" : "Connect badge";
  }

  function setBusy(value) {
    busy = value;
    refreshButtons();
  }

  function onProgress({ phase }) {
    if (PHASE_HINTS[phase]) status(PHASE_HINTS[phase]);
  }

  /* -------------------------------------------------------------- */
  /* Connection                                                     */
  /* -------------------------------------------------------------- */

  async function connect() {
    let port;
    try {
      port = await MicroPythonSerial.requestPort({ filters: MICROPYTHON_USB_FILTERS });
    } catch {
      return; // The user dismissed the picker.
    }

    mp = new MicroPythonSerial();
    setBusy(true);
    status("Connecting...");
    try {
      await mp.open(port);
      await mp.enterRawRepl();
      const parts = await queryRomfs(mp);
      const p = parts[PARTITION];
      if (!p) throw new Error(`the badge has no ROMFS partition ${PARTITION}`);
      status(`Connected. ROMFS${PARTITION} holds ${p.size} bytes. Pick a font to install.`, "ok");
    } catch (err) {
      status(err.message, "bad");
      try {
        await mp.close();
      } catch {
        /* Nothing useful to do. */
      }
      mp = null;
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    status("Restarting the badge...");
    try {
      await mp.reset(); // Remounts /rom so the new fonts are visible.
    } catch {
      /* The board may already be gone. */
    }
    try {
      await mp.close();
    } catch {
      /* Already closing. */
    }
    mp = null;
    setBusy(false);
    status("Disconnected. The badge is restarting.", "ok");
  }

  connectButton.addEventListener("click", () => {
    if (busy) return;
    (connected() ? disconnect() : connect()).catch((err) => {
      status(err.message, "bad");
      setBusy(false);
    });
  });

  /* -------------------------------------------------------------- */
  /* Install                                                        */
  /* -------------------------------------------------------------- */

  /**
   * Read the partition's current image, merge `file` into it, and write it back.
   * If the partition holds no readable image, a fresh one is written.
   */
  async function installFont(file, title) {
    status(`Fetching ${file}...`);
    const res = await fetch(`dist/${file}`);
    if (!res.ok) throw new Error(`could not fetch dist/${file} (${res.status})`);
    const font = new Uint8Array(await res.arrayBuffer());

    let base = null;
    try {
      base = await readRomfsImage(mp, { partition: PARTITION, onProgress });
      unpackRomfs(base); // Confirm it parses before merging into it.
    } catch {
      base = null; // Unreadable or not a ROMFS: write a fresh image.
    }

    const path = `${FONT_DIR}/${file}`;
    const image = mergeRomfs(base, [{ path, data: font }]);
    await deployRomfs(mp, image, { partition: PARTITION, onProgress });

    const result = await verifyRomfs(mp, image, { partition: PARTITION, onProgress });
    if (!result.ok) throw new Error(`verification failed: ${result.reason}`);

    status(`Installed ${title} at ${ROM_MOUNT}/${path}. Disconnect to restart the badge.`, "ok");
  }

  // Delegated: install buttons are created and destroyed on every re-render.
  document.addEventListener("click", (event) => {
    const btn = event.target.closest?.(".install-btn");
    if (!btn || btn.disabled || !connected() || busy) return;
    setBusy(true);
    installFont(btn.dataset.file, btn.dataset.title || btn.dataset.file)
      .catch((err) => status(err.message, "bad"))
      .finally(() => setBusy(false));
  });

  /* -------------------------------------------------------------- */
  /* Setup                                                          */
  /* -------------------------------------------------------------- */

  if (!isWebSerialSupported()) {
    connectButton.disabled = true;
    status(
      "Web Serial is not available in this browser, so installing is disabled. " +
        "Use Chrome, Edge or Opera, or deploy a font with: mpremote romfs deploy <font>.ppf",
      "bad",
    );
  } else {
    status("Plug the badge in over USB and connect to install fonts straight onto it.");
  }

  return { refreshButtons };
}
