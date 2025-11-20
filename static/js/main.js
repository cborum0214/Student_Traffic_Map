const statusDiv = document.getElementById("status");
const canvas = document.getElementById("floorCanvas");
const ctx = canvas.getContext("2d");

// Map selection
const mapSelect = document.getElementById("mapSelect");
const loadMapBtn = document.getElementById("loadMapBtn");

const uploadFloorplanBtn = document.getElementById("uploadFloorplanBtn");
const uploadScheduleBtn = document.getElementById("uploadScheduleBtn");
uploadFloorplanBtn.addEventListener("click", uploadFloorplan);
uploadScheduleBtn.addEventListener("click", uploadSchedule);

// Mode: "space" or "hallway"
let mode = "space";
document.querySelectorAll('input[name="mode"]').forEach(function (radio) {
    radio.addEventListener("change", function (e) {
        mode = e.target.value;
        setStatus(
            "Mode: " + (mode === "space" ? "Mark Spaces" : "Draw Hallways") + "."
        );
        pendingHallwayStart = null;
        routeHallwayIds = [];
        hallwayCongestion = {};
        hallwayColorTiers = {};

        // When switching editing modes, show labels again
        showLabels = true;
        drawFloorplan();
    });
});

// Data (per current map)
let currentMapId = null;
let maps = [];          // list of {id, name, image_url}
let spaces = [];
let hallways = [];
let periodNames = [];
let hallwayCongestion = {};   // hallway_id -> count
let routeHallwayIds = [];

// NEW: hallway_id -> 'red' | 'orange' | 'green'
let hallwayColorTiers = {};

// Whether to draw room labels on the canvas
let showLabels = true;

// DOM for lists
const spacesListEl = document.getElementById("spacesList");
const hallwaysListEl = document.getElementById("hallwaysList");

// Route controls
const routeFromSelect = document.getElementById("routeFrom");
const routeToSelect = document.getElementById("routeTo");
const showRouteBtn = document.getElementById("showRouteBtn");
if (showRouteBtn) {
    showRouteBtn.addEventListener("click", requestRoute);
}

// Congestion controls
const congFromSelect = document.getElementById("congFrom");
const congToSelect = document.getElementById("congTo");
const showCongestionBtn = document.getElementById("showCongestionBtn");
const congestionSummaryEl = document.getElementById("congestionSummary");
if (showCongestionBtn) {
    showCongestionBtn.addEventListener("click", requestCongestion);
}

// Zoom controls
const zoomSlider = document.getElementById("zoomSlider");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomLabel = document.getElementById("zoomLabel");
let zoom = 1.0;

// Image meta for mapping clicks to normalized coords (pre-zoom)
let imageMeta = { x: 0, y: 0, width: 0, height: 0, loaded: false };
let currentImage = null;

// When drawing hallways, store the first click
let pendingHallwayStart = null; // {x, y} in normalized coords

function setStatus(message, isError) {
    if (isError === undefined) {
        isError = false;
    }
    console.log("STATUS:", message);
    statusDiv.textContent = message;
    statusDiv.style.color = isError ? "red" : "black";
}

// ---------- Zoom helpers ----------

function applyZoomTransform() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);
}

function updateZoomLabel() {
    if (!zoomLabel || !zoomSlider) return;
    const pct = Math.round(zoom * 100);
    zoomLabel.textContent = pct + "%";
}

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
    const current = parseFloat(zoomSlider.value);
    let next = current + delta;
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
    zoomInBtn.addEventListener("click", function () {
        nudgeZoom(0.1);
    });
}
if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", function () {
        nudgeZoom(-0.1);
    });
}

// Initialize zoom label
updateZoomLabel();

// ---------- Map list ----------

async function loadMapList() {
    try {
        const response = await fetch("/maps");
        const result = await response.json();
        console.log("Maps list:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error loading map list.", true);
            return;
        }

        maps = result.maps || [];
        mapSelect.innerHTML = "";

        if (maps.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No maps yet – upload a floorplan";
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
        setStatus("Selected map not found in list.", true);
        return;
    }

    currentMapId = mapId;
    // When loading a map, default to labels visible
    showLabels = true;
    hallwayCongestion = {};
    hallwayColorTiers = {};
    routeHallwayIds = [];
    if (congestionSummaryEl) congestionSummaryEl.textContent = "";
    await loadFloorplanImage(mapObj.image_url);
}

if (loadMapBtn) {
    loadMapBtn.addEventListener("click", loadSelectedMap);
}

// ---------- Floorplan loading helpers ----------

async function loadFloorplanImage(imageUrl) {
    if (!currentMapId) {
        setStatus("No map selected. Choose a map first.", true);
        return;
    }

    setStatus("Loading floorplan from " + imageUrl + "...");

    const img = new Image();
    img.onload = async function () {
        currentImage = img;

        await loadSpacesFromServer();
        await loadHallwaysFromServer();
        await loadScheduleInfo(); // if schedule already uploaded for this map

        routeHallwayIds = [];
        hallwayCongestion = {};
        hallwayColorTiers = {};
        zoom = 1.0;
        if (zoomSlider) zoomSlider.value = "1";
        updateZoomLabel();

        // When we freshly load a map image, show labels
        showLabels = true;

        drawFloorplan();
        setStatus(
            "Floorplan loaded. Click on the map to add spaces or hallways."
        );
    };
    img.onerror = function (e) {
        console.error("Error loading image", e);
        setStatus("Failed to load floorplan image.", true);
    };
    img.src = imageUrl;
}

// ---------- Upload floorplan and create a new map ----------

async function uploadFloorplan() {
    const fileInput = document.getElementById("floorplanFile");

    if (!fileInput.files || fileInput.files.length === 0) {
        setStatus("Please choose an image file first.", true);
        return;
    }

    const data = new FormData();
    data.append("floorplan", fileInput.files[0]);

    try {
        const response = await fetch("/upload_floorplan", {
            method: "POST",
            body: data
        });

        const result = await response.json();
        console.log("Floorplan upload result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error uploading floorplan.", true);
            return;
        }

        const newMap = result.map;
        setStatus("Floorplan uploaded and new map created: " + newMap.name);

        // Refresh map list
        await loadMapList();

        // Select and load the new map
        currentMapId = newMap.id;
        mapSelect.value = String(newMap.id);
        showLabels = true;
        hallwayCongestion = {};
        hallwayColorTiers = {};
        routeHallwayIds = [];
        if (congestionSummaryEl) congestionSummaryEl.textContent = "";
        await loadFloorplanImage(newMap.image_url);
    } catch (err) {
        console.error(err);
        setStatus("Unexpected error uploading floorplan.", true);
    }
}

// ---------- Draw floorplan + overlays ----------

function drawFloorplan() {
    if (!currentImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = currentImage;
    const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
    const drawWidth = img.width * scale;
    const drawHeight = img.height * scale;
    const x = (canvas.width - drawWidth) / 2;
    const y = (canvas.height - drawHeight) / 2;

    imageMeta = { x: x, y: y, width: drawWidth, height: drawHeight, loaded: true };

    ctx.save();
    applyZoomTransform();

    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, drawWidth, drawHeight);

    drawHallwaysOverlay();
    drawSpacesOverlay();

    ctx.restore();

    renderLists();
    updateRouteSelectors();
    updatePeriodSelectors();
}

// ---------- Load data from server for current map ----------

async function loadSpacesFromServer() {
    if (!currentMapId) return;
    try {
        const response = await fetch("/spaces?map_id=" + currentMapId);
        const result = await response.json();
        spaces = result.spaces || [];
        console.log("Loaded spaces:", spaces);
    } catch (err) {
        console.error("Error loading spaces:", err);
        setStatus("Could not load existing spaces.", true);
    }
}

async function loadHallwaysFromServer() {
    if (!currentMapId) return;
    try {
        const response = await fetch("/hallways?map_id=" + currentMapId);
        const result = await response.json();
        hallways = result.hallways || [];
        console.log("Loaded hallways:", hallways);
    } catch (err) {
        console.error("Error loading hallways:", err);
        setStatus("Could not load existing hallways.", true);
    }
}

async function loadScheduleInfo() {
    if (!currentMapId) return;
    try {
        const response = await fetch("/schedule_info?map_id=" + currentMapId);
        const result = await response.json();
        if (!response.ok || result.status !== "ok") {
            return; // no schedule yet for this map
        }
        periodNames = result.period_names || [];
        console.log("Schedule info:", result);
        updatePeriodSelectors();
    } catch (err) {
        console.error("Error loading schedule info:", err);
    }
}

// ---------- Drawing overlays ----------

function drawSpacesOverlay() {
    if (!imageMeta.loaded) return;

    ctx.font = "12px Arial";
    ctx.fillStyle = "red";

    spaces.forEach(function (space) {
        const sx = imageMeta.x + space.x * imageMeta.width;
        const sy = imageMeta.y + space.y * imageMeta.height;

        const r = 5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();

        // Only show labels when flag is true
        if (showLabels) {
            ctx.fillText(space.name, sx + 8, sy - 8);
        }
    });
}

function drawHallwaysOverlay() {
    if (!imageMeta.loaded) return;

    hallways.forEach(function (h) {
        const x1 = imageMeta.x + h.x1 * imageMeta.width;
        const y1 = imageMeta.y + h.y1 * imageMeta.height;
        const x2 = imageMeta.x + h.x2 * imageMeta.width;
        const y2 = imageMeta.y + h.y2 * imageMeta.height;

        const count = hallwayCongestion[h.id] || 0;

        let color;
        if (count === 0) {
            // No traffic: faint blue
            color = "rgba(0, 0, 255, 0.2)";
        } else {
            // Use tier if we have one, otherwise default to green
            const tier = hallwayColorTiers[h.id];
            if (tier === "red") {
                color = "rgba(255, 0, 0, 0.9)";
            } else if (tier === "orange") {
                color = "rgba(255, 165, 0, 0.8)";
            } else {
                // green by default for all other used hallways
                color = "rgba(0, 200, 0, 0.7)";
            }
        }

        // Still scale line width by count so heavy paths look thicker
        const baseWidth = 3;
        const widthBoost = Math.min(count, 10) / 2;
        ctx.strokeStyle = color;
        ctx.lineWidth = baseWidth + widthBoost;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    });

    // Highlight manual route in bright green
    if (routeHallwayIds && routeHallwayIds.length > 0) {
        hallways.forEach(function (h) {
            if (routeHallwayIds.indexOf(h.id) === -1) return;

            const x1 = imageMeta.x + h.x1 * imageMeta.width;
            const y1 = imageMeta.y + h.y1 * imageMeta.height;
            const x2 = imageMeta.x + h.x2 * imageMeta.width;
            const y2 = imageMeta.y + h.y2 * imageMeta.height;

            ctx.strokeStyle = "rgba(0, 255, 0, 1.0)";
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        });
    }
}

// ---------- Lists (Spaces & Hallways) ----------

function renderLists() {
    renderSpacesList();
    renderHallwaysList();
}

function renderSpacesList() {
    if (!spacesListEl) return;
    spacesListEl.innerHTML = "";

    spaces.forEach(function (space) {
        const li = document.createElement("li");
        li.textContent =
            space.id + ": " + space.name + " (" + space.type + ") ";

        const btn = document.createElement("button");
        btn.textContent = "Delete";
        btn.addEventListener("click", function () {
            deleteSpace(space.id);
        });

        li.appendChild(btn);
        spacesListEl.appendChild(li);
    });
}

function renderHallwaysList() {
    if (!hallwaysListEl) return;
    hallwaysListEl.innerHTML = "";

    hallways.forEach(function (h) {
        const li = document.createElement("li");
        li.textContent =
            "ID " + h.id + ": " + h.name + " (" +
            h.from_space_id + " → " + h.to_space_id + ") ";

        const btn = document.createElement("button");
        btn.textContent = "Delete";
        btn.addEventListener("click", function () {
            deleteHallway(h.id);
        });

        li.appendChild(btn);
        hallwaysListEl.appendChild(li);
    });
}

// ---------- Route selectors ----------

function updateRouteSelectors() {
    if (!routeFromSelect || !routeToSelect) return;

    const prevFrom = routeFromSelect.value;
    const prevTo = routeToSelect.value;

    routeFromSelect.innerHTML = "";
    routeToSelect.innerHTML = "";

    spaces.forEach(function (s) {
        const opt1 = document.createElement("option");
        opt1.value = String(s.id);
        opt1.textContent = s.id + ": " + s.name;
        routeFromSelect.appendChild(opt1);

        const opt2 = document.createElement("option");
        opt2.value = String(s.id);
        opt2.textContent = s.id + ": " + s.name;
        routeToSelect.appendChild(opt2);
    });

    if (prevFrom) {
        for (let i = 0; i < routeFromSelect.options.length; i++) {
            if (routeFromSelect.options[i].value === prevFrom) {
                routeFromSelect.selectedIndex = i;
                break;
            }
        }
    }
    if (prevTo) {
        for (let i = 0; i < routeToSelect.options.length; i++) {
            if (routeToSelect.options[i].value === prevTo) {
                routeToSelect.selectedIndex = i;
                break;
            }
        }
    }
}

// ---------- Period selectors for congestion ----------

function updatePeriodSelectors() {
    if (!congFromSelect || !congToSelect) return;

    const prevFrom = congFromSelect.value;
    const prevTo = congToSelect.value;

    congFromSelect.innerHTML = "";
    congToSelect.innerHTML = "";

    periodNames.forEach(function (pname, idx) {
        const label = (idx + 1) + ": " + pname;

        const opt1 = document.createElement("option");
        opt1.value = String(idx);
        opt1.textContent = label;
        congFromSelect.appendChild(opt1);

        const opt2 = document.createElement("option");
        opt2.value = String(idx);
        opt2.textContent = label;
        congToSelect.appendChild(opt2);
    });

    if (prevFrom) {
        for (let i = 0; i < congFromSelect.options.length; i++) {
            if (congFromSelect.options[i].value === prevFrom) {
                congFromSelect.selectedIndex = i;
                break;
            }
        }
    }
    if (prevTo) {
        for (let i = 0; i < congToSelect.options.length; i++) {
            if (congToSelect.options[i].value === prevTo) {
                congToSelect.selectedIndex = i;
                break;
            }
        }
    }
}

// ---------- Delete actions ----------

async function deleteSpace(spaceId) {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }

    const ok = window.confirm(
        "Delete space " + spaceId + " and any connected hallways?"
    );
    if (!ok) return;

    try {
        const response = await fetch("/spaces/" + spaceId + "?map_id=" + currentMapId, {
            method: "DELETE"
        });
        const result = await response.json();
        console.log("Delete space result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error deleting space.", true);
            return;
        }

        await loadSpacesFromServer();
        await loadHallwaysFromServer();
        routeHallwayIds = [];
        hallwayCongestion = {};
        hallwayColorTiers = {};
        showLabels = true;
        if (congestionSummaryEl) congestionSummaryEl.textContent = "";
        drawFloorplan();
        setStatus("Space " + spaceId + " deleted.");
    } catch (err) {
        console.error("Error deleting space:", err);
        setStatus("Unexpected error deleting space.", true);
    }
}

async function deleteHallway(hallwayId) {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }

    const ok = window.confirm("Delete hallway " + hallwayId + "?");
    if (!ok) return;

    try {
        const response = await fetch("/hallways/" + hallwayId + "?map_id=" + currentMapId, {
            method: "DELETE"
        });
        const result = await response.json();
        console.log("Delete hallway result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error deleting hallway.", true);
            return;
        }

        await loadHallwaysFromServer();
        routeHallwayIds = [];
        hallwayCongestion = {};
        hallwayColorTiers = {};
        showLabels = true;
        if (congestionSummaryEl) congestionSummaryEl.textContent = "";
        drawFloorplan();
        setStatus("Hallway " + hallwayId + " deleted.");
    } catch (err) {
        console.error("Error deleting hallway:", err);
        setStatus("Unexpected error deleting hallway.", true);
    }
}

// ---------- Canvas click handler (with zoom-aware coords) ----------

canvas.addEventListener("click", async function (e) {
    if (!currentMapId) {
        setStatus("Select or upload a map first.", true);
        return;
    }
    if (!imageMeta.loaded) {
        setStatus("Load a floorplan first.", true);
        return;
    }

    const rect = canvas.getBoundingClientRect();
    let clickX = e.clientX - rect.left;
    let clickY = e.clientY - rect.top;

    // Undo zoom transform to get "pre-zoom" canvas coords
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const unzoomX = cx + (clickX - cx) / zoom;
    const unzoomY = cy + (clickY - cy) / zoom;

    if (
        unzoomX < imageMeta.x ||
        unzoomX > imageMeta.x + imageMeta.width ||
        unzoomY < imageMeta.y ||
        unzoomY > imageMeta.y + imageMeta.height
    ) {
        return;
    }

    const relX = (unzoomX - imageMeta.x) / imageMeta.width;
    const relY = (unzoomY - imageMeta.y) / imageMeta.height;

    // Editing again → show labels
    showLabels = true;

    // Clear route & congestion highlight when editing
    routeHallwayIds = [];
    hallwayCongestion = {};
    hallwayColorTiers = {};
    if (congestionSummaryEl) congestionSummaryEl.textContent = "";

    if (mode === "space") {
        await handleSpaceClick(relX, relY);
    } else if (mode === "hallway") {
        await handleHallwayClick(relX, relY);
    }
});

// ---------- Space click ----------

async function handleSpaceClick(relX, relY) {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }

    const name = window.prompt("Space name (e.g., Room 210):");
    if (!name) {
        setStatus("Space creation cancelled.");
        return;
    }

    const type =
        window.prompt(
            "Space type (e.g., Classroom, Stairwell, Office):",
            "Classroom"
        ) || "Classroom";

    const newSpace = { map_id: currentMapId, name: name, type: type, x: relX, y: relY };

    try {
        const response = await fetch("/spaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newSpace)
        });

        const result = await response.json();
        if (!response.ok || result.status !== "ok") {
            console.error("Error from /spaces:", result);
            setStatus(result.message || "Error saving space.", true);
            return;
        }

        spaces.push(result.space);
        drawFloorplan();
        setStatus('Space "' + name + '" saved.');
    } catch (err) {
        console.error("Error saving space:", err);
        setStatus("Unexpected error saving space.", true);
    }
}

// ---------- Hallway click ----------

async function handleHallwayClick(relX, relY) {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }

    if (!pendingHallwayStart) {
        pendingHallwayStart = { x: relX, y: relY };
        setStatus("Hallway start set. Click a second point to finish the hallway.");
        return;
    }

    const start = pendingHallwayStart;
    pendingHallwayStart = null;

    const name = window.prompt("Hallway name (e.g., Main Hall Segment):", "Hallway");
    if (!name) {
        setStatus("Hallway creation cancelled.");
        return;
    }

    const newHallway = {
        map_id: currentMapId,
        name: name,
        x1: start.x,
        y1: start.y,
        x2: relX,
        y2: relY
    };

    try {
        const response = await fetch("/hallways", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newHallway)
        });

        const result = await response.json();
        if (!response.ok || result.status !== "ok") {
            console.error("Error from /hallways:", result);
            setStatus(result.message || "Error saving hallway.", true);
            return;
        }

        await loadSpacesFromServer();
        await loadHallwaysFromServer();
        drawFloorplan();
        setStatus(
            'Hallway "' + name +
            '" saved (endpoints snapped to nearest spaces).'
        );
    } catch (err) {
        console.error("Unexpected error saving hallway:", err);
        setStatus("Unexpected error saving hallway.", true);
    }
}

// ---------- Route request ----------

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
        setStatus("Please select both a start and end space.", true);
        return;
    }

    const fromId = parseInt(fromVal, 10);
    const toId = parseInt(toVal, 10);

    if (isNaN(fromId) || isNaN(toId)) {
        setStatus("Invalid space selection.", true);
        return;
    }

    if (fromId === toId) {
        routeHallwayIds = [];
        // Hide labels for route view of a trivial path too
        showLabels = false;
        drawFloorplan();
        setStatus("Start and end are the same space.");
        return;
    }

    // Hide labels while route is being shown
    showLabels = false;

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

        setStatus("Route found with " + routeHallwayIds.length + " segment(s).");
    } catch (err) {
        console.error("Error requesting route:", err);
        setStatus("Unexpected error requesting route.", true);
    }
}

// ---------- Congestion request ----------

async function requestCongestion() {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }
    if (!congFromSelect || !congToSelect) {
        setStatus("Congestion controls not found.", true);
        return;
    }

    const fromVal = congFromSelect.value;
    const toVal = congToSelect.value;

    if (!fromVal || !toVal) {
        setStatus("Please select both from and to periods.", true);
        return;
    }

    const fromIdx = parseInt(fromVal, 10);
    const toIdx = parseInt(toVal, 10);

    if (isNaN(fromIdx) || isNaN(toIdx)) {
        setStatus("Invalid period selection.", true);
        return;
    }

    // Hide labels while congestion heatmap is shown
    showLabels = false;

    try {
        const response = await fetch("/congestion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                map_id: currentMapId,
                from_period_index: fromIdx,
                to_period_index: toIdx
            })
        });

        const result = await response.json();
        console.log("Congestion result:", result);

        if (!response.ok || result.status !== "ok") {
            setStatus(result.message || "Error computing congestion.", true);
            hallwayCongestion = {};
            hallwayColorTiers = {};
            routeHallwayIds = [];
            drawFloorplan();
            if (congestionSummaryEl) congestionSummaryEl.textContent = "";
            return;
        }

        hallwayCongestion = {};
        hallwayColorTiers = {};

        const list = result.hallway_counts || [];
        list.forEach(function (hc) {
            hallwayCongestion[hc.hallway_id] = hc.count;
        });

        // Build a sorted list of {id, count}, highest count first
        const sorted = Object.entries(hallwayCongestion)
            .map(([id, count]) => ({ id: parseInt(id, 10), count }))
            .sort((a, b) => b.count - a.count);

        // Top 2–3 red, next 8 orange, rest green
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

        // Clear manual route overlay
        routeHallwayIds = [];

        drawFloorplan();

        const pf = result.period_from;
        const pt = result.period_to;
        const totalTrips = result.total_trips;
        const maxCount = result.max_count;

        const summaryText =
            "Congestion " + pf + " → " + pt +
            " | total hallway traversals: " + totalTrips +
            " | max on one hallway: " + maxCount;

        if (congestionSummaryEl) congestionSummaryEl.textContent = summaryText;
        setStatus("Congestion computed for " + pf + " → " + pt + ".");
    } catch (err) {
        console.error("Error requesting congestion:", err);
        setStatus("Unexpected error requesting congestion.", true);
    }
}

// ---------- Schedule upload (per map) ----------

async function uploadSchedule() {
    if (!currentMapId) {
        setStatus("Select a map first.", true);
        return;
    }

    const fileInput = document.getElementById("scheduleFile");

    if (!fileInput.files || fileInput.files.length === 0) {
        setStatus("Please choose a schedule CSV file first.", true);
        return;
    }

    const data = new FormData();
    data.append("schedule", fileInput.files[0]);
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
            extra =
                " Note: " + unmatched.length +
                " room name(s) not matched to spaces: " +
                unmatched.join(", ");
        }

        setStatus(
            "Schedule uploaded. Students: " + result.num_students +
            " | Periods: " + periodNames.join(", ") + extra
        );
    } catch (err) {
        console.error(err);
        setStatus("Unexpected error uploading schedule.", true);
    }
}

// ---------- Init on page load ----------

window.addEventListener("load", async function () {
    await loadMapList();
});
