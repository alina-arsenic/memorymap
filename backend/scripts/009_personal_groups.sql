-- Fix personal group duplication: add owner_id + is_personal, backfill, merge duplicates
ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill owner_id from membership(owner)
UPDATE groups g
SET owner_id = m.user_id
FROM membership m
WHERE m.group_id = g.id AND m.role = 'owner' AND g.owner_id IS NULL;

-- Merge duplicate personal groups per user:
-- We treat "personal candidates" as private groups owned by user and named like 'Личная карта%'.
DO $$
DECLARE
  uid INT;
  keep_gid INT;
  dup_gid INT;
BEGIN
  FOR uid IN
    SELECT DISTINCT m.user_id
    FROM membership m
    JOIN groups g ON g.id = m.group_id
    WHERE m.role='owner' AND g.visibility='private' AND g.name LIKE 'Личная карта%'
  LOOP
    -- choose group to keep: prefer exact 'Личная карта <uid>', else smallest id
    SELECT g.id INTO keep_gid
    FROM groups g
    JOIN membership m ON m.group_id=g.id
    WHERE m.user_id=uid AND m.role='owner' AND g.visibility='private'
      AND (g.name = ('Личная карта ' || uid) OR g.name LIKE 'Личная карта%')
    ORDER BY CASE WHEN g.name = ('Личная карта ' || uid) THEN 0 ELSE 1 END, g.id
    LIMIT 1;

    -- Reassign places from duplicates to keep
    FOR dup_gid IN
      SELECT g.id
      FROM groups g
      JOIN membership m ON m.group_id=g.id
      WHERE m.user_id=uid AND m.role='owner' AND g.visibility='private' AND g.name LIKE 'Личная карта%'
        AND g.id <> keep_gid
    LOOP
      UPDATE places SET group_id = keep_gid WHERE group_id = dup_gid;
      -- Remove memberships for dup group
      DELETE FROM membership WHERE group_id = dup_gid;
      -- Delete duplicate group
      DELETE FROM groups WHERE id = dup_gid;
    END LOOP;

    -- Mark kept group as personal and set canonical name
    UPDATE groups SET is_personal = TRUE, owner_id = uid, name = ('Личная карта ' || uid)
    WHERE id = keep_gid;
  END LOOP;
END$$;

-- Ensure unique constraint exists
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personal_group_per_owner ON groups (owner_id) WHERE is_personal = TRUE;
