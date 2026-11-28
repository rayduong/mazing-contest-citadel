import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

function inferInitialSsl(connectionString) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') {
    return { rejectUnauthorized: false };
  }
  try {
    const parsed = new URL(connectionString);
    const sslMode = parsed.searchParams.get('sslmode');
    if (sslMode === 'disable') return false;
    if (
      sslMode === 'require' ||
      sslMode === 'verify-ca' ||
      sslMode === 'verify-full' ||
      sslMode === 'no-verify'
    ) {
      return { rejectUnauthorized: false };
    }
    const host = (parsed.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }
    // Render internal Postgres hostnames have no dots (e.g. dpg-xxxx-a) and default to non-SSL,
    // while external hostnames (*.render.com, *.neon.tech, *.supabase.co) require SSL.
    if (!host.includes('.')) {
      return false;
    }
    return { rejectUnauthorized: false };
  } catch {
    return { rejectUnauthorized: false };
  }
}

async function createConnectedPool(connectionString) {
  const firstSsl = inferInitialSsl(connectionString);
  const attempts = [firstSsl, firstSsl ? false : { rejectUnauthorized: false }];

  let lastErr = null;
  for (const sslOption of attempts) {
    const pool = new Pool({
      connectionString,
      ssl: sslOption,
      max: 6,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.warn('Postgres pool background error:', err?.message || err);
    });
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      lastErr = err;
      await pool.end().catch(() => {});
    }
  }
  throw lastErr || new Error('Could not connect to PostgreSQL');
}

function sanitizeStoredTowers(rawTowers) {
  if (!Array.isArray(rawTowers)) return [];
  const out = [];
  for (const t of rawTowers) {
    if (!t || typeof t !== 'object') continue;
    const x = Math.floor(Number(t.x));
    const y = Math.floor(Number(t.y));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.push({ x, y });
    }
  }
  return out;
}

function normalizeDailyEntryRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let parsedAttempts = raw.attempts;
  if (typeof parsedAttempts === 'string') {
    try {
      parsedAttempts = JSON.parse(parsedAttempts);
    } catch {
      parsedAttempts = [];
    }
  }
  const cleanAttempts = [];
  if (Array.isArray(parsedAttempts)) {
    for (let i = 0; i < parsedAttempts.length; i++) {
      const a = parsedAttempts[i];
      if (!a || typeof a !== 'object') continue;
      cleanAttempts.push({
        id: String(a.id || `${raw.id || 'att'}_${i + 1}`),
        attemptNumber: Math.max(1, Math.floor(Number(a.attemptNumber) || i + 1)),
        survivalTimeSeconds: Number(Number(a.survivalTimeSeconds || 0).toFixed(2)),
        parTimeSeconds: Number(a.parTimeSeconds ?? raw.parTimeSeconds ?? 28),
        beatPar: Boolean(a.beatPar),
        clapsTaken: Number(a.clapsTaken) || 0,
        overchargedSpires: Number(a.overchargedSpires) || 0,
        linkedKeeps: Number(a.linkedKeeps) || 0,
        pathDistance: Number(Number(a.pathDistance || 0).toFixed(1)),
        wallsUsed: Number(a.wallsUsed) || 0,
        towers: sanitizeStoredTowers(a.towers),
        timestamp: Number(a.timestamp) || Number(raw.timestamp) || Date.now(),
      });
    }
  }

  // Synthesize Attempt 1 for legacy rows created before multi-attempt tracking
  if (cleanAttempts.length === 0) {
    cleanAttempts.push({
      id: `${raw.id || 'daily'}_a1`,
      attemptNumber: 1,
      survivalTimeSeconds: Number(Number(raw.survivalTimeSeconds || 0).toFixed(2)),
      parTimeSeconds: Number(raw.parTimeSeconds ?? 28),
      beatPar: Boolean(raw.beatPar),
      clapsTaken: Number(raw.clapsTaken) || 0,
      overchargedSpires: Number(raw.overchargedSpires) || 0,
      linkedKeeps: Number(raw.linkedKeeps) || 0,
      pathDistance: Number(Number(raw.pathDistance || 0).toFixed(1)),
      wallsUsed: Number(raw.wallsUsed) || 0,
      towers: [],
      timestamp: Number(raw.timestamp) || Date.now(),
    });
  }

  const attemptsUsed = Math.max(
    cleanAttempts.length,
    Math.floor(Number(raw.attemptsUsed) || 1)
  );
  const bestAttemptNumber = Math.max(
    1,
    Math.min(
      attemptsUsed,
      Math.floor(Number(raw.bestAttemptNumber) || cleanAttempts[0].attemptNumber || 1)
    )
  );

  return {
    id: String(raw.id),
    clientId: String(raw.clientId),
    playerName: String(raw.playerName || 'Player'),
    playerColor: String(raw.playerColor || '#38bdf8'),
    survivalTimeSeconds: Number(Number(raw.survivalTimeSeconds || 0).toFixed(2)),
    parTimeSeconds: Number(raw.parTimeSeconds ?? 28),
    beatPar: Boolean(raw.beatPar),
    clapsTaken: Number(raw.clapsTaken) || 0,
    overchargedSpires: Number(raw.overchargedSpires) || 0,
    linkedKeeps: Number(raw.linkedKeeps) || 0,
    pathDistance: Number(Number(raw.pathDistance || 0).toFixed(1)),
    wallsUsed: Number(raw.wallsUsed) || 0,
    attemptsUsed,
    bestAttemptNumber,
    attempts: cleanAttempts,
    timestamp: Number(raw.timestamp) || Date.now(),
  };
}

export function createPersistenceStorage({
  defaultDataDir,
  leaderboardFilename = 'leaderboard.json',
  dailyFilename = 'daily_leaderboard.json',
  dailyPuzzlesFilename = 'daily_puzzles.json',
}) {
  const customDataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : null;
  const dataDir = customDataDir || defaultDataDir;
  const leaderboardFile = path.join(dataDir, leaderboardFilename);
  const dailyFile = path.join(dataDir, dailyFilename);
  const dailyPuzzlesFile = path.join(dataDir, dailyPuzzlesFilename);
  const databaseUrl = (process.env.DATABASE_URL || '').trim();

  /** @type {import('pg').Pool | null} */
  let pool = null;
  let backend = customDataDir ? 'disk' : 'ephemeral_file';

  let lbWriteInFlight = false;
  let lbWriteQueued = false;
  let dailyWriteInFlight = false;
  let dailyWriteQueued = false;
  let puzzlesWriteInFlight = false;
  let puzzlesWriteQueued = false;

  async function writeFileAtomic(filePath, json) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, json, 'utf-8');
      await fs.promises.rename(tmpPath, filePath);
    } catch {
      await fs.promises.writeFile(filePath, json, 'utf-8');
    }
  }

  async function init() {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (databaseUrl) {
      try {
        pool = await createConnectedPool(databaseUrl);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS daily_maze_entries (
            id TEXT PRIMARY KEY,
            date_key TEXT NOT NULL,
            client_id TEXT NOT NULL,
            player_name TEXT NOT NULL,
            player_color TEXT NOT NULL,
            survival_time_seconds DOUBLE PRECISION NOT NULL,
            par_time_seconds DOUBLE PRECISION NOT NULL,
            beat_par BOOLEAN NOT NULL DEFAULT FALSE,
            claps_taken INTEGER NOT NULL DEFAULT 0,
            overcharged_spires INTEGER NOT NULL DEFAULT 0,
            linked_keeps INTEGER NOT NULL DEFAULT 0,
            path_distance DOUBLE PRECISION NOT NULL DEFAULT 0,
            walls_used INTEGER NOT NULL DEFAULT 0,
            attempts_used INTEGER NOT NULL DEFAULT 1,
            best_attempt_number INTEGER NOT NULL DEFAULT 1,
            attempts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at_ms BIGINT NOT NULL,
            UNIQUE (date_key, client_id)
          );
          ALTER TABLE daily_maze_entries
            ADD COLUMN IF NOT EXISTS attempts_used INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE daily_maze_entries
            ADD COLUMN IF NOT EXISTS best_attempt_number INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE daily_maze_entries
            ADD COLUMN IF NOT EXISTS attempts_json JSONB NOT NULL DEFAULT '[]'::jsonb;
          CREATE INDEX IF NOT EXISTS idx_daily_maze_date_key
            ON daily_maze_entries (date_key);
          CREATE TABLE IF NOT EXISTS daily_maze_puzzles (
            date_key TEXT PRIMARY KEY,
            puzzle_number INTEGER NOT NULL,
            round_config JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS app_kv_store (
            key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        backend = 'postgres';
        console.log('Persistence backend: PostgreSQL (DATABASE_URL)');
      } catch (err) {
        console.error(
          'Failed to initialize PostgreSQL storage, falling back to local files:',
          err?.message || err
        );
        pool = null;
      }
    }

    if (backend === 'ephemeral_file' && process.env.NODE_ENV === 'production') {
      console.warn(
        '[WARNING] DATABASE_URL and DATA_DIR are not set in production! ' +
          'Leaderboards will be stored on ephemeral local disk and reset on service spin-down/redeploy.'
      );
    }
  }

  async function loadLeaderboard(fallbackSeeded) {
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT payload FROM app_kv_store WHERE key = 'leaderboard'`
        );
        if (
          res.rows.length > 0 &&
          res.rows[0].payload?.roundRecords &&
          res.rows[0].payload?.champions
        ) {
          return res.rows[0].payload;
        }
        // Seed DB from local file or default seeded leaderboard on first boot
        let initial = fallbackSeeded;
        try {
          if (fs.existsSync(leaderboardFile)) {
            const parsed = JSON.parse(fs.readFileSync(leaderboardFile, 'utf-8'));
            if (parsed?.roundRecords && parsed?.champions) {
              initial = parsed;
            }
          }
        } catch {
          // ignore
        }
        await pool.query(
          `INSERT INTO app_kv_store (key, payload, updated_at)
           VALUES ('leaderboard', $1::jsonb, NOW())
           ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify(initial)]
        );
        return initial;
      } catch (err) {
        console.warn('Failed to load leaderboard from Postgres:', err?.message || err);
      }
    }

    try {
      if (fs.existsSync(leaderboardFile)) {
        const parsed = JSON.parse(fs.readFileSync(leaderboardFile, 'utf-8'));
        if (parsed && parsed.roundRecords && parsed.champions) {
          return parsed;
        }
      } else {
        fs.writeFileSync(
          leaderboardFile,
          JSON.stringify(fallbackSeeded, null, 2)
        );
      }
    } catch (err) {
      console.warn('Could not read leaderboard.json, using seeded records:', err);
    }
    return fallbackSeeded;
  }

  async function saveLeaderboard(leaderboard) {
    leaderboard.updatedAt = Date.now();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO app_kv_store (key, payload, updated_at)
           VALUES ('leaderboard', $1::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE
             SET payload = EXCLUDED.payload, updated_at = NOW()`,
          [JSON.stringify(leaderboard)]
        );
      } catch (err) {
        console.warn('Failed to save leaderboard to Postgres:', err?.message || err);
      }
    }

    if (lbWriteInFlight) {
      lbWriteQueued = true;
      return;
    }
    lbWriteInFlight = true;
    try {
      do {
        lbWriteQueued = false;
        await writeFileAtomic(
          leaderboardFile,
          JSON.stringify(leaderboard, null, 2)
        );
      } while (lbWriteQueued);
    } catch (err) {
      console.warn('Failed to persist leaderboard.json:', err);
    } finally {
      lbWriteInFlight = false;
    }
  }

  async function loadDailyStore() {
    /** @type {{ days: Record<string, any[]>; updatedAt: number }} */
    const store = { days: {}, updatedAt: Date.now() };

    if (pool) {
      try {
        const res = await pool.query(`
          SELECT
            id,
            date_key,
            client_id,
            player_name,
            player_color,
            survival_time_seconds,
            par_time_seconds,
            beat_par,
            claps_taken,
            overcharged_spires,
            linked_keeps,
            path_distance,
            walls_used,
            attempts_used,
            best_attempt_number,
            attempts_json,
            created_at_ms
          FROM daily_maze_entries
          ORDER BY date_key DESC, survival_time_seconds DESC
          LIMIT 5000
        `);
        let maxTs = store.updatedAt;
        for (const row of res.rows) {
          const dk = row.date_key;
          if (!Array.isArray(store.days[dk])) store.days[dk] = [];
          const ts = Number(row.created_at_ms) || Date.now();
          if (ts > maxTs) maxTs = ts;
          const normalized = normalizeDailyEntryRecord({
            id: row.id,
            clientId: row.client_id,
            playerName: row.player_name,
            playerColor: row.player_color,
            survivalTimeSeconds: Number(row.survival_time_seconds),
            parTimeSeconds: Number(row.par_time_seconds),
            beatPar: Boolean(row.beat_par),
            clapsTaken: Number(row.claps_taken) || 0,
            overchargedSpires: Number(row.overcharged_spires) || 0,
            linkedKeeps: Number(row.linked_keeps) || 0,
            pathDistance: Number(row.path_distance) || 0,
            wallsUsed: Number(row.walls_used) || 0,
            attemptsUsed: Number(row.attempts_used) || 1,
            bestAttemptNumber: Number(row.best_attempt_number) || 1,
            attempts: row.attempts_json,
            timestamp: ts,
          });
          if (normalized) {
            store.days[dk].push(normalized);
          }
        }
        store.updatedAt = maxTs;
        return store;
      } catch (err) {
        console.warn('Failed to load daily entries from Postgres:', err?.message || err);
      }
    }

    try {
      if (fs.existsSync(dailyFile)) {
        const parsed = JSON.parse(fs.readFileSync(dailyFile, 'utf-8'));
        if (parsed && parsed.days && typeof parsed.days === 'object') {
          const normalizedDays = {};
          for (const [dk, list] of Object.entries(parsed.days)) {
            if (!Array.isArray(list)) continue;
            normalizedDays[dk] = list
              .map((item) => normalizeDailyEntryRecord(item))
              .filter(Boolean);
          }
          return {
            days: normalizedDays,
            updatedAt: Number(parsed.updatedAt) || Date.now(),
          };
        }
      } else {
        fs.writeFileSync(dailyFile, JSON.stringify(store, null, 2));
      }
    } catch (err) {
      console.warn('Could not read daily_leaderboard.json, starting fresh:', err);
    }
    return store;
  }

  async function saveDailyEntry(dateKey, entry, fullStore) {
    fullStore.updatedAt = Date.now();
    const safeAttempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    const attemptsUsed = Math.max(
      safeAttempts.length,
      Math.floor(Number(entry.attemptsUsed) || 1)
    );
    const bestAttemptNumber = Math.max(
      1,
      Math.min(attemptsUsed, Math.floor(Number(entry.bestAttemptNumber) || 1))
    );

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO daily_maze_entries (
            id, date_key, client_id, player_name, player_color,
            survival_time_seconds, par_time_seconds, beat_par,
            claps_taken, overcharged_spires, linked_keeps,
            path_distance, walls_used,
            attempts_used, best_attempt_number, attempts_json,
            created_at_ms
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13,
            $14, $15, $16::jsonb,
            $17
          )
          ON CONFLICT (date_key, client_id) DO UPDATE SET
            player_name = EXCLUDED.player_name,
            player_color = EXCLUDED.player_color,
            survival_time_seconds = EXCLUDED.survival_time_seconds,
            par_time_seconds = EXCLUDED.par_time_seconds,
            beat_par = EXCLUDED.beat_par,
            claps_taken = EXCLUDED.claps_taken,
            overcharged_spires = EXCLUDED.overcharged_spires,
            linked_keeps = EXCLUDED.linked_keeps,
            path_distance = EXCLUDED.path_distance,
            walls_used = EXCLUDED.walls_used,
            attempts_used = EXCLUDED.attempts_used,
            best_attempt_number = EXCLUDED.best_attempt_number,
            attempts_json = EXCLUDED.attempts_json,
            created_at_ms = EXCLUDED.created_at_ms`,
          [
            entry.id,
            dateKey,
            entry.clientId,
            entry.playerName,
            entry.playerColor,
            entry.survivalTimeSeconds,
            entry.parTimeSeconds,
            Boolean(entry.beatPar),
            entry.clapsTaken || 0,
            entry.overchargedSpires || 0,
            entry.linkedKeeps || 0,
            entry.pathDistance || 0,
            entry.wallsUsed || 0,
            attemptsUsed,
            bestAttemptNumber,
            JSON.stringify(safeAttempts),
            entry.timestamp || Date.now(),
          ]
        );
      } catch (err) {
        console.warn('Failed to persist daily entry to Postgres:', err?.message || err);
      }
    }

    if (dailyWriteInFlight) {
      dailyWriteQueued = true;
      return;
    }
    dailyWriteInFlight = true;
    try {
      do {
        dailyWriteQueued = false;
        const dayKeys = Object.keys(fullStore.days).sort();
        while (dayKeys.length > 14) {
          const oldest = dayKeys.shift();
          if (oldest) delete fullStore.days[oldest];
        }
        await writeFileAtomic(dailyFile, JSON.stringify(fullStore, null, 2));
      } while (dailyWriteQueued);
    } catch (err) {
      console.warn('Failed to persist daily_leaderboard.json:', err);
    } finally {
      dailyWriteInFlight = false;
    }
  }

  async function loadDailyPuzzles() {
    /** @type {{ puzzles: Record<string, { dateKey: string; puzzleNumber: number; roundConfig: any }>; updatedAt: number }} */
    const store = { puzzles: {}, updatedAt: Date.now() };

    if (pool) {
      try {
        const res = await pool.query(`
          SELECT date_key, puzzle_number, round_config
          FROM daily_maze_puzzles
          ORDER BY date_key DESC
          LIMIT 30
        `);
        for (const row of res.rows) {
          if (row.date_key && row.round_config && typeof row.round_config === 'object') {
            store.puzzles[row.date_key] = {
              dateKey: row.date_key,
              puzzleNumber: Number(row.puzzle_number) || 1,
              roundConfig: row.round_config,
            };
          }
        }
        return store;
      } catch (err) {
        console.warn('Failed to load daily puzzles from Postgres:', err?.message || err);
      }
    }

    try {
      if (fs.existsSync(dailyPuzzlesFile)) {
        const parsed = JSON.parse(fs.readFileSync(dailyPuzzlesFile, 'utf-8'));
        if (parsed && parsed.puzzles && typeof parsed.puzzles === 'object') {
          return {
            puzzles: parsed.puzzles,
            updatedAt: Number(parsed.updatedAt) || Date.now(),
          };
        }
      }
    } catch (err) {
      console.warn('Could not read daily_puzzles.json, starting fresh:', err);
    }
    return store;
  }

  async function getOrSaveDailyPuzzle(dateKey, generatedInfo, fullPuzzlesStore) {
    let canonical = generatedInfo;

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO daily_maze_puzzles (date_key, puzzle_number, round_config)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (date_key) DO NOTHING`,
          [
            dateKey,
            Number(generatedInfo.puzzleNumber) || 1,
            JSON.stringify(generatedInfo.roundConfig),
          ]
        );
        const res = await pool.query(
          `SELECT date_key, puzzle_number, round_config
           FROM daily_maze_puzzles
           WHERE date_key = $1`,
          [dateKey]
        );
        if (
          res.rows.length > 0 &&
          res.rows[0].round_config &&
          typeof res.rows[0].round_config === 'object'
        ) {
          canonical = {
            dateKey: res.rows[0].date_key,
            puzzleNumber: Number(res.rows[0].puzzle_number) || generatedInfo.puzzleNumber,
            roundConfig: res.rows[0].round_config,
          };
        }
      } catch (err) {
        console.warn('Failed to lock daily puzzle in Postgres:', err?.message || err);
      }
    }

    if (fullPuzzlesStore && typeof fullPuzzlesStore === 'object') {
      if (!fullPuzzlesStore.puzzles || typeof fullPuzzlesStore.puzzles !== 'object') {
        fullPuzzlesStore.puzzles = {};
      }
      if (!fullPuzzlesStore.puzzles[dateKey] || pool) {
        fullPuzzlesStore.puzzles[dateKey] = canonical;
      } else {
        canonical = fullPuzzlesStore.puzzles[dateKey];
      }
      fullPuzzlesStore.updatedAt = Date.now();

      if (puzzlesWriteInFlight) {
        puzzlesWriteQueued = true;
      } else {
        puzzlesWriteInFlight = true;
        try {
          do {
            puzzlesWriteQueued = false;
            const keys = Object.keys(fullPuzzlesStore.puzzles).sort();
            while (keys.length > 14) {
              const oldest = keys.shift();
              if (oldest) delete fullPuzzlesStore.puzzles[oldest];
            }
            await writeFileAtomic(
              dailyPuzzlesFile,
              JSON.stringify(fullPuzzlesStore, null, 2)
            );
          } while (puzzlesWriteQueued);
        } catch (err) {
          console.warn('Failed to persist daily_puzzles.json:', err);
        } finally {
          puzzlesWriteInFlight = false;
        }
      }
    }

    return canonical;
  }

  function getBackendName() {
    return backend;
  }

  return {
    init,
    loadLeaderboard,
    saveLeaderboard,
    loadDailyStore,
    saveDailyEntry,
    loadDailyPuzzles,
    getOrSaveDailyPuzzle,
    getBackendName,
  };
}
