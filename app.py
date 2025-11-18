import os
import math
import heapq
import csv
from flask import Flask, render_template, request, jsonify, url_for

app = Flask(__name__)

# --------- Floorplan upload setup ---------
UPLOAD_FOLDER = os.path.join("static", "floorplans")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER

# --------- In-memory data ---------
# Spaces: points (classrooms, stairwells, intersections, etc.)
#   { "id", "name", "type", "x", "y" }  (x,y normalized 0–1)
SPACES = []
NEXT_SPACE_ID = 1

# Hallways: segments between two spaces
#   { "id", "name",
#     "x1","y1","x2","y2",
#     "from_space_id","to_space_id" }
HALLWAYS = []
NEXT_HALLWAY_ID = 1

# Schedule data (from CSV)
# PERIOD_NAMES: list of strings like ["P1", "P2", "P3", ...]
PERIOD_NAMES = []
# STUDENT_SCHEDULES: list of dicts
#   { "student_id", "student_name", "space_ids": [space_id or None, ...] }
STUDENT_SCHEDULES = []


# --------- Helpers for spaces / hallways ---------

def get_space_by_id(space_id):
    for s in SPACES:
        if s["id"] == space_id:
            return s
    return None


def get_space_by_name(name):
    for s in SPACES:
        if s["name"] == name:
            return s
    return None


def find_or_create_space_at(x, y, threshold=0.03):
    """
    Find the nearest existing space to (x,y) in normalized coords.
    If none exists within 'threshold' distance, create an Intersection.
    Returns the space dict.
    """
    global NEXT_SPACE_ID, SPACES

    if not SPACES:
        space = {
            "id": NEXT_SPACE_ID,
            "name": f"Node {NEXT_SPACE_ID}",
            "type": "Intersection",
            "x": float(x),
            "y": float(y),
        }
        NEXT_SPACE_ID += 1
        SPACES.append(space)
        print("Auto-created intersection space:", space)
        return space

    best_space = None
    best_dist_sq = None
    for s in SPACES:
        dx = s["x"] - x
        dy = s["y"] - y
        d_sq = dx * dx + dy * dy
        if best_dist_sq is None or d_sq < best_dist_sq:
            best_dist_sq = d_sq
            best_space = s

    if best_dist_sq is None or math.sqrt(best_dist_sq) > threshold:
        space = {
            "id": NEXT_SPACE_ID,
            "name": f"Node {NEXT_SPACE_ID}",
            "type": "Intersection",
            "x": float(x),
            "y": float(y),
        }
        NEXT_SPACE_ID += 1
        SPACES.append(space)
        print("Auto-created intersection space:", space)
        return space

    print("Snapped point to existing space:", best_space)
    return best_space


def build_graph():
    """
    Build an adjacency list graph from SPACES and HALLWAYS.

    graph[space_id] = list of (neighbor_space_id, distance, hallway_id)
    """
    graph = {}
    for s in SPACES:
        graph[s["id"]] = []

    for h in HALLWAYS:
        s1 = get_space_by_id(h.get("from_space_id"))
        s2 = get_space_by_id(h.get("to_space_id"))
        if not s1 or not s2:
            continue

        dx = s1["x"] - s2["x"]
        dy = s1["y"] - s2["y"]
        dist = math.sqrt(dx * dx + dy * dy)

        graph[s1["id"]].append((s2["id"], dist, h["id"]))
        graph[s2["id"]].append((s1["id"], dist, h["id"]))

    return graph


def dijkstra_shortest_path(start_id, end_id):
    """
    Dijkstra's algorithm to find shortest path between two spaces.
    Returns (space_path, hallway_path) or (None, None) if unreachable.
    """
    graph = build_graph()
    if start_id not in graph or end_id not in graph:
        return None, None

    dist = {sid: math.inf for sid in graph.keys()}
    prev = {sid: None for sid in graph.keys()}      # prev node
    prev_edge = {sid: None for sid in graph.keys()} # hallway id used to get here

    dist[start_id] = 0.0
    heap = [(0.0, start_id)]

    while heap:
        current_dist, u = heapq.heappop(heap)
        if current_dist > dist[u]:
            continue
        if u == end_id:
            break

        for (v, weight, hallway_id) in graph[u]:
            alt = current_dist + weight
            if alt < dist[v]:
                dist[v] = alt
                prev[v] = u
                prev_edge[v] = hallway_id
                heapq.heappush(heap, (alt, v))

    if dist[end_id] == math.inf:
        return None, None

    # Reconstruct path of spaces
    space_path = []
    hallway_path = []
    current = end_id
    while current is not None:
        space_path.append(current)
        current = prev[current]
    space_path.reverse()

    # Derive hallway_ids between consecutive spaces
    for i in range(1, len(space_path)):
        sid = space_path[i]
        hallway_id = prev_edge[sid]
        if hallway_id is not None:
            hallway_path.append(hallway_id)

    return space_path, hallway_path


# --------- Flask routes ---------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload_floorplan", methods=["POST"])
def upload_floorplan():
    if "floorplan" not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400

    file = request.files["floorplan"]
    if file.filename == "":
        return jsonify({"status": "error", "message": "No selected file"}), 400

    filepath = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
    file.save(filepath)

    image_url = url_for("static", filename=f"floorplans/{file.filename}")
    print("Saved floorplan to:", filepath)
    print("Image URL is:", image_url)
    return jsonify({"status": "ok", "url": image_url})


@app.route("/upload_schedule", methods=["POST"])
def upload_schedule():
    """
    Accept a CSV file with columns:
      student_id, student_name, P1, P2, P3, ...
    Where P1..Pn are period names and their values are Space names (e.g. "Room 101").
    """
    global PERIOD_NAMES, STUDENT_SCHEDULES

    if "schedule" not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400

    file = request.files["schedule"]
    if file.filename == "":
        return jsonify({"status": "error", "message": "No selected file"}), 400

    os.makedirs("data", exist_ok=True)
    filepath = os.path.join("data", file.filename)
    file.save(filepath)

    # Parse CSV
    loaded_period_names = []
    loaded_students = []
    unmatched_rooms = set()

    try:
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames or []

            # Expect first two columns: student_id, student_name
            if len(fieldnames) < 3:
                return jsonify({
                    "status": "error",
                    "message": "CSV must have at least: student_id, student_name, and one period column (e.g. P1)."
                }), 400

            # All columns after first two are periods
            loaded_period_names = fieldnames[2:]

            for row in reader:
                student_id = row.get("student_id", "").strip()
                student_name = row.get("student_name", "").strip()

                if not student_id and not student_name:
                    continue

                space_ids = []
                for period_name in loaded_period_names:
                    room_name = (row.get(period_name) or "").strip()
                    if not room_name:
                        space_ids.append(None)
                        continue

                    space = get_space_by_name(room_name)
                    if space:
                        space_ids.append(space["id"])
                    else:
                        space_ids.append(None)
                        unmatched_rooms.add(room_name)

                loaded_students.append({
                    "student_id": student_id,
                    "student_name": student_name,
                    "space_ids": space_ids
                })

    except Exception as e:
        print("Error parsing schedule CSV:", e)
        return jsonify({"status": "error", "message": f"Failed to parse CSV: {e}"}), 400

    PERIOD_NAMES = loaded_period_names
    STUDENT_SCHEDULES = loaded_students

    print(f"Loaded schedule with {len(STUDENT_SCHEDULES)} students and periods: {PERIOD_NAMES}")

    return jsonify({
        "status": "ok",
        "path": filepath,
        "num_students": len(STUDENT_SCHEDULES),
        "period_names": PERIOD_NAMES,
        "unmatched_rooms": sorted(list(unmatched_rooms))
    })


@app.route("/schedule_info", methods=["GET"])
def schedule_info():
    return jsonify({
        "status": "ok",
        "period_names": PERIOD_NAMES,
        "num_students": len(STUDENT_SCHEDULES)
    })


@app.route("/spaces", methods=["GET"])
def get_spaces():
    return jsonify({"spaces": SPACES})


@app.route("/spaces", methods=["POST"])
def add_space():
    global NEXT_SPACE_ID

    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    name = data.get("name")
    stype = data.get("type")
    x = data.get("x")
    y = data.get("y")

    if name is None or stype is None or x is None or y is None:
        return jsonify({"status": "error", "message": "Missing fields"}), 400

    space = {
        "id": NEXT_SPACE_ID,
        "name": name,
        "type": stype,
        "x": float(x),
        "y": float(y),
    }
    NEXT_SPACE_ID += 1
    SPACES.append(space)

    print("New space:", space)
    return jsonify({"status": "ok", "space": space})


@app.route("/spaces/<int:space_id>", methods=["DELETE"])
def delete_space(space_id):
    """
    Delete a space (classroom, intersection, etc.)
    Also deletes any hallways connected to that space.
    """
    global SPACES, HALLWAYS

    before_spaces = len(SPACES)
    SPACES = [s for s in SPACES if s["id"] != space_id]
    after_spaces = len(SPACES)

    before_hallways = len(HALLWAYS)
    HALLWAYS = [
        h for h in HALLWAYS
        if h.get("from_space_id") != space_id and h.get("to_space_id") != space_id
    ]
    after_hallways = len(HALLWAYS)

    print(
        f"Deleted space {space_id}. Spaces: {before_spaces}->{after_spaces}, "
        f"Hallways: {before_hallways}->{after_hallways}"
    )

    return jsonify({
        "status": "ok",
        "deleted_space_id": space_id,
        "remaining_spaces": after_spaces,
        "remaining_hallways": after_hallways
    })


@app.route("/hallways", methods=["GET"])
def get_hallways():
    return jsonify({"hallways": HALLWAYS})


@app.route("/hallways", methods=["POST"])
def add_hallway():
    """
    Add a hallway segment between two points.
    Snap endpoints to nearest spaces or auto-create Intersections.
    """
    global NEXT_HALLWAY_ID, HALLWAYS

    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    name = data.get("name")
    x1 = data.get("x1")
    y1 = data.get("y1")
    x2 = data.get("x2")
    y2 = data.get("y2")

    if name is None or x1 is None or y1 is None or x2 is None or y2 is None:
        return jsonify({"status": "error", "message": "Missing fields"}), 400

    s1 = find_or_create_space_at(float(x1), float(y1))
    s2 = find_or_create_space_at(float(x2), float(y2))

    hallway = {
        "id": NEXT_HALLWAY_ID,
        "name": name,
        "x1": s1["x"],
        "y1": s1["y"],
        "x2": s2["x"],
        "y2": s2["y"],
        "from_space_id": s1["id"],
        "to_space_id": s2["id"],
    }
    NEXT_HALLWAY_ID += 1
    HALLWAYS.append(hallway)

    print("New hallway:", hallway)
    return jsonify({"status": "ok", "hallway": hallway})


@app.route("/hallways/<int:hallway_id>", methods=["DELETE"])
def delete_hallway(hallway_id):
    """
    Delete a hallway segment by id.
    """
    global HALLWAYS

    before = len(HALLWAYS)
    HALLWAYS = [h for h in HALLWAYS if h["id"] != hallway_id]
    after = len(HALLWAYS)

    print(f"Deleted hallway {hallway_id}. Hallways: {before}->{after}")

    return jsonify({
        "status": "ok",
        "deleted_hallway_id": hallway_id,
        "remaining_hallways": after
    })


@app.route("/route", methods=["POST"])
def route():
    """
    Compute shortest route between two spaces.
    Expected JSON: { "from_space_id": 3, "to_space_id": 7 }
    """
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    try:
        start_id = int(data.get("from_space_id"))
        end_id = int(data.get("to_space_id"))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid space ids"}), 400

    if not get_space_by_id(start_id) or not get_space_by_id(end_id):
        return jsonify({"status": "error", "message": "One or both spaces not found"}), 400

    if start_id == end_id:
        return jsonify({
            "status": "ok",
            "space_ids": [start_id],
            "hallway_ids": [],
            "message": "Start and end are the same space."
        })

    space_path, hallway_path = dijkstra_shortest_path(start_id, end_id)
    if space_path is None:
        return jsonify({
            "status": "error",
            "message": "No route found between the selected spaces."
        }), 404

    return jsonify({
        "status": "ok",
        "space_ids": space_path,
        "hallway_ids": hallway_path,
        "total_segments": len(hallway_path)
    })


# --------- Congestion simulation ---------

def compute_congestion(from_index, to_index):
    """
    For each student, route from period[from_index] to period[to_index]
    and count how many times each hallway is used.
    Returns a dict: hallway_id -> count
    """
    counts = {}

    if from_index < 0 or to_index < 0:
        return counts
    if from_index >= len(PERIOD_NAMES) or to_index >= len(PERIOD_NAMES):
        return counts

    for student in STUDENT_SCHEDULES:
        space_ids = student["space_ids"]
        if from_index >= len(space_ids) or to_index >= len(space_ids):
            continue

        s_from = space_ids[from_index]
        s_to = space_ids[to_index]

        if s_from is None or s_to is None:
            continue
        if s_from == s_to:
            continue

        space_path, hallway_path = dijkstra_shortest_path(s_from, s_to)
        if space_path is None or not hallway_path:
            continue

        for h_id in hallway_path:
            counts[h_id] = counts.get(h_id, 0) + 1

    return counts


@app.route("/congestion", methods=["POST"])
def congestion():
    """
    Compute congestion between two period indices.
    Expected JSON: { "from_period_index": 0, "to_period_index": 1 }
    """
    if not PERIOD_NAMES or not STUDENT_SCHEDULES:
        return jsonify({
            "status": "error",
            "message": "No schedule loaded yet."
        }), 400

    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    try:
        from_idx = int(data.get("from_period_index"))
        to_idx = int(data.get("to_period_index"))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid period indices"}), 400

    if from_idx < 0 or to_idx < 0 or from_idx >= len(PERIOD_NAMES) or to_idx >= len(PERIOD_NAMES):
        return jsonify({"status": "error", "message": "Period index out of range"}), 400

    counts = compute_congestion(from_idx, to_idx)
    hallway_counts = [{"hallway_id": h_id, "count": c} for h_id, c in counts.items()]
    total_trips = sum(c for c in counts.values())  # total hallway traversals
    max_count = max(counts.values()) if counts else 0

    return jsonify({
        "status": "ok",
        "period_from": PERIOD_NAMES[from_idx],
        "period_to": PERIOD_NAMES[to_idx],
        "hallway_counts": hallway_counts,
        "total_trips": total_trips,
        "max_count": max_count
    })


if __name__ == "__main__":
    app.run(debug=True)
