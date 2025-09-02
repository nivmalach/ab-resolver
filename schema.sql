-- Create experiments table
CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    baseline_url TEXT NOT NULL,
    test_url TEXT NOT NULL,
    allocation_b FLOAT DEFAULT 0.5,
    status TEXT DEFAULT 'draft',
    preserve_params BOOLEAN DEFAULT true,
    start_at TIMESTAMP WITH TIME ZONE,
    stop_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
