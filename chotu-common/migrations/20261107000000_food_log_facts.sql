-- User facts for meals logged outside Signal (the app), so a later correction
-- keeps earlier explicit facts such as "no dairy". Signal meals keep theirs in
-- food_signal_context; a meal has a row in at most one of the two.
CREATE TABLE IF NOT EXISTS food_log_facts (
    food_log_id TEXT PRIMARY KEY REFERENCES food_log(id) ON DELETE CASCADE,
    user_facts TEXT NOT NULL
);
