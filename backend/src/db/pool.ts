import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? resolve(process.cwd(), '..', '.env') });
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}