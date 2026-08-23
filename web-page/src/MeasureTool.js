import {
    Cartesian2,
    Cartesian3,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
} from "./CesiumJsInc.js";

// Minimal two-point distance measurement, primarily a testbed for GS picking precision.
//
// A click resolves a world point via RotationCenterSnap.resolveMeasurement (exact mesh
// depth pick, or the full-density-refined splat point). Two clicks give a segment; the
// label shows the distance and, when a splat point is involved, a ± uncertainty derived
// from the k-nearest splat spread. It works on mesh, point-cloud and GS content through
// the one resolver.
//
// Rendering is a DOM/SVG overlay in the viewer container, NOT Cesium geometry: splats
// render in a later pass (GAUSSIAN_SPLATS, 11) and would paint over any in-scene polyline
// or billboard — the same reason the rotation-centre marker is a DOM overlay. We project
// the fixed world endpoints to screen each postRender (the camera moves, the points don't).
//
// The tool consumes LEFT_CLICK only, so left-drag orbit still works while measuring.

const SVG_NS = "http://www.w3.org/2000/svg";

// Hover preview: a hollow ring (distinct from the solid red placed dots) showing where the
// next click would land, so a wrong snap radius is obvious before you commit. Dark halo so
// it reads on bright splat backgrounds.
const PREVIEW_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
    "<circle cx='12' cy='12' r='6' fill='none' stroke='#000000' stroke-width='3.5' stroke-opacity='0.5'/>" +
    "<circle cx='12' cy='12' r='6' fill='none' stroke='#ffffff' stroke-width='1.5'/>" +
    "<circle cx='12' cy='12' r='1.5' fill='#ffffff'/></svg>";

// Don't recompute the preview until the cursor moves at least this far — keeps the per-move
// resolve (and, on splats, refine) from running on every sub-pixel mouse event.
const PREVIEW_MIN_MOVE_PX = 2;

class MeasureTool {
    // options: { viewer, snap: RotationCenterSnap, isFlyActive?: () => boolean }
    constructor(options) {
        this._viewer = options.viewer;
        this._scene = this._viewer.scene;
        this._snap = options.snap;
        this._isFlyActive = options.isFlyActive || (() => false);

        this._active = false;
        this._a = undefined; // Cartesian3
        this._b = undefined; // Cartesian3
        this._spreadA = 0;
        this._spreadB = 0;
        // A button is held (orbit/tilt drag in progress) → suppress the hover preview.
        this._pointerDown = false;
        this._lastPreviewPx = undefined;

        this._installOverlay();
        this._installPreview();
        this._installHandler();

        // Reproject the fixed world endpoints each rendered frame as the camera moves.
        this._scene.postRender.addEventListener(() => this._updateOverlay());
    }

    isActive() {
        return this._active;
    }

    activate() {
        this._active = true;
    }

    deactivate() {
        this._active = false;
        this._clear();
        this._hidePreview();
    }

    // --- overlay -------------------------------------------------------------

    _installOverlay() {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute(
            "style",
            "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" +
                "z-index:1000;overflow:visible;display:none;",
        );

        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("stroke", "#ffffff");
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-opacity", "0.9");
        // A dark halo under the white line so it reads on bright splat backgrounds.
        const lineHalo = document.createElementNS(SVG_NS, "line");
        lineHalo.setAttribute("stroke", "#000000");
        lineHalo.setAttribute("stroke-width", "4.5");
        lineHalo.setAttribute("stroke-opacity", "0.5");

        const dotA = this._makeDot();
        const dotB = this._makeDot();

        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("text-anchor", "middle");
        label.setAttribute(
            "style",
            "paint-order:stroke;stroke:#000000;stroke-width:3px;stroke-opacity:0.6;" +
                "fill:#ffffff;font:600 13px sans-serif;",
        );

        svg.appendChild(lineHalo);
        svg.appendChild(line);
        svg.appendChild(dotA);
        svg.appendChild(dotB);
        svg.appendChild(label);
        this._viewer.container.appendChild(svg);

        this._svg = svg;
        this._line = line;
        this._lineHalo = lineHalo;
        this._dotA = dotA;
        this._dotB = dotB;
        this._label = label;
    }

    _makeDot() {
        const g = document.createElementNS(SVG_NS, "g");
        const halo = document.createElementNS(SVG_NS, "circle");
        halo.setAttribute("r", "5");
        halo.setAttribute("fill", "#000000");
        halo.setAttribute("fill-opacity", "0.5");
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("r", "3");
        dot.setAttribute("fill", "#ff3b30");
        dot.setAttribute("stroke", "#ffffff");
        dot.setAttribute("stroke-width", "1");
        g.appendChild(halo);
        g.appendChild(dot);
        g.setAttribute("display", "none");
        return g;
    }

    _installPreview() {
        const el = document.createElement("div");
        el.className = "measure-preview";
        el.style.cssText =
            "position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;" +
            "pointer-events:none;display:none;z-index:1000;";
        el.innerHTML = PREVIEW_SVG;
        this._viewer.container.appendChild(el);
        this._previewEl = el;
    }

    // --- input ---------------------------------------------------------------

    _installHandler() {
        this._handler = new ScreenSpaceEventHandler(this._scene.canvas);
        this._handler.setInputAction((event) => {
            if (!this._active || this._isFlyActive()) return;
            const m = this._snap.resolveMeasurement(event.position);
            if (!m) return;
            this._place(m);
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Hover preview: show where the next click would land. Suppressed while a button is
        // down (an orbit/tilt drag is in progress) so it doesn't flicker during navigation.
        this._handler.setInputAction((movement) => this._onMove(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE);

        const down = () => { this._pointerDown = true; this._hidePreview(); };
        const up = () => { this._pointerDown = false; };
        this._handler.setInputAction(down, ScreenSpaceEventType.LEFT_DOWN);
        this._handler.setInputAction(up, ScreenSpaceEventType.LEFT_UP);
        this._handler.setInputAction(down, ScreenSpaceEventType.RIGHT_DOWN);
        this._handler.setInputAction(up, ScreenSpaceEventType.RIGHT_UP);
    }

    _onMove(position) {
        if (!this._active || this._isFlyActive() || this._pointerDown) {
            this._hidePreview();
            return;
        }
        // Throttle: skip until the cursor has moved a couple of px.
        if (this._lastPreviewPx) {
            const dx = position.x - this._lastPreviewPx.x, dy = position.y - this._lastPreviewPx.y;
            if (dx * dx + dy * dy < PREVIEW_MIN_MOVE_PX * PREVIEW_MIN_MOVE_PX) return;
        }
        this._lastPreviewPx = {x: position.x, y: position.y};

        const m = this._snap.resolveMeasurement(position);
        if (!m) {
            this._hidePreview();
            return;
        }
        const pos = this._scene.cartesianToCanvasCoordinates(m.point, scratchPreview);
        if (pos) {
            this._previewEl.style.left = pos.x + "px";
            this._previewEl.style.top = pos.y + "px";
            this._previewEl.style.display = "block";
        } else {
            this._hidePreview();
        }
    }

    _hidePreview() {
        this._previewEl.style.display = "none";
    }

    _place(m) {
        if (!this._a || this._b) {
            // Start (or restart) a measurement.
            this._a = Cartesian3.clone(m.point);
            this._b = undefined;
            this._spreadA = m.spread;
            this._spreadB = 0;
        } else {
            this._b = Cartesian3.clone(m.point);
            this._spreadB = m.spread;
        }
        this._svg.style.display = "block";
        this._scene.requestRender();
    }

    _clear() {
        this._a = undefined;
        this._b = undefined;
        this._spreadA = 0;
        this._spreadB = 0;
        this._svg.style.display = "none";
        this._scene.requestRender();
    }

    // --- render --------------------------------------------------------------

    _updateOverlay() {
        if (!this._a) return;

        const pa = this._scene.cartesianToCanvasCoordinates(this._a, scratchA);
        this._placeDot(this._dotA, pa);

        if (!this._b) {
            this._dotB.setAttribute("display", "none");
            this._line.setAttribute("display", "none");
            this._lineHalo.setAttribute("display", "none");
            this._label.setAttribute("display", "none");
            return;
        }

        const pb = this._scene.cartesianToCanvasCoordinates(this._b, scratchB);
        this._placeDot(this._dotB, pb);

        if (pa && pb) {
            this._line.setAttribute("display", "");
            this._lineHalo.setAttribute("display", "");
            for (const ln of [this._line, this._lineHalo]) {
                ln.setAttribute("x1", pa.x);
                ln.setAttribute("y1", pa.y);
                ln.setAttribute("x2", pb.x);
                ln.setAttribute("y2", pb.y);
            }
            this._label.setAttribute("display", "");
            this._label.setAttribute("x", (pa.x + pb.x) / 2);
            this._label.setAttribute("y", (pa.y + pb.y) / 2 - 8);
            this._label.textContent = this._labelText();
        } else {
            this._line.setAttribute("display", "none");
            this._lineHalo.setAttribute("display", "none");
            this._label.setAttribute("display", "none");
        }
    }

    _placeDot(dot, pos) {
        if (pos) {
            dot.setAttribute("display", "");
            dot.setAttribute("transform", `translate(${pos.x},${pos.y})`);
        } else {
            dot.setAttribute("display", "none");
        }
    }

    _labelText() {
        const dist = Cartesian3.distance(this._a, this._b);
        // Uncertainty of the distance ≈ quadrature sum of the endpoint spreads.
        const sigma = Math.sqrt(this._spreadA * this._spreadA + this._spreadB * this._spreadB);
        const d = formatMeters(dist);
        return sigma > 0 ? `${d} ± ${formatMeters(sigma)}` : d;
    }
}

function formatMeters(v) {
    let decimals;
    if (v >= 100) decimals = 1;
    else if (v >= 1) decimals = 2;
    else decimals = 3;
    return `${v.toFixed(decimals)} m`;
}

const scratchA = new Cartesian2();
const scratchB = new Cartesian2();
const scratchPreview = new Cartesian2();

export { MeasureTool };
