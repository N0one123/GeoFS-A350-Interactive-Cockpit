// ==UserScript==
// @name         GeoFS A350 v4.0 Systems Enhancement
// @namespace    geofs-a350-v4
// @version      4.0.0-alpha.3
// @description  Interconnected A350 cockpit interaction and systems layer for GeoFS.
// @match        https://www.geo-fs.com/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    /*
     * GeoFS A350 v4.0
     *
     * Core rule: systems are state-driven and interconnected. There is no
     * fake "press A, wait 5 seconds, do B" startup script. APU, electrical,
     * fuel, pneumatic, hydraulic and engine states continuously affect one
     * another. GeoFS remains the underlying flight model.
     *
     * Input rule:
     *   Shift+\\ = persistent master camera-lock toggle.
     *   The master toggle receives priority for 5 seconds after being pressed.
     *   Controls automatically suppress camera input while hovered/dragged.
     *   Knobs use horizontal click-drag.
     *
     * F8 = panel, F9 = hotspot debug, F10 = list aircraft parts.
     */

    const CFG = Object.freeze({
        VERSION: '4.0.0-alpha.3',
        POLL: 500,
        STEP: 0.05,
        MASTER_PRIORITY: 5000,
        KNOB_PX: 6,
        MAP_KEY: 'geofs-a350-v4-hotspots'
    });

    const state = {
        electrical: {
            bat1: false, bat2: false,
            bat1V: 0, bat2V: 0,
            acEssential: false, dcEssential: false,
            extPowerAvailable: false, extPowerOn: false,
            apuGenAvailable: false, apuGenOn: false,
            gen1Available: false, gen2Available: false,
            gen1On: false, gen2On: false
        },
        fuel: {
            left: 100, center: 100, right: 100,
            left1: false, left2: false, center1: false,
            center2: false, right1: false, right2: false,
            crossfeed: false, pressure: 0
        },
        apu: {
            master: false, start: false, rpm: 0,
            running: false, genAvailable: false,
            bleedAvailable: false, fault: false
        },
        pneumatic: {
            apuBleed: false, eng1Bleed: false, eng2Bleed: false,
            pack1: false, pack2: false, pressure: 0
        },
        hydraulic: {
            green: 0, yellow: 0, blue: 0,
            electricPump: false
        },
        engines: {
            1: { master: false, start: false, n2: 0, n3: 0, running: false, gen: false },
            2: { master: false, start: false, n2: 0, n3: 0, running: false, gen: false }
        },
        flight: {
            gear: false, parkingBrake: true,
            selectedAltitude: 10000, selectedHeading: 0,
            selectedSpeed: 250, selectedVS: 0, baro: 1013
        },
        displays: {
            powered: false, ewd: 'CONFIGURATION', sd: 'ENG'
        },
        warnings: []
    };

    const input = {
        hover: null,
        active: null,
        lastX: 0,
        masterLock: false,
        priorityUntil: 0,
        priorityLock: false,
        autoLock: false
    };

    let geofsAircraft = null;
    let overlay = null;
    let panel = null;
    let status = null;
    let debug = false;

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function approach(v, target, rate, dt) {
        return v + (target - v) * (1 - Math.exp(-rate * dt));
    }
    function warn(text) {
        if (!state.warnings.includes(text)) state.warnings.push(text);
    }
    function unwarn(text) {
        const i = state.warnings.indexOf(text);
        if (i >= 0) state.warnings.splice(i, 1);
    }

    function ac() { return window.geofs?.aircraft?.instance || null; }
    function controls() { return window.controls || null; }
    function isA350(a) {
        if (!a) return false;
        const text = [a.setup?.name, a.setup?.aircraftName, a.aircraftRecord?.name,
            a.aircraftRecord?.displayName, a.name, a.id].filter(Boolean).join(' ');
        return /a350/i.test(text);
    }

    /* -------------------- interconnected systems -------------------- */

    function updateFuel(dt) {
        const f = state.fuel;
        const pumps = f.left1 || f.left2 || f.center1 || f.center2 || f.right1 || f.right2;
        const demand = Number(state.engines[1].running) + Number(state.engines[2].running) +
            Number(state.apu.running) * 0.25;

        f.pressure = approach(f.pressure, pumps ? 1 : 0, 5, dt);

        if (f.center > 0 && (f.center1 || f.center2)) {
            const transfer = Math.min(f.center, 0.15 * dt);
            f.center -= transfer;
            f.left += transfer * 0.5;
            f.right += transfer * 0.5;
        }
        if (demand && f.pressure > 0.2) {
            f.left = Math.max(0, f.left - demand * 0.018 * dt);
            f.right = Math.max(0, f.right - demand * 0.018 * dt);
        }
    }

    function updateAPU(dt) {
        const a = state.apu, e = state.electrical, f = state.fuel;
        const electrical = e.dcEssential;
        const fuel = f.pressure > 0.15 && (f.left + f.center + f.right > 1);
        const requested = a.master && a.start;

        if (requested && electrical && fuel && !a.fault) a.rpm = approach(a.rpm, 100, 0.9, dt);
        else if (!a.master || a.fault) a.rpm = approach(a.rpm, 0, 1.8, dt);
        else a.rpm = approach(a.rpm, 0, 0.25, dt);

        a.running = a.master && !a.fault && a.rpm >= 92;
        a.genAvailable = a.running && a.rpm >= 95;
        a.bleedAvailable = a.running;

        if (requested && !electrical) warn('APU START ELEC'); else unwarn('APU START ELEC');
        if (requested && !fuel) warn('APU FUEL'); else unwarn('APU FUEL');
    }

    function updateEngine(n, dt) {
        const e = state.engines[n], p = state.electrical, f = state.fuel;
        const starterPower = p.dcEssential || p.acEssential || state.apu.running;
        const fuel = f.pressure > 0.25;

        if (e.master && e.start && starterPower && fuel) {
            e.n2 = approach(e.n2, 65, 0.8, dt);
            e.n3 = approach(e.n3, 100, 0.65, dt);
        } else if (!e.master || !e.start) {
            e.n2 = approach(e.n2, 0, 0.8, dt);
            e.n3 = approach(e.n3, 0, 0.8, dt);
        } else {
            e.n2 = approach(e.n2, 0, 0.25, dt);
            e.n3 = approach(e.n3, 0, 0.25, dt);
        }

        e.running = e.master && e.n2 >= 50 && e.n3 >= 50;
        e.gen = e.running;
        if (e.start && e.master && !starterPower) warn(`ENG ${n} START ELEC`);
        else unwarn(`ENG ${n} START ELEC`);
    }

    function updateElectrical(dt) {
        const e = state.electrical, a = state.apu, eng = state.engines;
        e.bat1V = approach(e.bat1V, e.bat1 ? 28 : 0, 5, dt);
        e.bat2V = approach(e.bat2V, e.bat2 ? 28 : 0, 5, dt);

        e.gen1Available = eng[1].gen;
        e.gen2Available = eng[2].gen;
        e.apuGenAvailable = a.genAvailable;

        e.dcEssential = e.bat1V > 18 || e.bat2V > 18 || e.extPowerOn ||
            e.apuGenOn || e.gen1On || e.gen2On;
        e.acEssential = e.extPowerOn || e.apuGenOn || e.gen1On || e.gen2On;

        // Contactors follow source availability. No arbitrary timed sequence.
        e.apuGenOn = e.apuGenAvailable && e.acEssential;
        e.gen1On = e.gen1Available && eng[1].running;
        e.gen2On = e.gen2Available && eng[2].running;

        if (!e.dcEssential) warn('ELEC ESSENTIAL'); else unwarn('ELEC ESSENTIAL');
    }

    function updatePneumatic(dt) {
        const p = state.pneumatic, a = state.apu, e = state.engines;
        p.apuBleed = a.bleedAvailable;
        p.eng1Bleed = e[1].running;
        p.eng2Bleed = e[2].running;
        const sources = Number(p.apuBleed) + Number(p.eng1Bleed) + Number(p.eng2Bleed);
        p.pressure = approach(p.pressure, sources / 3, 2.5, dt);
        p.pack1 = p.pressure > 0.2;
        p.pack2 = p.pressure > 0.2;
    }

    function updateHydraulic(dt) {
        const h = state.hydraulic, e = state.engines;
        h.green = approach(h.green, e[1].running ? 1 : 0, 2, dt);
        h.yellow = approach(h.yellow, e[2].running ? 1 : 0, 2, dt);
        h.blue = approach(h.blue,
            h.electricPump && state.electrical.dcEssential ? 1 : 0, 2, dt);
    }

    function updateDisplays() {
        state.displays.powered = state.electrical.acEssential || state.electrical.dcEssential;
        if (!state.displays.powered) state.displays.ewd = 'DISPLAY POWER OFF';
        else if (state.warnings.length) state.displays.ewd = state.warnings.slice(-3).join(' | ');
        else if (state.engines[1].running || state.engines[2].running) state.displays.ewd = 'NORMAL';
        else state.displays.ewd = 'CONFIGURATION';
    }

    function step(dt) {
        updateFuel(dt);
        updateAPU(dt);
        updateEngine(1, dt);
        updateEngine(2, dt);
        updateElectrical(dt);
        updatePneumatic(dt);
        updateHydraulic(dt);
        updateDisplays();
        bridgeNativeControls();
    }

    /* -------------------- GeoFS bridge -------------------- */

    function bridgeNativeControls() {
        const c = controls();
        if (!c) return;

        // Only map native controls where we know GeoFS has a corresponding
        // control. Local A350 systems remain authoritative for everything else.
        try {
            if (state.flight.gear && c.gear && 'positionTarget' in c.gear) {
                c.gear.positionTarget = 1;
                if (typeof c.setPartAnimationDelta === 'function') c.setPartAnimationDelta(c.gear);
            }
        } catch (_) {}
    }

    function listParts() {
        const parts = Object.keys(ac()?.parts || {});
        console.log('[A350 v4] GeoFS aircraft parts:', parts);
        return parts;
    }

    function addPartRotation(partName, axis) {
        const part = ac()?.parts?.[partName];
        if (!part?.object3d) return false;
        part.animations = Array.isArray(part.animations) ? part.animations : [];
        const key = `A350V4_${partName}_${axis}`;
        if (part.animations.some(a => a?.name === key)) return true;
        const method = part.object3d[`rotate${axis}`];
        if (typeof method !== 'function') return false;
        part.animations.push({
            name: key, type: 'rotate', axis,
            value: key, rotationMethod: method.bind(part.object3d)
        });
        return true;
    }

    function setPartRotation(partName, axis, degrees) {
        const key = `A350V4_${partName}_${axis}`;
        if (!window.geofs?.animation?.setValue) return false;
        geofs.animation.setValue(key, degrees);
        return true;
    }

    /* -------------------- camera-safe interaction -------------------- */

    function priority() { return performance.now() < input.priorityUntil; }

    function cameraLocked() {
        // The 5-second priority window freezes the state that existed when
        // Shift+\\ was pressed. This is important when pressing it again:
        // FREE must remain FREE during its priority window.
        if (priority()) return input.priorityLock;
        return input.masterLock || input.autoLock;
    }

    function applyInputState() {
        input.autoLock = Boolean(input.hover || input.active);
        return cameraLocked();
    }

    function toggleMasterLock() {
        input.masterLock = !input.masterLock;
        input.priorityLock = input.masterLock;
        input.priorityUntil = performance.now() + CFG.MASTER_PRIORITY;
        input.hover = null;
        input.active = null;
        applyInputState();
        render();
    }

    function eventHitsHotspot(x, y) {
        if (!overlay) return null;

        // Prefer the actual rendered hotspot element. This avoids a second,
        // slightly different coordinate system from the visible hitbox.
        const el = document.elementFromPoint(x, y);
        if (el?.classList?.contains('a350-v4-hotspot')) {
            return hotspots.find(h => h.id === el.dataset.id) || null;
        }

        // Fallback for browsers where elementFromPoint returns a child.
        const hit = el?.closest?.('.a350-v4-hotspot');
        if (hit) return hotspots.find(h => h.id === hit.dataset.id) || null;

        return null;
    }

    function onMouseMove(e) {
        if (!isA350(geofsAircraft)) return;

        input.hover = eventHitsHotspot(e.clientX, e.clientY);
        const h = input.active;

        if (h?.type === 'knob') {
            // Once a knob drag starts, GeoFS must not receive this movement.
            e.preventDefault();
            e.stopImmediatePropagation();

            const dx = e.clientX - input.lastX;
            input.lastX = e.clientX;
            if (!dx || typeof h.get !== 'function' || typeof h.set !== 'function') return;

            let value = h.get() + (dx / CFG.KNOB_PX) * h.step;
            if (h.wrap) {
                const span = h.max - h.min + h.step;
                while (value < h.min) value += span;
                while (value > h.max) value -= span;
            } else value = clamp(value, h.min, h.max);
            h.set(value);
            applyInputState();
            return;
        }

        applyInputState();

        // Persistent MASTER LOCK blocks GeoFS camera movement everywhere.
        // A FREE priority window deliberately does NOT enter this branch.
        if (cameraLocked()) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    function onMouseDown(e) {
        if (!isA350(geofsAircraft)) return;
        const h = eventHitsHotspot(e.clientX, e.clientY);
        if (!h) {
            if (cameraLocked()) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
            return;
        }

        input.active = h;
        input.lastX = e.clientX;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (h.type === 'switch' || h.type === 'button') h.action?.();
    }

    function onMouseUp(e) {
        if (input.active) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
        input.active = null;
        applyInputState();
    }

    function onKeyDown(e) {
        if (e.shiftKey && e.code === 'Backslash') {
            e.preventDefault();
            e.stopPropagation();
            toggleMasterLock();
            return;
        }
        if (e.code === 'F8') { e.preventDefault(); togglePanel(); }
        if (e.code === 'F9') { e.preventDefault(); debug = !debug; renderHotspots(); }
        if (e.code === 'F10') { e.preventDefault(); listParts(); }
    }

    /* -------------------- hotspots -------------------- */

    function togglePath(path) {
        const bits = path.split('.');
        let o = state;
        for (let i = 0; i < bits.length - 1; i++) o = o[bits[i]];
        const k = bits[bits.length - 1];
        o[k] = !o[k];
    }

    const builtin = [
        { id:'bat1', name:'BAT 1', type:'switch', x:10, y:10, w:3, h:5, action:()=>togglePath('electrical.bat1') },
        { id:'bat2', name:'BAT 2', type:'switch', x:14, y:10, w:3, h:5, action:()=>togglePath('electrical.bat2') },
        { id:'apu-master', name:'APU MASTER', type:'switch', x:18, y:10, w:4, h:5, action:()=>togglePath('apu.master') },
        { id:'apu-start', name:'APU START', type:'switch', x:23, y:10, w:4, h:5, action:()=>togglePath('apu.start') },
        { id:'apu-bleed', name:'APU BLEED', type:'switch', x:28, y:10, w:4, h:5, action:()=>togglePath('pneumatic.apuBleed') },
        { id:'eng1-master', name:'ENG 1 MASTER', type:'switch', x:10, y:25, w:4, h:5, action:()=>togglePath('engines.1.master') },
        { id:'eng1-start', name:'ENG 1 START', type:'switch', x:15, y:25, w:4, h:5, action:()=>togglePath('engines.1.start') },
        { id:'eng2-master', name:'ENG 2 MASTER', type:'switch', x:20, y:25, w:4, h:5, action:()=>togglePath('engines.2.master') },
        { id:'eng2-start', name:'ENG 2 START', type:'switch', x:25, y:25, w:4, h:5, action:()=>togglePath('engines.2.start') },
        { id:'alt', name:'ALTITUDE', type:'knob', x:40, y:30, w:6, h:8, min:100, max:50000, step:100, get:()=>state.flight.selectedAltitude, set:v=>state.flight.selectedAltitude=v },
        { id:'hdg', name:'HEADING', type:'knob', x:47, y:30, w:6, h:8, min:0, max:359, step:1, wrap:true, get:()=>state.flight.selectedHeading, set:v=>state.flight.selectedHeading=v },
        { id:'spd', name:'SPEED', type:'knob', x:54, y:30, w:6, h:8, min:100, max:400, step:1, get:()=>state.flight.selectedSpeed, set:v=>state.flight.selectedSpeed=v }
    ];

    function loadMap() {
        try {
            const saved = JSON.parse(localStorage.getItem(CFG.MAP_KEY) || 'null');
            if (!Array.isArray(saved)) return builtin.slice();
            const map = new Map(builtin.map(h => [h.id, h]));
            for (const h of saved) if (h?.id) map.set(h.id, {...map.get(h.id), ...h});
            // Actions/getters are restored from the builtin map for known controls.
            return [...map.values()];
        } catch (_) { return builtin.slice(); }
    }
    let hotspots = loadMap();

    function saveMap() {
        const clean = hotspots.map(h => {
            const o = {...h}; delete o.action; delete o.get; delete o.set; return o;
        });
        localStorage.setItem(CFG.MAP_KEY, JSON.stringify(clean));
    }

    function renderHotspots() {
        if (!overlay) return;
        overlay.innerHTML = '';

        // The old alpha used percentage-sized rectangles directly. They were
        // effectively giant flexible UI blocks. Geometry is now resolved to
        // concrete screen pixels, so every control has an actual hitbox.
        for (const h of hotspots) {
            const el = document.createElement('div');
            el.className = 'a350-v4-hotspot' + (debug ? ' debug' : '');
            el.dataset.id = h.id;
            el.title = h.name;

            const x = innerWidth * (h.x / 100);
            const y = innerHeight * (h.y / 100);
            const w = Math.max(12, innerWidth * (h.w / 100));
            const height = Math.max(12, innerHeight * (h.h / 100));

            el.style.left = Math.round(x) + 'px';
            el.style.top = Math.round(y) + 'px';
            el.style.width = Math.round(w) + 'px';
            el.style.height = Math.round(height) + 'px';
            overlay.appendChild(el);
        }
    }

    let uiReady = false;

    function ensureUI() {
        if (!document.getElementById('a350-v4-style')) {
            const css = document.createElement('style');
            css.id = 'a350-v4-style';
            css.textContent = `
#a350-v4-overlay{position:fixed;inset:0;z-index:2147483000;pointer-events:none}
.a350-v4-hotspot{position:absolute;box-sizing:border-box;pointer-events:auto;border:1px solid transparent;border-radius:3px;cursor:pointer}
.a350-v4-hotspot:hover{border-color:rgba(0,220,255,.85);background:rgba(0,220,255,.08)}
.a350-v4-hotspot.debug{border-color:rgba(255,60,60,.8);background:rgba(255,60,60,.12)}
#a350-v4-panel{position:fixed;right:12px;top:12px;width:330px;max-height:calc(100vh - 24px);overflow:auto;z-index:2147483001;background:rgba(8,10,13,.92);color:#d9e7ef;border:1px solid rgba(100,200,255,.35);border-radius:8px;padding:10px;font:12px/1.35 Consolas,monospace;pointer-events:auto;box-sizing:border-box}
#a350-v4-panel button{background:#172027;color:#d9e7ef;border:1px solid #49606d;border-radius:4px;padding:4px 7px;margin:3px;cursor:pointer}
`;            document.head.appendChild(css);
        }
        if (!overlay) { overlay = document.createElement('div'); overlay.id='a350-v4-overlay'; document.body.appendChild(overlay); }
        if (!panel) {
            panel = document.createElement('div'); panel.id='a350-v4-panel';
            panel.innerHTML = '<b>GeoFS A350 v4.0</b><div id="a350-v4-status"></div>' +
                '<button id="a350-v4-debug">Debug</button><button id="a350-v4-parts">Parts</button>' +
                '<button id="a350-v4-save">Save map</button><div style="opacity:.7;margin-top:5px">Shift+\\ camera lock · F8 panel · F9 debug · F10 parts</div>';
            document.body.appendChild(panel); status=panel.querySelector('#a350-v4-status');
            panel.querySelector('#a350-v4-debug').onclick=()=>{debug=!debug;renderHotspots()};
            panel.querySelector('#a350-v4-parts').onclick=listParts;
            panel.querySelector('#a350-v4-save').onclick=saveMap;
        }
        if (!uiReady) {
            renderHotspots();
            uiReady = true;
        }
    }

    function togglePanel() { ensureUI(); panel.style.display = panel.style.display === 'none' ? '' : 'none'; }

    function render() {
        if (!status) return;
        const e=state.electrical,a=state.apu,f=state.fuel,h=state.hydraulic;
        const lock = priority()
            ? (input.priorityLock ? 'MASTER LOCK' : 'FREE')
            : (input.masterLock ? 'MASTER LOCK' : (input.autoLock ? 'AUTO LOCK' : 'FREE'));
        status.innerHTML = `<hr style="border:0;border-top:1px solid #26343c">
<div>Camera: <b>${lock}</b>${priority()?' <span style="color:#ffd76b">PRIORITY</span>':''}</div>
<div>BAT: ${e.bat1?'ON':'OFF'} ${e.bat1V.toFixed(1)}V / ${e.bat2?'ON':'OFF'} ${e.bat2V.toFixed(1)}V</div>
<div>AC: ${e.acEssential?'POWERED':'OFF'} · DC: ${e.dcEssential?'POWERED':'OFF'}</div>
<div>APU: ${a.rpm.toFixed(0)}% ${a.running?'RUNNING':'OFF/STARTING'}</div>
<div>ENG1: N2 ${state.engines[1].n2.toFixed(0)} ${state.engines[1].running?'RUN':''}</div>
<div>ENG2: N2 ${state.engines[2].n2.toFixed(0)} ${state.engines[2].running?'RUN':''}</div>
<div>FUEL: L ${f.left.toFixed(1)} C ${f.center.toFixed(1)} R ${f.right.toFixed(1)}</div>
<div>HYD: G ${h.green.toFixed(2)} Y ${h.yellow.toFixed(2)} B ${h.blue.toFixed(2)}</div>
<div>EWD: ${state.displays.ewd}</div>
<div style="color:${state.warnings.length?'#ffd76b':'#7dff9c'}">WARN: ${state.warnings.length?state.warnings.join(' | '):'NONE'}</div>`;
    }

    function loop(last) {
        const now=performance.now();
        const dt=clamp((now-last)/1000,0,0.2);
        geofsAircraft=ac();
        const a350=isA350(geofsAircraft);
        if (a350) {
            ensureUI();
            step(dt);
            render();
        }
        else if (overlay) overlay.style.display='none';
        if (overlay && a350) overlay.style.display='';
        if (!input.active && !input.masterLock && !priority()) {
            input.autoLock = Boolean(input.hover);
        }
        requestAnimationFrame(()=>loop(now));
    }

    function start() {
        const timer=setInterval(()=>{
            if (!window.geofs?.aircraft?.instance || !window.controls) return;
            clearInterval(timer);
            ensureUI();
            window.addEventListener('mousemove',onMouseMove,true);
            window.addEventListener('mousedown',onMouseDown,true);
            window.addEventListener('mouseup',onMouseUp,true);
            window.addEventListener('contextmenu',e=>{if(input.active){e.preventDefault();e.stopPropagation()}},true);
            window.addEventListener('keydown',onKeyDown,true);
            requestAnimationFrame(t=>loop(t));
            console.log(`[A350 v4] ${CFG.VERSION} initialized`);
        },CFG.POLL);
    }

    window.A350V4={
        version:CFG.VERSION,
        state,
        hotspots,
        saveMap,
        renderHotspots,
        listParts,
        addPartRotation,
        setPartRotation,
        camera:{
            toggle:toggleMasterLock,
            get locked(){return cameraLocked()},
            get masterLocked(){return input.masterLock},
            get priority(){return priority()},
            get priorityMode(){return input.priorityLock ? 'MASTER' : 'FREE'}
        },
        calibrate(name,type='switch',w=3,h=4){
            const x=clamp((input.hover?0:0),0,100); // calibration API placeholder; mapper is next build stage
            console.log('[A350 v4] Use the current pointer position with this helper in the next mapper build:',name,type,w,h,x);
        }
    };

    start();
})();