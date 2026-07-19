/*
 * install.js - install .af fonts onto a MicroPython badge from the explore page.
 *
 * Fonts live in the badge's ROMFS partition. Installing one reads the partition's
 * current image, merges the font file into it (so firmware files survive), and
 * writes the repacked image back. The badge is restarted on disconnect so it
 * remounts /rom and sees the new files.
 *
 * There is no separate connect step: clicking a font's Install button connects
 * first if needed. A small indicator shows the connection and is clicked to
 * connect on its own or to disconnect (which restarts the badge). Progress and
 * errors surface as a transient bubble out of that indicator, re-shown on hover.
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

/** How long a status bubble lingers before fading, unless hovered. */
const BUBBLE_MS = 4500;

/**
 * Wire up the connection indicator and font install buttons.
 *
 * @param {{indicator: HTMLElement}} deps
 * @returns {{refreshButtons: () => void}} refreshButtons re-syncs every
 *   `.install-btn` with the busy state; call it after re-rendering groups.
 */
export function initInstall({ indicator }) {
  const supported = isWebSerialSupported();
  /** @type {MicroPythonSerial|null} */
  let mp = null;
  let busy = false;

  function connected() {
    return mp !== null && mp.isOpen;
  }

  // A bubble that pops out of the indicator with the latest status message.
  const bubble = document.createElement("div");
  bubble.className = "badge-msg";
  document.body.appendChild(bubble);
  let lastMsg = "";
  let lastKind = "";
  let hovering = false;
  let hideTimer = null;

  function showBubble(message, kind, sticky) {
    bubble.textContent = message;
    bubble.className = `badge-msg show ${kind}`;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (!sticky) {
      hideTimer = setTimeout(() => {
        if (!hovering) bubble.classList.remove("show");
      }, BUBBLE_MS);
    }
  }

  /** Record the latest message and pop it out of the indicator. */
  function status(message, kind = "") {
    lastMsg = message ?? "";
    lastKind = kind;
    if (lastMsg) showBubble(lastMsg, kind, false);
    else bubble.classList.remove("show");
  }

  function idleHint() {
    return connected()
      ? "Connected. Click to restart the badge and disconnect."
      : "Click to connect a badge over USB.";
  }

  /** Reflect the connection in the top-right indicator. */
  function paintIndicator() {
    if (!supported) {
      indicator.textContent = "Badge n/a";
      indicator.className = "badge-ind off";
    } else if (busy) {
      indicator.textContent = "◐ Badge";
      indicator.className = "badge-ind busy";
    } else if (connected()) {
      indicator.textContent = "● Badge";
      indicator.className = "badge-ind on";
    } else {
      indicator.textContent = "○ Badge";
      indicator.className = "badge-ind";
    }
  }

  // Re-show the latest message (or a hint) while the pointer rests on the badge.
  indicator.addEventListener("mouseenter", () => {
    hovering = true;
    showBubble(lastMsg || idleHint(), lastMsg ? lastKind : "", true);
  });
  indicator.addEventListener("mouseleave", () => {
    hovering = false;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove("show"), 600);
  });

  function refreshButtons() {
    for (const btn of document.querySelectorAll(".install-btn")) {
      btn.disabled = busy || !supported;
    }
    paintIndicator();
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

  /**
   * Open a badge and enter the raw REPL. Returns true on success. Must be called
   * from a user gesture so the serial port picker is allowed to open.
   */
  async function connect() {
    let port;
    try {
      port = await MicroPythonSerial.requestPort({ filters: MICROPYTHON_USB_FILTERS });
    } catch {
      return false; // The user dismissed the picker.
    }

    mp = new MicroPythonSerial();
    setBusy(true);
    status("Connecting...");
    try {
      await mp.open(port);
      await mp.enterRawRepl();
      const parts = await queryRomfs(mp);
      if (!parts[PARTITION]) throw new Error(`the badge has no ROMFS partition ${PARTITION}`);
      status(`Connected. ROMFS${PARTITION} holds ${parts[PARTITION].size} bytes.`, "ok");
      return true;
    } catch (err) {
      status(err.message, "bad");
      try {
        await mp.close();
      } catch {
        /* Nothing useful to do. */
      }
      mp = null;
      return false;
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

  indicator.addEventListener("click", () => {
    if (busy || !supported) return;
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

    const path = `${FONT_DIR}/${file.split("/").pop()}`;
    const image = mergeRomfs(base, [{ path, data: font }]);
    await deployRomfs(mp, image, { partition: PARTITION, onProgress });

    const result = await verifyRomfs(mp, image, { partition: PARTITION, onProgress });
    if (!result.ok) throw new Error(`verification failed: ${result.reason}`);

    status(`Installed ${title} at ${ROM_MOUNT}/${path}. Disconnect to restart the badge.`, "ok");
  }

  // Delegated: install buttons are created and destroyed on every re-render.
  // Connect on demand so the whole flow is one click from a font tile.
  document.addEventListener("click", (event) => {
    const btn = event.target.closest?.(".install-btn");
    if (!btn || btn.disabled || busy || !supported) return;
    const { file, title = file } = btn.dataset;
    setBusy(true);
    (async () => {
      if (!connected() && !(await connect())) return;
      setBusy(true);
      await installFont(file, title);
    })()
      .catch((err) => status(err.message, "bad"))
      .finally(() => setBusy(false));
  });

  /* -------------------------------------------------------------- */
  /* Setup                                                          */
  /* -------------------------------------------------------------- */

  if (!supported) {
    status(
      "Web Serial is not available in this browser, so installing is disabled. Use Chrome, Edge or Opera.",
      "bad",
    );
  }
  refreshButtons();

  return { refreshButtons };
}
