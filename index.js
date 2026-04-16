import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { oai_settings } from "../../../openai.js";

const extensionName = "prompt-switch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const COLORS = [
    { id: "red",    hex: "#ff4444", dim: "#883333" },
    { id: "blue",   hex: "#4488ff", dim: "#335577" },
    { id: "green",  hex: "#44dd66", dim: "#336644" },
    { id: "yellow", hex: "#ffcc44", dim: "#887733" },
    { id: "purple", hex: "#cc55ff", dim: "#663388" },
];

const defaultSwitch = { state: false, onSnap: null, offSnap: null };

const defaultSettings = {
    switches: COLORS.reduce((acc, c) => (acc[c.id] = structuredClone(defaultSwitch), acc), {}),
};

function settings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    s.switches = s.switches || {};
    for (const c of COLORS) {
        if (!s.switches[c.id]) s.switches[c.id] = structuredClone(defaultSwitch);
    }
    return s;
}

function sw(colorId) { return settings().switches[colorId]; }

// ----- prompt-order access -----

function getCurrentOrder() {
    const po = oai_settings?.prompt_order;
    if (!po) { console.warn("[prompt-switch] oai_settings.prompt_order missing"); return null; }

    let entries;
    if (Array.isArray(po)) {
        entries = po;
    } else if (typeof po === "object") {
        entries = Object.entries(po).map(([k, v]) => ({ character_id: k, order: v?.order || v }));
    } else {
        return null;
    }
    if (!entries.length) return null;

    const def = entries.find(e => String(e.character_id) === "100001");
    if (Array.isArray(def?.order) && def.order.length) return def.order;

    const any = entries.find(e => Array.isArray(e?.order) && e.order.length);
    return any?.order || null;
}

function captureCurrentSnapshot() {
    const order = getCurrentOrder();
    if (!order) return null;
    const snap = {};
    for (const item of order) {
        if (item && item.identifier !== undefined) snap[item.identifier] = !!item.enabled;
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
            if (item.enabled !== target) { item.enabled = target; changed++; }
        }
    }
    return changed;
}

async function refreshPromptManagerUI(snap) {
    try {
        if (typeof window !== "undefined" && window.promptManager?.render) {
            window.promptManager.render();
            return;
        }
    } catch (_) {}
    try {
        const mod = await import("../../../openai.js");
        if (mod.promptManager?.render) { mod.promptManager.render(); return; }
        if (typeof mod.renderPromptManager === "function") { mod.renderPromptManager(); return; }
    } catch (_) {}
    if (snap) syncPromptManagerDom(snap);
    try { eventSource.emit(event_types.SETTINGS_UPDATED); } catch (_) {}
}

function syncPromptManagerDom(snap) {
    for (const [id, target] of Object.entries(snap)) {
        const $row = $(`#completion_prompt_manager_list [data-pm-identifier="${id}"]`).first();
        if (!$row.length) continue;
        const currentlyOn = $row.find(".fa-toggle-on").length > 0
            || $row.hasClass("completion_prompt_manager_prompt_enabled");
        if (currentlyOn === !!target) continue;
        const $toggle = $row.find(".prompt-manager-toggle-action, .prompt_manager_toggle, .fa-toggle-on, .fa-toggle-off").first();
        if ($toggle.length) $toggle.trigger("click");
    }
}

// ----- state ops -----

function captureOn(colorId) {
    const snap = captureCurrentSnapshot();
    if (!snap) { toastr.warning("No prompt order found — can't capture."); return; }
    sw(colorId).onSnap = snap;
    saveSettingsDebounced();
    updateUI();
    toastr.success(`[${colorId}] ON snapshot captured (${Object.keys(snap).length} prompts).`);
}

function captureOff(colorId) {
    const snap = captureCurrentSnapshot();
    if (!snap) { toastr.warning("No prompt order found — can't capture."); return; }
    sw(colorId).offSnap = snap;
    saveSettingsDebounced();
    updateUI();
    toastr.success(`[${colorId}] OFF snapshot captured (${Object.keys(snap).length} prompts).`);
}

function clearSwitch(colorId) {
    const s = sw(colorId);
    s.onSnap = null;
    s.offSnap = null;
    s.state = false;
    saveSettingsDebounced();
    updateUI();
}

function effectiveSnap(colorId, targetIsOn) {
    const s = sw(colorId);
    const on = s.onSnap || {};
    const off = s.offSnap || {};
    const ids = new Set([...Object.keys(on), ...Object.keys(off)]);
    const out = {};
    for (const id of ids) {
        if (on[id] === off[id]) continue;
        out[id] = targetIsOn ? on[id] : off[id];
    }
    return out;
}

async function flip(colorId) {
    const s = sw(colorId);
    if (!s.onSnap || !s.offSnap) return; // disabled — silent no-op
    s.state = !s.state;
    const snap = effectiveSnap(colorId, s.state);
    applySnapshot(snap);
    saveSettingsDebounced();
    await refreshPromptManagerUI(snap);
    updateUI();
    // Refocus chat input so user can keep typing immediately.
    $("#send_textarea").focus();
}

// ----- UI -----

function renderSettingsRows() {
    const $host = $("#pswitch_rows");
    $host.empty();
    for (const c of COLORS) {
        const $row = $(`
            <div class="pswitch-row" data-color="${c.id}" style="--pswitch-color:${c.hex}; --pswitch-dim:${c.dim};">
                <span class="pswitch-color-dot" style="background:${c.hex};"></span>
                <span class="pswitch-row-label">${c.id}</span>
                <span class="pswitch-state-badge">OFF</span>
                <input class="menu_button" type="button" data-action="capOn"  value="Cap ON" />
                <input class="menu_button" type="button" data-action="capOff" value="Cap OFF" />
                <input class="menu_button" type="button" data-action="clear"  value="Clear" />
                <small class="pswitch-status-text"></small>
            </div>
        `);
        $host.append($row);
    }
    $host.off("click").on("click", ".menu_button", function () {
        const $row = $(this).closest(".pswitch-row");
        const color = $row.data("color");
        const action = $(this).data("action");
        if (action === "capOn")  captureOn(color);
        else if (action === "capOff") captureOff(color);
        else if (action === "clear")  clearSwitch(color);
    });
}

function updateUI() {
    const s = settings();
    for (const c of COLORS) {
        const st = s.switches[c.id];
        const $row = $(`.pswitch-row[data-color="${c.id}"]`);
        const ready = !!(st.onSnap && st.offSnap);
        $row.find(".pswitch-state-badge").text(st.state ? "ON" : "OFF").toggleClass("on", !!st.state);
        const onN  = st.onSnap  ? Object.keys(st.onSnap).length  : 0;
        const offN = st.offSnap ? Object.keys(st.offSnap).length : 0;
        $row.find(".pswitch-status-text").text(
            `ON: ${st.onSnap ? `captured (${onN})` : "—"}  ·  OFF: ${st.offSnap ? `captured (${offN})` : "—"}`
        );
        const $icon = $(`#pswitch_floating_${c.id}`);
        $icon.toggleClass("on", !!st.state).toggleClass("disabled", !ready);
    }
}

function positionFloating() {
    const sheld = document.getElementById("sheld");
    let baseLeft, baseTop;
    if (sheld) {
        const rect = sheld.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            baseLeft = rect.left + 8;
            baseTop = rect.top + rect.height * 0.9;
        }
    }
    if (baseLeft === undefined) {
        baseLeft = 8;
        baseTop = window.innerHeight * 0.9;
    }
    const GAP = 32;
    COLORS.forEach((c, i) => {
        $(`#pswitch_floating_${c.id}`).css({
            left: baseLeft + "px",
            top: (baseTop - i * GAP) + "px",
        });
    });
}

// ----- init -----

jQuery(async () => {
    const html = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(html);

    renderSettingsRows();

    // Floating icons — one per color, stacked vertically at bottom-left of #sheld.
    for (const c of COLORS) {
        const $icon = $(`<div id="pswitch_floating_${c.id}" class="pswitch-floating fa-solid fa-power-off" title="${c.id} switch"></div>`);
        $icon.css("--pswitch-color", c.hex);
        $icon.css("--pswitch-dim", c.dim);
        $icon.on("click", () => flip(c.id));
        $("body").append($icon);
    }

    updateUI();
    positionFloating();

    window.addEventListener("resize", positionFloating);
    setInterval(positionFloating, 1000);
});
