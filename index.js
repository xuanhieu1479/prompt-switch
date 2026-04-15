import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { oai_settings } from "../../../openai.js";

const extensionName = "prompt-switch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    name: "Switch",
    state: false,        // false = OFF, true = ON
    onSnap: null,        // { [identifier]: enabledBool } or null
    offSnap: null,
};

function settings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][k] === undefined) {
            extension_settings[extensionName][k] = structuredClone(v);
        }
    }
    return extension_settings[extensionName];
}

// ----- prompt-order access -----

// Returns the `order` array for the currently active character, or null if none.
// ST stores order per-character-id in oai_settings.prompt_order, which can be
// either an array of {character_id, order} or a map keyed by character_id
// depending on version — handle both.
function getCurrentOrder() {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;

    const po = oai_settings?.prompt_order;
    if (!po) return null;

    if (Array.isArray(po)) {
        const entry = po.find(e => String(e.character_id) === String(charId));
        return entry?.order || null;
    }
    if (typeof po === "object") {
        const entry = po[charId] || po[String(charId)];
        return entry?.order || null;
    }
    return null;
}

function captureCurrentSnapshot() {
    const order = getCurrentOrder();
    if (!order) return null;
    const snap = {};
    for (const item of order) {
        if (item && item.identifier !== undefined) {
            snap[item.identifier] = !!item.enabled;
        }
    }
    return snap;
}

function applySnapshot(snap) {
    if (!snap) return 0;
    const order = getCurrentOrder();
    if (!order) return 0;
    let changed = 0;
    for (const item of order) {
        if (!item || item.identifier === undefined) continue;
        if (Object.prototype.hasOwnProperty.call(snap, item.identifier)) {
            const target = !!snap[item.identifier];
            if (item.enabled !== target) {
                item.enabled = target;
                changed++;
            }
        }
    }
    return changed;
}

// Try to force the prompt manager UI to re-render after we mutate state.
function refreshPromptManagerUI() {
    try {
        if (typeof window !== "undefined" && window.promptManager?.render) {
            window.promptManager.render();
            return;
        }
    } catch (_) {}
    try { eventSource.emit(event_types.SETTINGS_UPDATED); } catch (_) {}
}

// ----- state operations -----

function captureOn() {
    const snap = captureCurrentSnapshot();
    if (!snap) {
        toastr.warning("No active character / prompt order — can't capture.");
        return;
    }
    settings().onSnap = snap;
    saveSettingsDebounced();
    updateUI();
    toastr.success(`ON snapshot captured (${Object.keys(snap).length} prompts).`);
}

function captureOff() {
    const snap = captureCurrentSnapshot();
    if (!snap) {
        toastr.warning("No active character / prompt order — can't capture.");
        return;
    }
    settings().offSnap = snap;
    saveSettingsDebounced();
    updateUI();
    toastr.success(`OFF snapshot captured (${Object.keys(snap).length} prompts).`);
}

function clearOn()  { settings().onSnap = null;  saveSettingsDebounced(); updateUI(); }
function clearOff() { settings().offSnap = null; saveSettingsDebounced(); updateUI(); }

// Build the "apply when flipping to X" snapshot — only identifiers that
// differ between ON and OFF are touched, so other prompts are left alone.
function effectiveSnap(targetIsOn) {
    const s = settings();
    const on = s.onSnap || {};
    const off = s.offSnap || {};
    const ids = new Set([...Object.keys(on), ...Object.keys(off)]);
    const out = {};
    for (const id of ids) {
        const oVal = on[id];
        const fVal = off[id];
        if (oVal === fVal) continue; // no difference → don't touch
        out[id] = targetIsOn ? oVal : fVal;
    }
    return out;
}

function flip() {
    const s = settings();
    if (!s.onSnap || !s.offSnap) {
        toastr.warning("Capture both ON and OFF snapshots first.");
        return;
    }
    s.state = !s.state;
    const changed = applySnapshot(effectiveSnap(s.state));
    saveSettingsDebounced();
    refreshPromptManagerUI();
    updateUI();
    toastr.info(`Switch ${s.state ? "ON" : "OFF"} · ${changed} prompt(s) changed.`);
}

// ----- UI -----

function updateUI() {
    const s = settings();
    $("#pswitch_name").val(s.name);
    $("#pswitch_state_label").text(s.state ? "ON" : "OFF");
    $("#pswitch_on_status").text(s.onSnap ? `captured (${Object.keys(s.onSnap).length} prompts)` : "not captured");
    $("#pswitch_off_status").text(s.offSnap ? `captured (${Object.keys(s.offSnap).length} prompts)` : "not captured");
    updatePill();
}

function updatePill() {
    const s = settings();
    const $pill = $("#pswitch_floating");
    if (!$pill.length) return;
    $pill.toggleClass("on", !!s.state);
    const ready = !!(s.onSnap && s.offSnap);
    $pill.toggleClass("disabled", !ready);
    $pill.find(".pswitch-label").text(s.name || "Switch");
}

function positionFloating() {
    const $pill = $("#pswitch_floating");
    if (!$pill.length) return;
    const sheld = document.getElementById("sheld");
    if (sheld) {
        const rect = sheld.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            $pill.css({
                left: (rect.left + 8) + "px",
                top: (rect.top + rect.height * 0.9) + "px",
            });
            return;
        }
    }
    // Fallback: bottom-left of viewport.
    $pill.css({ left: "8px", top: "90%" });
}

// ----- init -----

jQuery(async () => {
    const html = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(html);

    // Floating pill — lives on body so it isn't clipped by any parent overflow.
    const $pill = $(`
        <div id="pswitch_floating" title="Click to flip switch">
            <span class="pswitch-dot"></span>
            <span class="pswitch-label">Switch</span>
        </div>
    `);
    $pill.on("click", flip);
    $("body").append($pill);

    // Init values from saved settings.
    updateUI();
    positionFloating();

    // Wire inputs.
    $("#pswitch_name").on("input", () => {
        settings().name = $("#pswitch_name").val() || "Switch";
        saveSettingsDebounced();
        updatePill();
    });
    $("#pswitch_capture_on").on("click", captureOn);
    $("#pswitch_capture_off").on("click", captureOff);
    $("#pswitch_clear_on").on("click", clearOn);
    $("#pswitch_clear_off").on("click", clearOff);

    window.addEventListener("resize", positionFloating);
    setInterval(positionFloating, 1000);
});
