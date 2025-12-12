// ===== DOM ELEMENTS =====
const statusDiv = document.getElementById("status");
const canvas = document.getElementById("floorCanvas");
const ctx = canvas.getContext("2d");

// Map selection
const mapSelect = document.getElementById("mapSelect");
const loadMapBtn = document.getElementById("loadMapBtn");

// Uploads
const floorplanFileInput = document.getElementById("floorplanFile");
const uploadFloorplanBtn = document.getElementById("uploadFloorplanBtn");
const scheduleFileInput = document.getElementById("scheduleFile");
const uploadScheduleBtn = document.getElementById("uploadScheduleBtn");

// Editing mode
const modeRadios = document.querySelectorAll("input[name='mode']");

// Route controls
const routeFromSelect = document.getElementById("routeFrom");
const routeToSelect = document.getElementById("routeTo");
const showRouteBtn = document.getElementById("showRouteBtn");

// Congestion controls (new)
const congWindowSelect = document.getElementById("congWindow");
const classFilterSelect = document.getElementById("classFilter");
const classDirectionSelect = document.getElementById("classDirection");
const showCongestionBtn = document.getElementById("showCongestionBtn");
const congestionSummaryEl = document.getElementById("congestionSummary");

// Zoom controls
const zoomSlider = document.getElementById("zoomSlider");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomLabel = document.getElementById("zoomLabel");

// Space/hallway lists
const spacesListEl = document.getElementById("spacesList");
const hallwaysListEl = document.getElementById("hallwaysList");

// ===== STATE =====
let currentMapId = null;
let maps = [];          // list of {id, name, image_url}
let spaces = [];        // current map spaces
let hallways = [];      // current map hallways
let periodNames = [];   // current map period names

// Congestion data
let hallwayCongestion = {};  // hallway_id -> count
let hallwayColorTiers = {};  // hallway_id -> 'red' | 'orange' | 'green'

// Route highlight
let routeHallwayIds = [];

// Zoom (centered) – no pan in admin
let zoom = 1.0;

// Base image rectangle (at zoom = 1)
let baseImageMeta = { x: 0, y: 0, width: 0, height: 0, loaded: false };
let currentImage = null;

// Editing
let currentMode = "space";      // "space" or "hallway"
let pendingHallwayStart = null; // {xNorm, yNorm} or null

// ===== HELPERS =====

function setStatus(msg, isError = false) {
    console.log("STATUS:", msg);
    statusDiv.textContent = msg;
    statusDiv.style.color = isError ? "red" : "black";
}

function getCurrentMode() {
    let val = "space";
    modeRadios.forEach(r => {
        if (r.checked) val = r.value;
    });
    currentMode = val;
    return val;
}

// Zoom helpers
function updateZoomLabel() {
    if (!zoomLabel || !zoomSlider) return;
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
}

function applyZoomTransform() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);
}

function inverseZoomTransform(sx, sy) {
    // Convert from screen coords (canvas) to "world" coords (before zoom)
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const wx = (sx - cx) / zoom + cx;
    const wy = (sy - cy) / zoom + cy;
    return { x: wx, y: wy };
}

// ===== MAP LIST & LOADING =====

async function loadMapList() {
    try {
        const response = await fetch("/maps");
        const result = await response.json();
        console.log("Maps list:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Could not load maps list.", true);
            return;
        }

        maps = result.maps || [];
        mapSelect.innerHTML = "";

        if (maps.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No maps available yet";
            mapSelect.appendChild(opt);
            mapSelect.disabled = true;
            if (loadMapBtn) loadMapBtn.disabled = true;
            return;
        }

        mapSelect.disabled = false;
        if (loadMapBtn) loadMapBtn.disabled = false;

        maps.forEach(m => {
            const opt = document.createElement("option");
            opt.value = String(m.id);
            opt.textContent = m.name;
            mapSelect.appendChild(opt);
        });

        // Auto-select first map if none selected
        if (!currentMapId && maps.length > 0) {
            currentMapId = maps[0].id;
            mapSelect.value = String(currentMapId);
            await loadSelectedMap();
        }

    } catch (err) {
        console.error("Error loading maps:", err);
        setStatus("Could not load maps list.", true);
    }
}

async function loadSelectedMap() {
    const val = mapSelect.value;
    if (!val) {
        setStatus("Please select a map.", true);
        return;
    }
    const mapId = parseInt(val, 10);
    if (isNaN(mapId)) {
        setStatus("Invalid map selection.", true);
        return;
    }
    const mapObj = maps.find(m => m.id === mapId);
    if (!mapObj) {
        setStatus("Map not found in list.", true);
        return;
    }

    currentMapId = mapId;
    hallwayCongestion = {};
    hallwayColorTiers = {};
    routeHallwayIds = [];
    periodNames = [];
    pendingHallwayStart = null;
    if (congestionSummaryEl) congestionSummaryEl.textContent = "";

    await loadFloorplanImage(mapObj.image_url);
}

if (loadMapBtn) {
    loadMapBtn.addEventListener("click", loadSelectedMap);
}

// ===== FLOORPLAN & DATA LOADING =====

async function loadFloorplanImage(imageUrl) {
    if (!currentMapId) {
        setStatus("No map selected.", true);
        return;
    }

    setStatus("Loading floorplan from " + imageUrl + "...");

    const img = new Image();
    img.onload = async function () {
        currentImage = img;

        // Compute base image rect to fit canvas at zoom=1
        const baseScale = Math.min(
            canvas.width / img.width,
            canvas.height / img.height
        );
        const drawWidth = img.width * baseScale;
        const drawHeight = img.height * baseScale;
        const x = (canvas.width - drawWidth) / 2;
        const y = (canvas.height - drawHeight) / 2;
        baseImageMeta = { x, y, width: drawWidth, height: drawHeight, loaded: true };

        // Load spaces/hallways & schedule info
        await loadSpacesFromServer();
        await loadHallwaysFromServer();
        await loadScheduleInfo();

        // Reset zoom
        zoom = 1.0;
        if (zoomSlider) zoomSlider.value = "1";
        updateZoomLabel();

        drawFloorplan();
        setStatus("Map loaded. You can now edit spaces and hallways.");
    };
    img.onerror = function (e) {
        console.error("Error loading image", e);
        setStatus("Failed to load floorplan image.", true);
    };
    img.src = imageUrl;
}

async function loadSpacesFromServer() {
    if (!currentMapId) return;
    try {
        const response = await fetch("/spaces?map_id=" + currentMapId);
        const result = await response.json();
        spaces = result.spaces || [];
        console.log("Loaded spaces:", spaces);
        updateSpacesUI();
        updateRouteSelectors();
        updateClassroomFilterOptions();
    } catch (err) {
        console.error("Error loading spaces:", err);
        setStatus("Could not load spaces.", true);
    }
}

async function loadHallwaysFromServer() {
    if (!currentMapId) return;
    try {
        const response = await fetch("/hallways?map_id=" + currentMapId);
        const result = await response.json();
        hallways = result.hallways || [];
        console.log("Loaded hallways:", hallways);
        updateHallwaysUI();
        drawFloorplan();
    } catch (err) {
        console.error("Error loading hallways:", err);
        setStatus("Could not load hallways.", true);
    }
}

async function loadScheduleInfo() {
    if (!currentMapId) return;
    try {
        const response = await fetch("/schedule_info?map_id=" + currentMapId);
        const result = await response.json();
        if (!response.ok || result.status !== "ok") {
            periodNames = [];
            updatePeriodSelectors();
            return;
        }
        periodNames = result.period_names || [];
        updatePeriodSelectors();
    } catch (err) {
        console.error("Error loading schedule info:", err);
    }
}

// ===== DRAWING =====

function drawFloorplan() {
    if (!currentImage || !baseImageMeta.loaded) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    applyZoomTransform();

    const img = currentImage;
    const b = baseImageMeta;
    ctx.drawImage(img, 0, 0, img.width, img.height, b.x, b.y, b.width, b.height);

    drawHallwaysOverlay();
    drawSpacesOverlay();

    ctx.restore();
}

function drawSpacesOverlay() {
    if (!baseImageMeta.loaded) return;
    const b = baseImageMeta;

    ctx.font = "12px Arial";
    ctx.fillStyle = "red";

    spaces.forEach(space => {
        const sx = b.x + space.x * b.width;
        const sy = b.y + space.y * b.height;

        const r = 5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillText(space.name, sx + 8, sy - 8);
    });
}

function drawHallwaysOverlay() {
    if (!baseImageMeta.loaded) return;
    const b = baseImageMeta;

    const blueHallways = [];
    const greenHallways = [];
    const orangeHallways = [];
    const redHallways = [];

    hallways.forEach(h => {
        const count = hallwayCongestion[h.id] || 0;
        const tier = hallwayColorTiers[h.id];

        if (count === 0 && Object.keys(hallwayCongestion).length > 0) {
            blueHallways.push({ h, count });
        } else if (count === 0 && Object.keys(hallwayCongestion).length === 0) {
            blueHallways.push({ h, count });
        } else if (tier === "red") {
            redHallways.push({ h, count });
        } else if (tier === "orange") {
            orangeHallways.push({ h, count });
        } else {
            greenHallways.push({ h, count });
        }
    });

    function drawBucket(bucket, colorFunc) {
        bucket.forEach(({ h, count }) => {
            const x1 = b.x + h.x1 * b.width;
            const y1 = b.y + h.y1 * b.height;
            const x2 = b.x + h.x2 * b.width;
            const y2 = b.y + h.y2 * b.height;

            const color = colorFunc(count);
            const baseWidth = 3;
            const widthBoost = Math.min(count, 10) / 2;

            ctx.strokeStyle = color;
            ctx.lineWidth = baseWidth + widthBoost;

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        });
    }

    drawBucket(blueHallways, () =>
        Object.keys(hallwayCongestion).length === 0
            ? "rgba(120, 120, 120, 0.7)"
            : "rgba(0, 0, 255, 0.2)"
    );
    drawBucket(greenHallways, () => "rgba(0, 200, 0, 0.7)");
    drawBucket(orangeHallways, () => "rgba(255, 165, 0, 0.8)");
    drawBucket(redHallways, () => "rgba(255, 0, 0, 0.9)");

    if (routeHallwayIds && routeHallwayIds.length > 0) {
        hallways.forEach(h => {
            if (routeHallwayIds.indexOf(h.id) === -1) return;

            const x1 = b.x + h.x1 * b.width;
            const y1 = b.y + h.y1 * b.height;
            const x2 = b.x + h.x2 * b.width;
            const y2 = b.y + h.y2 * b.height;

            ctx.strokeStyle = "rgba(0, 255, 0, 1.0)";
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        });
    }
}

// ===== UI LISTS =====

function updateSpacesUI() {
    if (!spacesListEl) return;
    spacesListEl.innerHTML = "";
    spaces.forEach(space => {
        const li = document.createElement("li");
        li.textContent = `#${space.id} – ${space.name} (${space.type})`;
        li.style.cursor = "pointer";

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.style.marginLeft = "10px";
        delBtn.addEventListener("click", async (evt) => {
            evt.stopPropagation();
            await deleteSpace(space.id);
        });

        li.appendChild(delBtn);
        spacesListEl.appendChild(li);
    });
}

function updateHallwaysUI() {
    if (!hallwaysListEl) return;
    hallwaysListEl.innerHTML = "";
    hallways.forEach(h => {
        const li = document.createElement("li");
        li.textContent = `#${h.id} – ${h.name} (from ${h.from_space_id} to ${h.to_space_id})`;
        li.style.cursor = "pointer";

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.style.marginLeft = "10px";
        delBtn.addEventListener("click", async (evt) => {
            evt.stopPropagation();
            await deleteHallway(h.id);
        });

        li.appendChild(delBtn);
        hallwaysListEl.appendChild(li);
    });
}

// ===== ROUTE SELECTORS =====

function updateRouteSelectors() {
    if (!routeFromSelect || !routeToSelect) return;

    const prevFrom = routeFromSelect.value;
    const prevTo = routeToSelect.value;

    routeFromSelect.innerHTML = "";
    routeToSelect.innerHTML = "";

    spaces.forEach(s => {
        const opt1 = document.createElement("option");
        opt1.value = String(s.id);
        opt1.textContent = s.name;
        routeFromSelect.appendChild(opt1);

        const opt2 = document.createElement("option");
        opt2.value = String(s.id);
        opt2.textContent = s.name;
        routeToSelect.appendChild(opt2);
    });

    if (prevFrom) routeFromSelect.value = prevFrom;
    if (prevTo) routeToSelect.value = prevTo;
}

// ===== PERIOD SELECTORS (single dropdown) =====

function updatePeriodSelectors() {
    if (!congWindowSelect) return;

    const prevWindow = congWindowSelect.value;
    congWindowSelect.innerHTML = "";

    // Consecutive transitions: P1→P2, P2→P3, ...
    for (let i = 0; i < periodNames.length - 1; i++) {
        const fromName = periodNames[i];
        const toName = periodNames[i + 1];

        const opt = document.createElement("option");
        opt.value = `${i}-${i + 1}`; // "0-1", "1-2", etc.
        opt.textContent = `${fromName} → ${toName}`;
        congWindowSelect.appendChild(opt);
    }

    if (prevWindow) {
        congWindowSelect.value = prevWindow;
    }
}

// ===== CLASSROOM FILTER OPTIONS =====

function updateClassroomFilterOptions() {
    if (!classFilterSelect) return;

    const prev = classFilterSelect.value;
    classFilterSelect.innerHTML = "";

    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All classrooms";
    classFilterSelect.appendChild(allOpt);

    spaces
        .filter(s => !s.type || s.type.toLowerCase().includes("class"))
        .forEach(s => {
            const opt = document.createElement("option");
            opt.value = String(s.id);
            opt.textContent = s.name;
            classFilterSelect.appendChild(opt);
        });

    if (prev) classFilterSelect.value = prev;
}

// ===== UPLOAD FLOORPLAN =====

async function uploadFloorplan() {
    if (!floorplanFileInput.files || floorplanFileInput.files.length === 0) {
        setStatus("Please choose a floorplan image first.", true);
        return;
    }
    const data = new FormData();
    data.append("floorplan", floorplanFileInput.files[0]);

    try {
        const response = await fetch("/upload_floorplan", {
            method: "POST",
            body: data
        });
        const result = await response.json();
        console.log("Upload floorplan result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error uploading floorplan.", true);
            return;
        }

        const newMap = result.map;
        maps.push(newMap);

        const opt = document.createElement("option");
        opt.value = String(newMap.id);
        opt.textContent = newMap.name;
        mapSelect.appendChild(opt);

        mapSelect.value = String(newMap.id);
        currentMapId = newMap.id;

        await loadFloorplanImage(newMap.image_url);
        setStatus("Floorplan uploaded and new map created.");
    } catch (err) {
        console.error("Error uploading floorplan:", err);
        setStatus("Unexpected error uploading floorplan.", true);
    }
}

if (uploadFloorplanBtn) {
    uploadFloorplanBtn.addEventListener("click", uploadFloorplan);
}

// ===== UPLOAD SCHEDULE =====

async function uploadSchedule() {
    if (!currentMapId) {
        setStatus("Select or load a map first.", true);
        return;
    }
    if (!scheduleFileInput.files || scheduleFileInput.files.length === 0) {
        setStatus("Please choose a schedule CSV file first.", true);
        return;
    }

    const data = new FormData();
    data.append("schedule", scheduleFileInput.files[0]);
    data.append("map_id", String(currentMapId));

    try {
        const response = await fetch("/upload_schedule", {
            method: "POST",
            body: data
        });
        const result = await response.json();
        console.log("Schedule upload result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error uploading schedule.", true);
            return;
        }

        periodNames = result.period_names || [];
        updatePeriodSelectors();

        const unmatched = result.unmatched_rooms || [];
        let extra = "";
        if (unmatched.length > 0) {
            extra = " | Unmatched rooms: " + unmatched.join(", ");
        }

        setStatus(
            `Schedule uploaded. Students: ${result.num_students} | Periods: ${periodNames.join(", ")}${extra}`
        );
    } catch (err) {
        console.error("Error uploading schedule:", err);
        setStatus("Unexpected error uploading schedule.", true);
    }
}

if (uploadScheduleBtn) {
    uploadScheduleBtn.addEventListener("click", uploadSchedule);
}

// ===== CANVAS CLICK HANDLING (EDITING) =====

canvas.addEventListener("click", async function (evt) {
    if (!currentMapId || !currentImage || !baseImageMeta.loaded) return;

    const mode = getCurrentMode();

    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left;
    const sy = evt.clientY - rect.top;
    const { x: wx, y: wy } = inverseZoomTransform(sx, sy);

    const b = baseImageMeta;

    if (wx < b.x || wx > b.x + b.width || wy < b.y || wy > b.y + b.height) {
        return;
    }

    const xNorm = (wx - b.x) / b.width;
    const yNorm = (wy - b.y) / b.height;

    if (mode === "space") {
        await handleCanvasClickSpace(xNorm, yNorm);
    } else if (mode === "hallway") {
        await handleCanvasClickHallway(xNorm, yNorm);
    }
});

async function handleCanvasClickSpace(xNorm, yNorm) {
    const name = window.prompt("Enter space/classroom name:", "Room ???");
    if (!name) return;

    const type = window.prompt("Enter space type:", "Classroom") || "Classroom";

    try {
        const response = await fetch("/spaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                map_id: currentMapId,
                name: name,
                type: type,
                x: xNorm,
                y: yNorm
            })
        });
        const result = await response.json();
        console.log("Add space result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error adding space.", true);
            return;
        }

        spaces.push(result.space);
        updateSpacesUI();
        updateRouteSelectors();
        updateClassroomFilterOptions();
        drawFloorplan();
        setStatus("Space added.");
    } catch (err) {
        console.error("Error adding space:", err);
        setStatus("Unexpected error adding space.", true);
    }
}

async function handleCanvasClickHallway(xNorm, yNorm) {
    if (!pendingHallwayStart) {
        pendingHallwayStart = { x: xNorm, y: yNorm };
        setStatus("Hallway start set. Click another point for the end.");
        return;
    }

    const start = pendingHallwayStart;
    pendingHallwayStart = null;

    const name = window.prompt("Enter hallway name:", "Hallway") || "Hallway";

    try {
        const response = await fetch("/hallways", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                map_id: currentMapId,
                name: name,
                x1: start.x,
                y1: start.y,
                x2: xNorm,
                y2: yNorm
            })
        });
        const result = await response.json();
        console.log("Add hallway result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error adding hallway.", true);
            return;
        }

        hallways.push(result.hallway);
        updateHallwaysUI();
        drawFloorplan();
        setStatus("Hallway added.");
    } catch (err) {
        console.error("Error adding hallway:", err);
        setStatus("Unexpected error adding hallway.", true);
    }
}

// ===== DELETE SPACE / HALLWAY =====

async function deleteSpace(spaceId) {
    if (!currentMapId) return;
    if (!window.confirm("Delete this space and any connected hallways?")) return;

    try {
        const response = await fetch(`/spaces/${spaceId}?map_id=${currentMapId}`, {
            method: "DELETE"
        });
        const result = await response.json();
        console.log("Delete space result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error deleting space.", true);
            return;
        }

        spaces = spaces.filter(s => s.id !== spaceId);
        hallways = hallways.filter(h => h.from_space_id !== spaceId && h.to_space_id !== spaceId);
        updateSpacesUI();
        updateHallwaysUI();
        updateRouteSelectors();
        updateClassroomFilterOptions();
        drawFloorplan();
        setStatus("Space deleted.");
    } catch (err) {
        console.error("Error deleting space:", err);
        setStatus("Unexpected error deleting space.", true);
    }
}

async function deleteHallway(hallwayId) {
    if (!currentMapId) return;
    if (!window.confirm("Delete this hallway?")) return;

    try {
        const response = await fetch(`/hallways/${hallwayId}?map_id=${currentMapId}`, {
            method: "DELETE"
        });
        const result = await response.json();
        console.log("Delete hallway result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error deleting hallway.", true);
            return;
        }

        hallways = hallways.filter(h => h.id !== hallwayId);
        updateHallwaysUI();
        drawFloorplan();
        setStatus("Hallway deleted.");
    } catch (err) {
        console.error("Error deleting hallway:", err);
        setStatus("Unexpected error deleting hallway.", true);
    }
}

// ===== ROUTE =====

async function requestRoute() {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }
    if (!routeFromSelect || !routeToSelect) {
        setStatus("Route controls not found.", true);
        return;
    }

    const fromVal = routeFromSelect.value;
    const toVal = routeToSelect.value;
    if (!fromVal || !toVal) {
        setStatus("Select both start and end spaces.", true);
        return;
    }

    const fromId = parseInt(fromVal, 10);
    const toId = parseInt(toVal, 10);
    if (isNaN(fromId) || isNaN(toId)) {
        setStatus("Invalid space selection.", true);
        return;
    }

    try {
        const response = await fetch("/route", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                map_id: currentMapId,
                from_space_id: fromId,
                to_space_id: toId
            })
        });
        const result = await response.json();
        console.log("Route result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error computing route.", true);
            routeHallwayIds = [];
            drawFloorplan();
            return;
        }

        routeHallwayIds = result.hallway_ids || [];
        drawFloorplan();
        setStatus("Route displayed.");
    } catch (err) {
        console.error("Error requesting route:", err);
        setStatus("Unexpected error requesting route.", true);
    }
}

if (showRouteBtn) {
    showRouteBtn.addEventListener("click", requestRoute);
}

// ===== CONGESTION (with classroom + direction filters) =====

async function requestCongestion() {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }
    if (!congWindowSelect) {
        setStatus("Congestion controls not found.", true);
        return;
    }

    const windowVal = congWindowSelect.value;
    if (!windowVal) {
        setStatus("Please select a period transition.", true);
        return;
    }

    const [fromStr, toStr] = windowVal.split("-");
    const fromIdx = parseInt(fromStr, 10);
    const toIdx = parseInt(toStr, 10);

    if (isNaN(fromIdx) || isNaN(toIdx)) {
        setStatus("Invalid period transition.", true);
        return;
    }

    let filterSpaceId = null;
    if (classFilterSelect && classFilterSelect.value) {
        const parsedId = parseInt(classFilterSelect.value, 10);
        if (!isNaN(parsedId)) {
            filterSpaceId = parsedId;
        }
    }

    let filterDirection = "any";
    if (classDirectionSelect && classDirectionSelect.value) {
        filterDirection = classDirectionSelect.value; // "any" | "arriving" | "leaving"
    }

    try {
        const response = await fetch("/congestion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                map_id: currentMapId,
                from_period_index: fromIdx,
                to_period_index: toIdx,
                filter_space_id: filterSpaceId,
                filter_direction: filterDirection
            })
        });

        const result = await response.json();
        console.log("Congestion result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error computing congestion.", true);
            hallwayCongestion = {};
            hallwayColorTiers = {};
            drawFloorplan();
            if (congestionSummaryEl) congestionSummaryEl.textContent = "";
            return;
        }

        hallwayCongestion = {};
        hallwayColorTiers = {};
        routeHallwayIds = [];

        const list = result.hallway_counts || [];
        list.forEach(hc => {
            hallwayCongestion[hc.hallway_id] = hc.count;
        });

        const sorted = Object.entries(hallwayCongestion)
            .map(([id, count]) => ({ id: parseInt(id, 10), count }))
            .sort((a, b) => b.count - a.count);

        const redLimit = Math.min(3, sorted.length);
        const orangeLimit = Math.min(redLimit + 8, sorted.length);

        sorted.forEach((entry, index) => {
            if (index < redLimit) {
                hallwayColorTiers[entry.id] = "red";
            } else if (index < orangeLimit) {
                hallwayColorTiers[entry.id] = "orange";
            } else {
                hallwayColorTiers[entry.id] = "green";
            }
        });

        drawFloorplan();

        const pf = result.period_from;
        const pt = result.period_to;
        const totalTrips = result.total_trips;
        const maxCount = result.max_count;

        const summaryText =
            `Congestion ${pf} → ${pt} | total traversals: ${totalTrips} | max on one hallway: ${maxCount}`;

        if (congestionSummaryEl) congestionSummaryEl.textContent = summaryText;
        setStatus("Congestion computed.");
    } catch (err) {
        console.error("Error requesting congestion:", err);
        setStatus("Unexpected error requesting congestion.", true);
    }
}

if (showCongestionBtn) {
    showCongestionBtn.addEventListener("click", requestCongestion);
}

// ===== ZOOM EVENTS =====

if (zoomSlider) {
    zoomSlider.addEventListener("input", function () {
        const val = parseFloat(zoomSlider.value);
        if (!isNaN(val)) {
            zoom = val;
            updateZoomLabel();
            drawFloorplan();
        }
    });
}

function nudgeZoom(delta) {
    if (!zoomSlider) return;
    let val = parseFloat(zoomSlider.value);
    if (isNaN(val)) val = 1.0;
    let next = val + delta;
    const min = parseFloat(zoomSlider.min);
    const max = parseFloat(zoomSlider.max);
    if (next < min) next = min;
    if (next > max) next = max;
    zoomSlider.value = String(next);
    zoom = next;
    updateZoomLabel();
    drawFloorplan();
}

if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => nudgeZoom(0.1));
}
if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => nudgeZoom(-0.1));
}

updateZoomLabel();

// ===== INIT =====

window.addEventListener("load", async function () {
    await loadMapList();
});
