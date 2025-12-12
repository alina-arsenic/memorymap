INSERT INTO groups (id, name, visibility)
VALUES (1, 'Public map', 'public')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    visibility = EXCLUDED.visibility;
