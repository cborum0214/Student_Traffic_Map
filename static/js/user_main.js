const statusDiv = document.getElementById("status");
const canvas = document.getElementById("floorCanvas");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");

// Map selection
const mapSelect = document.getElementById("mapSelect");
const loadMapBtn = document.getElementById("loadMapBtn");

// Schedule upload
const uploadScheduleBtn = document.getElementById("uploadScheduleBtn");

// Congestion controls
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

// Data (per current map)
let currentMapId = null;
let maps = [];          // list of {id, name, image_url}
let spaces = [];
let hallways = [];
let periodNames = [];
let hallwayCongestion = {};   // hallway_id -> count

// hallway_id -> 'red' | 'orange' | 'green'
let hallwayColorTiers = {};

// We don't show labels or nodes in user view
let showLabels = false;

// Zoom & pan
let zoom = 1.0;
let panX = 0;   // in pixels
let panY = 0;
let isPanning = false;
let lastPanClientX = 0;
let lastPanClientY = 0;

// Image meta (after zoom & pan applied in drawing)
let imageMeta = { x: 0, y: 0, width: 0, height: 0, loaded: false };
let currentImage = null;

// Route highlight (not really used on user view, but kept for consistency)
let routeHallwayIds = [];

function setStatus(message, isError) {
    if (isError === undefined) {
        isError = false;
    }
    console.log("STATUS:", message);
    statusDiv.textContent = message;
    statusDiv.style.color = isError ? "red" : "black";
}

// ---------- Zoom helpers (no canvas transform; we draw with math) ----------

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

updateZoomLabel();

// ---------- Panning with mouse drag + tooltip hover ----------

function distancePointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
        const ddx = px - x1;
        const ddy = py - y1;
        return Math.sqrt(ddx * ddx + ddy * ddy);
    }
    const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    let projX, projY;
    if (t < 0) {
        projX = x1;
        projY = y1;
    } else if (t > 1) {
        projX = x2;
        projY = y2;
    } else {
        projX = x1 + t * dx;
        projY = y1 + t * dy;
    }
    const ddx = px - projX;
    const ddy = py - projY;
    return Math.sqrt(ddx * ddx + ddy * ddy);
}

canvas.addEventListener("mousedown", function (e) {
    isPanning = true;
    lastPanClientX = e.clientX;
    lastPanClientY = e.clientY;
    canvas.style.cursor = "grabbing";
    e.preventDefault();
});

canvas.addEventListener("mousemove", function (e) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // --- PANNING (if mouse is down) ---
    if (isPanning) {
        const dx = e.clientX - lastPanClientX;
        const dy = e.clientY - lastPanClientY;

        lastPanClientX = e.clientX;
        lastPanClientY = e.clientY;

        panX += dx;
        panY += dy;

        drawFloorplan();
        e.preventDefault();
        if (tooltip) tooltip.style.display = "none";
        return;
    }

    // --- HOVER TOOLTIP (only if we have congestion data) ---
    if (!tooltip || !imageMeta.loaded ||
        !hallwayCongestion || Object.keys(hallwayCongestion).length === 0) {
        return;
    }

    let hovered = null;
    let minDist = Infinity;
    const threshold = 8; // pixels

    hallways.forEach(h => {
        const count = hallwayCongestion[h.id] || 0;
        if (count <= 0) return;

        const x1 = imageMeta.x + h.x1 * imageMeta.width;
        const y1 = imageMeta.y + h.y1 * imageMeta.height;
        const x2 = imageMeta.x + h.x2 * imageMeta.width;
        const y2 = imageMeta.y + h.y2 * imageMeta.height;

        const dist = distancePointToSegment(mouseX, mouseY, x1, y1, x2, y2);
        if (dist < threshold && dist < minDist) {
            minDist = dist;
            hovered = { hallway: h, count };
        }
    });

    if (hovered) {
        const name = hovered.hallway.name || `Hallway #${hovered.hallway.id}`;

        tooltip.style.display = "block";
        tooltip.textContent = `${name}: ${hovered.count} students`;

        const tooltipHeight = tooltip.offsetHeight;
        const cursorX = e.clientX;
        const cursorY = e.clientY;

        tooltip.style.left = (cursorX + 12) + "px";
        tooltip.style.top  = (cursorY - tooltipHeight / 2) + "px";
    } else {
        tooltip.style.display = "none";
    }
});

window.addEventListener("mouseup", function () {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = "default";
    }
});

canvas.addEventListener("mouseleave", function () {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = "default";
    }
    if (tooltip) {
        tooltip.style.display = "none";
    }
});

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
            opt.textContent = "No maps available";
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
    hallwayCongestion = {};
    hallwayColorTiers = {};
    routeHallwayIds = [];
    panX = 0;
    panY = 0;
    if (congestionSummaryEl) congestionSummaryEl.textContent = "";
    await loadFloorplanImage(mapObj.image_url);
}

if (loadMapBtn) {
    loadMapBtn.addEventListener("click", loadSelectedMap);
}

// ---------- Floorplan + data loading ----------

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
        await loadScheduleInfo();

        hallwayCongestion = {};
        hallwayColorTiers = {};
        routeHallwayIds = [];
        zoom = 1.0;
        panX = 0;
        panY = 0;
        if (zoomSlider) zoomSlider.value = "1";
        updateZoomLabel();

        drawFloorplan();
        setStatus("Floorplan loaded. Upload a schedule and run congestion.");
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
            return;
        }
        periodNames = result.period_names || [];
        console.log("Schedule info:", result);
        updatePeriodSelectors();
    } catch (err) {
        console.error("Error loading schedule info:", err);
    }
}

// ---------- Drawing (zoom + pan via math) ----------

function drawFloorplan() {
    if (!currentImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = currentImage;

    const baseScale = Math.min(canvas.width / img.width, canvas.height / img.height);
    const displayScale = baseScale * zoom;

    const drawWidth = img.width * displayScale;
    const drawHeight = img.height * displayScale;

    const x = (canvas.width - drawWidth) / 2 + panX;
    const y = (canvas.height - drawHeight) / 2 + panY;

    imageMeta = { x: x, y: y, width: drawWidth, height: drawHeight, loaded: true };

    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, drawWidth, drawHeight);

    drawHallwaysOverlay();
}

function drawHallwaysOverlay() {
    if (!imageMeta.loaded) return;
    if (!hallwayCongestion || Object.keys(hallwayCongestion).length === 0) {
        return;
    }

    const greenHallways = [];
    const orangeHallways = [];
    const redHallways = [];

    hallways.forEach(function (h) {
        const count = hallwayCongestion[h.id] || 0;
        if (count <= 0) {
            return;
        }

        const tier = hallwayColorTiers[h.id];
        if (tier === "red") {
            redHallways.push({ h, count });
        } else if (tier === "orange") {
            orangeHallways.push({ h, count });
        } else {
            greenHallways.push({ h, count });
        }
    });

    function drawBucket(bucket, colorFunc) {
        bucket.forEach(({ h, count }) => {
            const x1 = imageMeta.x + h.x1 * imageMeta.width;
            const y1 = imageMeta.y + h.y1 * imageMeta.height;
            const x2 = imageMeta.x + h.x2 * imageMeta.width;
            const y2 = imageMeta.y + h.y2 * imageMeta.height;

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

    drawBucket(greenHallways, () => "rgba(0, 200, 0, 0.7)");
    drawBucket(orangeHallways, () => "rgba(255, 165, 0, 0.8)");
    drawBucket(redHallways, () => "rgba(255, 0, 0, 0.9)");

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

// ---------- Period & classroom filters ----------

function updatePeriodSelectors() {
    if (!congWindowSelect) return;

    const prevWindow = congWindowSelect.value;
    congWindowSelect.innerHTML = "";

    for (let i = 0; i < periodNames.length - 1; i++) {
        const fromName = periodNames[i];
        const toName = periodNames[i + 1];

        const opt = document.createElement("option");
        opt.value = `${i}-${i + 1}`;
        opt.textContent = `${fromName} → ${toName}`;
        congWindowSelect.appendChild(opt);
    }

    if (prevWindow) {
        congWindowSelect.value = prevWindow;
    }
}

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

if (uploadScheduleBtn) {
    uploadScheduleBtn.addEventListener("click", uploadSchedule);
}

// ---------- Congestion request (with filters) ----------

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
        filterDirection = classDirectionSelect.value;
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

        const list = result.hallway_counts || [];
        list.forEach(function (hc) {
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

if (showCongestionBtn) {
    showCongestionBtn.addEventListener("click", requestCongestion);
}

// ---------- Init ----------

window.addEventListener("load", async function () {
    await loadMapList();
});
