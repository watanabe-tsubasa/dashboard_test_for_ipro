CREATE TABLE IF NOT EXISTS cameras (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS camera_lines (
  camera_id TEXT NOT NULL REFERENCES cameras(id),
  line_no INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 8),
  display_name TEXT,
  include_in_visitors INTEGER NOT NULL DEFAULT 0 CHECK (include_in_visitors IN (0, 1)),
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (camera_id, line_no)
);

CREATE TABLE IF NOT EXISTS linecross_hourly (
  camera_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 1440),
  expected_end_utc TEXT NOT NULL,
  measured_until_utc TEXT NOT NULL,
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  count_in INTEGER NOT NULL CHECK (count_in BETWEEN 0 AND 65535),
  count_out INTEGER NOT NULL CHECK (count_out BETWEEN 0 AND 65535),
  source_captured_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (camera_id, line_no, start_utc, interval_minutes),
  FOREIGN KEY (camera_id, line_no) REFERENCES camera_lines(camera_id, line_no)
);

CREATE TABLE IF NOT EXISTS heatmaps_hourly (
  camera_id TEXT NOT NULL REFERENCES cameras(id),
  kind TEXT NOT NULL CHECK (kind IN ('heatmap_mov', 'heatmap_loi')),
  start_utc TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 1440),
  expected_end_utc TEXT NOT NULL,
  measured_until_utc TEXT NOT NULL,
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  grid_json TEXT NOT NULL CHECK (json_valid(grid_json) AND json_array_length(grid_json) = 64),
  max_value INTEGER NOT NULL CHECK (max_value BETWEEN 0 AND 65535),
  nonzero_cells INTEGER NOT NULL CHECK (nonzero_cells BETWEEN 0 AND 4096),
  source_captured_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (camera_id, kind, start_utc, interval_minutes)
);

CREATE INDEX IF NOT EXISTS linecross_camera_time ON linecross_hourly(camera_id, start_utc);
CREATE INDEX IF NOT EXISTS heatmaps_camera_time ON heatmaps_hourly(camera_id, start_utc);

INSERT INTO cameras (id, display_name, created_at_utc, updated_at_utc)
VALUES
  ('food', 'Food', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('island', 'Island', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (id) DO NOTHING;

WITH RECURSIVE line_numbers(line_no) AS (
  SELECT 1 UNION ALL SELECT line_no + 1 FROM line_numbers WHERE line_no < 8
)
INSERT INTO camera_lines (camera_id, line_no, display_name, updated_at_utc)
SELECT cameras.id, line_no, 'Line ' || line_no, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM cameras CROSS JOIN line_numbers
WHERE cameras.id IN ('food', 'island')
ON CONFLICT (camera_id, line_no) DO NOTHING;
