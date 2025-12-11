const statusDiv = document.getElementById("status");
const canvas = document.getElementById("floorCanvas");
const ctx = canvas.getContext("2d");

// Map selection
const mapSelect = document.getElementById("mapSelect");
const loadMapBtn = document.getElementById("loadMapBtn");

// Schedule upload
const uploadScheduleBtn = document.getElementById("uploadScheduleBtn");

// Congestion controls
const congFromSelect = document.getElementById("congFrom");
const congToSelect = document.getElementById("congTo");
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

// In user view, we do NOT show labels or nodes
let showLabels = false;

// Zoom & pan
let zoom = 1.0;
let panX = 0;   // in screen pixels
let panY = 0;
let isPanning = false;
let lastPanClientX = 0;
let lastPanClientY = 0;

// Image meta for mapping drawing (in *screen* coords, after zoom & pan)
let imageMeta = { x: 0, y: 0, width: 0, height: 0, loaded: false };
let currentImage = null;

// Manual route support not used in user view, but we keep an array just in case
let routeHallwayIds = [];

function setStatus(message, isError) {
    if (isError === undefined) {
        isError = false;
    }
    console.log("STATUS:", message);
    statusDiv.textContent = message;
    statusDiv.style.color = isError ? "red" : "black";
}

// ---------- Zoom helpers (no canvas transforms, just math) ----------

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

// ---------- Panning with mouse drag ----------

canvas.addEventListener("mousedown", function (e) {
    isPanning = true;
    lastPanClientX = e.clientX;
    lastPanClientY = e.clientY;
    canvas.style.cursor = "grabbing";
    e.preventDefault();
});

canvas.addEventListener("mousemove", function (e) {
    if (!isPanning) return;

    const dx = e.clientX - lastPanClientX;
    const dy = e.clientY - lastPanClientY;

    lastPanClientX = e.clientX;
    lastPanClientY = e.clientY;

    panX += dx;
    panY += dy;

    drawFloorplan();
    e.preventDefault();
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
            // No schedule yet; that's okay
            return;
        }
        periodNames = result.period_names || [];
        console.log("Schedule info:", result);
        updatePeriodSelectors();
    } catch (err) {
        console.error("Error loading schedule info:", err);
    }
}

// ---------- Drawing (zoom + pan applied via math, not transforms) ----------

function drawFloorplan() {
    if (!currentImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = currentImage;

    // Base scale to fit canvas
    const baseScale = Math.min(canvas.width / img.width, canvas.height / img.height);
    const displayScale = baseScale * zoom;

    const drawWidth = img.width * displayScale;
    const drawHeight = img.height * displayScale;

    // Centered, then offset by panX/panY
    const x = (canvas.width - drawWidth) / 2 + panX;
    const y = (canvas.height - drawHeight) / 2 + panY;

    imageMeta = { x: x, y: y, width: drawWidth, height: drawHeight, loaded: true };

    // Draw floorplan
    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, drawWidth, drawHeight);

    // Draw congestion overlay (if any)
    drawHallwaysOverlay();
}

// In user view, we never show nodes / labels
function drawSpacesOverlay() {
    // Intentionally empty
}

function drawHallwaysOverlay() {
    if (!imageMeta.loaded) return;

    // If we haven't computed congestion yet, don't draw any hallways
    if (!hallwayCongestion || Object.keys(hallwayCongestion).length === 0) {
        return;
    }

    // Bucket hallways by tier so we can control draw order,
    // but ONLY include hallways that actually have traffic (count > 0).
    const greenHallways = [];  // used, default/green tier
    const orangeHallways = []; // orange tier
    const redHallways = [];    // red tier

    hallways.forEach(function (h) {
        const count = hallwayCongestion[h.id] || 0;
        if (count <= 0) {
            return; // skip zero traffic entirely; don't show the line
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

    // Draw in order: green → orange → red so red always on top
    drawBucket(greenHallways, () => "rgba(0, 200, 0, 0.7)");
    drawBucket(orangeHallways, () => "rgba(255, 165, 0, 0.8)");
    drawBucket(redHallways, () => "rgba(255, 0, 0, 0.9)");

    // Route overlay not used in user view, but if ever set, draw on top
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

// ---------- Period selectors ----------

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
