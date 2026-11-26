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

export function createPersistenceStorage({
  defaultDataDir,
  leaderboardFilename = 'leaderboard.json',
  dailyFilename = 'daily_leaderboard.json',
}) {
  const customDataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : null;
  const dataDir = customDataDir || defaultDataDir;
  const leaderboardFile = path.join(dataDir, leaderboardFilename);
  const dailyFile = path.join(dataDir, dailyFilename);
  const databaseUrl = (process.env.DATABASE_URL || '').trim();

  /** @type {import('pg').Pool | null} */
  let pool = null;
  let backend = customDataDir ? 'disk' : 'ephemeral_file';

  let lbWriteInFlight = false;
  let lbWriteQueued = false;
  let dailyWriteInFlight = false;
  let dailyWriteQueued = false;

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
            created_at_ms BIGINT NOT NULL,
            UNIQUE (date_key, client_id)
          );
          CREATE INDEX IF NOT EXISTS idx_daily_maze_date_key
            ON daily_maze_entries (date_key);
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
          store.days[dk].push({
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
            timestamp: ts,
          });
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
          return parsed;
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
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO daily_maze_entries (
            id, date_key, client_id, player_name, player_color,
            survival_time_seconds, par_time_seconds, beat_par,
            claps_taken, overcharged_spires, linked_keeps,
            path_distance, walls_used, created_at_ms
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14
          )
          ON CONFLICT (date_key, client_id) DO NOTHING`,
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

  function getBackendName() {
    return backend;
  }

  return {
    init,
    loadLeaderboard,
    saveLeaderboard,
    loadDailyStore,
    saveDailyEntry,
    getBackendName,
  };
}
