import os
import math
import heapq
import csv
import json
from functools import wraps
from flask import Flask, render_template, request, jsonify, url_for, redirect, session


app = Flask(__name__)

# --- Security config ---
app.secret_key = os.environ.get("HALLWAY_SECRET_KEY", "admin")
ADMIN_PASSWORD = os.environ.get("HALLWAY_ADMIN_PASSWORD", "admin")


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("admin_logged_in"):
            # remember where they were trying to go
            return redirect(url_for("login", next=request.path))
        return f(*args, **kwargs)

    return wrapper


# --------- Floorplan upload setup ---------
UPLOAD_FOLDER = os.path.join("static", "floorplans")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER

# --------- Maps persistence setup ---------
DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)
DATA_FILE = os.path.join(DATA_DIR, "maps.json")

# MAPS: list of map dicts
# Each map:
#   {
#     "id": int,
#     "name": str,
#     "image_filename": str,
#     "spaces": [ ... ],
#     "hallways": [ ... ],
#     "next_space_id": int,
#     "next_hallway_id": int,
#     "period_names": [ ... ],
#     "student_schedules": [ ... ]   # <- memory-only
#   }
MAPS = []
NEXT_MAP_ID = 1

# Name of the space on the map that represents ALL second-floor rooms
SECOND_FLOOR_PROXY_SPACE_NAME = "1st Floor Stairs"


# --------- Persistence helpers ---------
def ensure_map_defaults(m):
    """Make sure a map dict has all required keys."""
    m.setdefault("spaces", [])
    m.setdefault("hallways", [])
    m.setdefault(
        "next_space_id",
        (max((s.get("id", 0) for s in m["spaces"]), default=0) + 1),
    )
    m.setdefault(
        "next_hallway_id",
        (max((h.get("id", 0) for h in m["hallways"]), default=0) + 1),
    )
    # Schedule-related fields exist but will not be persisted across restarts
    m.setdefault("period_names", [])
    m.setdefault("student_schedules", [])


def save_all_data():
    """Save maps to DATA_FILE (EXCLUDING schedules)."""
    # IMPORTANT: we do NOT persist student_schedules or period_names
    # so each run requires uploading a schedule again.
    maps_to_save = []
    for m in MAPS:
        # Copy map but strip schedule-related fields
        m_copy = dict(m)
        m_copy["period_names"] = []
        m_copy["student_schedules"] = []
        maps_to_save.append(m_copy)

    data = {
        "next_map_id": NEXT_MAP_ID,
        "maps": maps_to_save,
    }
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"[MAPS] Saved maps data to {DATA_FILE} (without schedules)")
    except Exception as e:
        print("[MAPS] Error saving maps data:", e)


def load_all_data():
    """Load maps from DATA_FILE, if present."""
    global MAPS, NEXT_MAP_ID

    if not os.path.exists(DATA_FILE):
        print(f"[MAPS] No existing {DATA_FILE}, starting with empty maps list.")
        return

    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        MAPS = data.get("maps", [])
        NEXT_MAP_ID = data.get(
            "next_map_id",
            (max((m.get("id", 0) for m in MAPS), default=0) + 1),
        )

        for m in MAPS:
            ensure_map_defaults(m)

        print(f"[MAPS] Loaded {len(MAPS)} map(s). NEXT_MAP_ID={NEXT_MAP_ID}")
        print("[MAPS] Note: Schedules are not persisted; upload CSV each run.")
    except Exception as e:
        print("[MAPS] Error loading maps data:", e)


def get_map(map_id: int):
    """Return a map dict by id, or None."""
    for m in MAPS:
        if m.get("id") == map_id:
            ensure_map_defaults(m)
            return m
    return None


def serialize_map_for_client(m):
    """Return a safe subset of map info for the frontend."""
    return {
        "id": m["id"],
        "name": m.get("name", f"Map {m['id']}"),
        "image_url": url_for("static", filename=f"floorplans/{m['image_filename']}"),
    }


# Load maps at import time
load_all_data()


# --------- Space / room helpers ---------
def get_space_by_id(map_obj, space_id):
    for s in map_obj["spaces"]:
        if s["id"] == space_id:
            return s
    return None


def get_space_by_name(map_obj, name):
    for s in map_obj["spaces"]:
        if s["name"] == name:
            return s
    return None


def map_virtual_room_to_real(map_obj, room_name):
    """
    Map virtual / upper-floor / undefined rooms to known spaces.

    Your scheme:
      - First floor: "Room XX" (double digits)
      - Second floor: "Room 2XX", "Room 2103", etc.

    We will:
      - Extract the numeric part of the room name.
      - If it's 3+ digits and starts with '2' (e.g., 201, 245, 2103),
        treat it as a second-floor room and map it to '1st Floor Stairs'.
    """
    if not room_name:
        return None

    rn = room_name.strip()

    # If the user writes "Room 201", strip off the "Room " part
    num_part = rn
    if rn.lower().startswith("room "):
        num_part = rn[5:].strip()

    # Keep only digits (handles "Room 201A" or similar)
    digits = "".join(ch for ch in num_part if ch.isdigit())

    # Second floor rule:
    #  - At least 3 digits (so "25" or "09" won't match)
    #  - First digit is '2'
    if len(digits) >= 3 and digits[0] == "2":
        # Map all such rooms to the stairs space
        stairs_space = get_space_by_name(map_obj, SECOND_FLOOR_PROXY_SPACE_NAME)
        if stairs_space:
            print(
                f"[ROOM MAP] Mapping '{room_name}' (digits={digits}) "
                f"to stairs space '{SECOND_FLOOR_PROXY_SPACE_NAME}' (id={stairs_space['id']})"
            )
            return stairs_space

    # No mapping rule matched
    return None


def find_or_create_space_at(map_obj, x, y, threshold=0.03):
    """
    For a given map, find the nearest existing space to (x,y) in normalized coords.
    If none exists within 'threshold' distance, create an Intersection.
    Returns the space dict.
    """
    spaces = map_obj["spaces"]

    if not spaces:
        space = {
            "id": map_obj["next_space_id"],
            "name": f"Node {map_obj['next_space_id']}",
            "type": "Intersection",
            "x": float(x),
            "y": float(y),
        }
        map_obj["next_space_id"] += 1
        spaces.append(space)
        save_all_data()
        print("[MAP] Auto-created intersection space:", space)
        return space

    best_space = None
    best_dist_sq = None
    for s in spaces:
        dx = s["x"] - x
        dy = s["y"] - y
        d_sq = dx * dx + dy * dy
        if best_dist_sq is None or d_sq < best_dist_sq:
            best_dist_sq = d_sq
            best_space = s

    if best_dist_sq is None or math.sqrt(best_dist_sq) > threshold:
        space = {
            "id": map_obj["next_space_id"],
            "name": f"Node {map_obj['next_space_id']}",
            "type": "Intersection",
            "x": float(x),
            "y": float(y),
        }
        map_obj["next_space_id"] += 1
        spaces.append(space)
        save_all_data()
        print("[MAP] Auto-created intersection space:", space)
        return space

    print("[MAP] Snapped point to existing space:", best_space)
    return best_space


def build_graph(map_obj):
    """
    Build an adjacency list graph from a map's SPACES and HALLWAYS.

    graph[space_id] = list of (neighbor_space_id, distance, hallway_id)
    """
    spaces = map_obj["spaces"]
    hallways = map_obj["hallways"]

    graph = {}
    for s in spaces:
        graph[s["id"]] = []

    for h in hallways:
        s1 = get_space_by_id(map_obj, h.get("from_space_id"))
        s2 = get_space_by_id(map_obj, h.get("to_space_id"))
        if not s1 or not s2:
            continue

        dx = s1["x"] - s2["x"]
        dy = s1["y"] - s2["y"]
        dist = math.sqrt(dx * dx + dy * dy)

        graph[s1["id"]].append((s2["id"], dist, h["id"]))
        graph[s2["id"]].append((s1["id"], dist, h["id"]))

    return graph


def dijkstra_shortest_path(map_obj, start_id, end_id):
    """
    Dijkstra's algorithm to find shortest path between two spaces in a map.
    Returns (space_path, hallway_path) or (None, None) if unreachable.
    """
    graph = build_graph(map_obj)
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

    # Hallways between consecutive spaces
    for i in range(1, len(space_path)):
        sid = space_path[i]
        hallway_id = prev_edge[sid]
        if hallway_id is not None:
            hallway_path.append(hallway_id)

    return space_path, hallway_path


# --------- Flask routes: pages & maps ---------
@app.route("/")
def landing_page():
    return render_template("index.html")  # NEW landing page


@app.route("/admin")
@login_required
def admin_page():
    return render_template("admin.html")  # RENAMED admin view and security added


@app.route("/user")
def user_page():
    return render_template("user.html")   # existing user view


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        pwd = request.form.get("password", "")
        if pwd == ADMIN_PASSWORD:
            session["admin_logged_in"] = True
            next_url = request.args.get("next") or url_for("admin_page")
            return redirect(next_url)
        else:
            error = "Incorrect password. Please try again."

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing_page"))  # or whatever your "/" handler is called


@app.route("/maps", methods=["GET"])
def list_maps():
    """
    Return a list of maps so the frontend can show a picklist.
    """
    maps_for_client = [serialize_map_for_client(m) for m in MAPS]
    return jsonify({"status": "ok", "maps": maps_for_client})


@app.route("/upload_floorplan", methods=["POST"])
def upload_floorplan():
    """
    Upload a floorplan image and create a new map entry.
    """
    global NEXT_MAP_ID

    if "floorplan" not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400

    file = request.files["floorplan"]
    if file.filename == "":
        return jsonify({"status": "error", "message": "No selected file"}), 400

    # Save image
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
    file.save(filepath)

    # Create new map
    new_map = {
        "id": NEXT_MAP_ID,
        "name": file.filename,
        "image_filename": file.filename,
        "spaces": [],
        "hallways": [],
        "next_space_id": 1,
        "next_hallway_id": 1,
        "period_names": [],
        "student_schedules": [],
    }
    NEXT_MAP_ID += 1
    MAPS.append(new_map)
    save_all_data()

    print("[MAPS] Created new map:", new_map)

    return jsonify({
        "status": "ok",
        "map": serialize_map_for_client(new_map)
    })


# --------- Schedule upload / info (per map) ---------

@app.route("/upload_schedule", methods=["POST"])
def upload_schedule():
    """
    Accept a CSV file and apply it to a specific map.
    CSV columns:
      student_id, student_name, P1, P2, P3, ...
    Where P1..Pn are period names and their values are space names in that map.

    NOTE: Schedule data is kept in memory only and NOT persisted to disk.
    """
    map_id = request.form.get("map_id", type=int)
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    if "schedule" not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400

    file = request.files["schedule"]
    if file.filename == "":
        return jsonify({"status": "error", "message": "No selected file"}), 400

    filepath = os.path.join(DATA_DIR, file.filename)
    file.save(filepath)

    loaded_period_names = []
    loaded_students = []
    unmatched_rooms = set()

    try:
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames or []

            if len(fieldnames) < 3:
                return jsonify({
                    "status": "error",
                    "message": "CSV must have at least: student_id, student_name, and one period column (e.g. P1)."
                }), 400

            loaded_period_names = fieldnames[2:]  # everything after first 2 columns

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

                    # 1) Try exact match first (e.g., "Room 101")
                    space = get_space_by_name(map_obj, room_name)

                    # 2) If not found, apply our "virtual room" mapping rule
                    if not space:
                        alias_space = map_virtual_room_to_real(map_obj, room_name)
                        if alias_space:
                            space = alias_space

                    # 3) Record result
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
        print("[SCHEDULE] Error parsing schedule CSV:", e)
        return jsonify({"status": "error", "message": f"Failed to parse CSV: {e}"}), 400

    # Overwrite any previous schedule in memory for this map
    map_obj["period_names"] = loaded_period_names
    map_obj["student_schedules"] = loaded_students

    print(
        f"[SCHEDULE] Map {map_id}: loaded {len(loaded_students)} students with periods {loaded_period_names}"
    )
    print("[SCHEDULE] Note: schedule is NOT saved to disk; reupload after restart.")

    return jsonify({
        "status": "ok",
        "map_id": map_id,
        "path": filepath,
        "num_students": len(loaded_students),
        "period_names": loaded_period_names,
        "unmatched_rooms": sorted(list(unmatched_rooms))
    })


@app.route("/schedule_info", methods=["GET"])
def schedule_info():
    map_id = request.args.get("map_id", type=int)
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    return jsonify({
        "status": "ok",
        "map_id": map_id,
        "period_names": map_obj.get("period_names", []),
        "num_students": len(map_obj.get("student_schedules", []))
    })


# --------- Spaces (per map) ---------

@app.route("/spaces", methods=["GET"])
def get_spaces():
    map_id = request.args.get("map_id", type=int)
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    return jsonify({"spaces": map_obj["spaces"]})


@app.route("/spaces", methods=["POST"])
def add_space():
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    map_id = data.get("map_id")
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(int(map_id))
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    name = data.get("name")
    stype = data.get("type")
    x = data.get("x")
    y = data.get("y")

    if name is None or stype is None or x is None or y is None:
        return jsonify({"status": "error", "message": "Missing fields"}), 400

    space = {
        "id": map_obj["next_space_id"],
        "name": name,
        "type": stype,
        "x": float(x),
        "y": float(y),
    }
    map_obj["next_space_id"] += 1
    map_obj["spaces"].append(space)
    save_all_data()

    print(f"[MAP {map_id}] New space:", space)
    return jsonify({"status": "ok", "space": space})


@app.route("/spaces/<int:space_id>", methods=["DELETE"])
def delete_space(space_id):
    """
    Delete a space in a specific map.
    Also deletes any hallways connected to that space.
    """
    map_id = request.args.get("map_id", type=int)
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    spaces = map_obj["spaces"]
    hallways = map_obj["hallways"]

    before_spaces = len(spaces)
    spaces[:] = [s for s in spaces if s["id"] != space_id]
    after_spaces = len(spaces)

    before_hallways = len(hallways)
    hallways[:] = [
        h for h in hallways
        if h.get("from_space_id") != space_id and h.get("to_space_id") != space_id
    ]
    after_hallways = len(hallways)

    save_all_data()

    print(
        f"[MAP {map_id}] Deleted space {space_id}. "
        f"Spaces: {before_spaces}->{after_spaces}, "
        f"Hallways: {before_hallways}->{after_hallways}"
    )

    return jsonify({
        "status": "ok",
        "map_id": map_id,
        "deleted_space_id": space_id,
        "remaining_spaces": after_spaces,
        "remaining_hallways": after_hallways
    })


# --------- Hallways (per map) ---------

@app.route("/hallways", methods=["GET"])
def get_hallways():
    map_id = request.args.get("map_id", type=int)
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    return jsonify({"hallways": map_obj["hallways"]})


@app.route("/hallways", methods=["POST"])
def add_hallway():
    """
    Add a hallway segment between two points in a specific map.
    Snap endpoints to nearest spaces or auto-create Intersections.
    """
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    map_id = data.get("map_id")
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(int(map_id))
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    name = data.get("name")
    x1 = data.get("x1")
    y1 = data.get("y1")
    x2 = data.get("x2")
    y2 = data.get("y2")

    if name is None or x1 is None or y1 is None or x2 is None or y2 is None:
        return jsonify({"status": "error", "message": "Missing fields"}), 400

    s1 = find_or_create_space_at(map_obj, float(x1), float(y1))
    s2 = find_or_create_space_at(map_obj, float(x2), float(y2))

    hallway = {
        "id": map_obj["next_hallway_id"],
        "name": name,
        "x1": s1["x"],
        "y1": s1["y"],
        "x2": s2["x"],
        "y2": s2["y"],
        "from_space_id": s1["id"],
        "to_space_id": s2["id"],
    }
    map_obj["next_hallway_id"] += 1
    map_obj["hallways"].append(hallway)
    save_all_data()

    print(f"[MAP {map_id}] New hallway:", hallway)
    return jsonify({"status": "ok", "hallway": hallway})


@app.route("/hallways/<int:hallway_id>", methods=["DELETE"])
def delete_hallway(hallway_id):
    """
    Delete a hallway segment by id in a specific map.
    """
    map_id = request.args.get("map_id", type=int)
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    hallways = map_obj["hallways"]
    before = len(hallways)
    hallways[:] = [h for h in hallways if h["id"] != hallway_id]
    after = len(hallways)

    save_all_data()

    print(f"[MAP {map_id}] Deleted hallway {hallway_id}. Hallways: {before}->{after}")

    return jsonify({
        "status": "ok",
        "map_id": map_id,
        "deleted_hallway_id": hallway_id,
        "remaining_hallways": after
    })


# --------- Route (per map) ---------

@app.route("/route", methods=["POST"])
def route():
    """
    Compute shortest route between two spaces in a specific map.
    Expected JSON:
      {
        "map_id": 1,
        "from_space_id": 3,
        "to_space_id": 7
      }
    """
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    map_id = data.get("map_id")
    if not map_id:
        return jsonify({"status": "error", "message": "Missing map_id"}), 400

    map_obj = get_map(int(map_id))
    if not map_obj:
        return jsonify({"status": "error", "message": "Map not found"}), 404

    try:
        start_id = int(data.get("from_space_id"))
        end_id = int(data.get("to_space_id"))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid space ids"}), 400

    if not get_space_by_id(map_obj, start_id) or not get_space_by_id(map_obj, end_id):
        return jsonify({"status": "error", "message": "One or both spaces not found"}), 400

    if start_id == end_id:
        return jsonify({
            "status": "ok",
            "space_ids": [start_id],
            "hallway_ids": [],
            "message": "Start and end are the same space."
        })

    space_path, hallway_path = dijkstra_shortest_path(map_obj, start_id, end_id)
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


# --------- Congestion simulation (per map) ---------

def compute_congestion(map_obj, from_index, to_index, filter_space_id=None, filter_direction="any"):
    """
    For each student in a map, look at transitions from period[from_index] -> period[from_index+1],
    from_index+1 -> from_index+2, ..., up to to_index-1 -> to_index,
    and count how many times each hallway is used.

    filter_space_id: optional space_id to filter on
    filter_direction: "any", "arriving", or "leaving"
    """
    counts = {}
    period_names = map_obj.get("period_names", [])
    student_schedules = map_obj.get("student_schedules", [])

    # Basic validation
    if not period_names or not student_schedules:
        return counts, 0

    # We are going to iterate p in [from_index, to_index-1] and use p+1,
    # so to_index must be at least from_index+1 and < len(period_names).
    if from_index < 0 or to_index <= from_index:
        return counts, 0
    if to_index >= len(period_names):
        return counts, 0

    total_trips = 0

    for student in student_schedules:
        space_ids = student["space_ids"]
        if len(space_ids) <= to_index:
            # Not enough periods for this student
            continue

        # For each consecutive pair in the chosen window
        for p in range(from_index, to_index):
            s_from = space_ids[p]
            s_to = space_ids[p + 1]

            if s_from is None or s_to is None:
                continue
            if s_from == s_to:
                continue

            # Apply classroom + direction filter if requested
            if filter_space_id is not None:
                if filter_direction == "arriving":
                    if s_to != filter_space_id:
                        continue
                elif filter_direction == "leaving":
                    if s_from != filter_space_id:
                        continue
                else:  # "any"
                    if s_from != filter_space_id and s_to != filter_space_id:
                        continue

            space_path, hallway_path = dijkstra_shortest_path(map_obj, s_from, s_to)
            if space_path is None or not hallway_path:
                continue

            total_trips += 1
            for h_id in hallway_path:
                counts[h_id] = counts.get(h_id, 0) + 1

    return counts, total_trips


@app.route("/congestion", methods=["POST"])
def congestion():
    data = request.get_json() or {}

    map_id = data.get("map_id")
    if map_id is None:
        return jsonify({"status": "error", "message": "map_id is required"}), 400

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "map_id must be an integer"}), 400

    map_obj = get_map(map_id)
    if not map_obj:
        return jsonify({"status": "error", "message": f"Map {map_id} not found"}), 404

    # From/to period indices (we interpret as a window of consecutive transitions)
    from_idx = data.get("from_period_index")
    to_idx = data.get("to_period_index")

    if from_idx is None or to_idx is None:
        return jsonify({"status": "error", "message": "from_period_index and to_period_index are required"}), 400

    try:
        from_idx = int(from_idx)
        to_idx = int(to_idx)
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "from_period_index and to_period_index must be integers"}), 400

    # Optional filters
    raw_filter_space_id = data.get("filter_space_id")
    filter_space_id = None
    if raw_filter_space_id not in (None, ""):
        try:
            filter_space_id = int(raw_filter_space_id)
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "filter_space_id must be an integer"}), 400

    filter_direction = (data.get("filter_direction") or "any").lower()
    if filter_direction not in ("any", "arriving", "leaving"):
        filter_direction = "any"

    period_names = map_obj.get("period_names", [])
    if not period_names:
        return jsonify({"status": "error", "message": "No schedule loaded for this map."}), 400

    if from_idx < 0 or to_idx >= len(period_names) or to_idx <= from_idx:
        return jsonify({"status": "error", "message": "Invalid period index range."}), 400

    # Compute hallway usage
    hallway_counts, total_trips = compute_congestion(
        map_obj,
        from_idx,
        to_idx,
        filter_space_id=filter_space_id,
        filter_direction=filter_direction,
    )

    max_count = max(hallway_counts.values()) if hallway_counts else 0

    hallway_counts_list = [
        {"hallway_id": hid, "count": count}
        for hid, count in hallway_counts.items()
    ]

    period_from_name = period_names[from_idx]
    period_to_name = period_names[to_idx]

    return jsonify({
        "status": "ok",
        "hallway_counts": hallway_counts_list,
        "period_from": period_from_name,
        "period_to": period_to_name,
        "total_trips": total_trips,
        "max_count": max_count
    })


if __name__ == "__main__":
    app.run(debug=True)
