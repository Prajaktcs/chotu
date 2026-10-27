-- Exercise names inside a Google Health session (Fitbod writes them to the
-- session notes), newline-separated; NULL when the source app gave none.
ALTER TABLE exercise_log ADD COLUMN exercise_names TEXT;
