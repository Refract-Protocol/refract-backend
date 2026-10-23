import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { GossipReplayGuard } from './signed-reading-gossip';

@Injectable()
export class OracleGossipReplayRepository implements GossipReplayGuard {
  constructor(private readonly database: DatabaseService) {}

  async reserve(
    peerId: string,
    sequence: number,
    roundId: string,
    expiresAt: number,
  ): Promise<boolean> {
    const client = await this.database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM oracle_gossip_replays WHERE expires_at_ms < $1',
        [Date.now()],
      );

      const sequenceResult = await client.query(
        `INSERT INTO oracle_peer_sequences (peer_id, last_sequence)
         VALUES ($1, $2)
         ON CONFLICT (peer_id) DO UPDATE
           SET last_sequence = EXCLUDED.last_sequence,
               updated_at = now()
           WHERE oracle_peer_sequences.last_sequence < EXCLUDED.last_sequence
         RETURNING peer_id`,
        [peerId, sequence],
      );
      if (sequenceResult.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }

      const roundResult = await client.query(
        `INSERT INTO oracle_gossip_replays (peer_id, round_id, expires_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (peer_id, round_id) DO NOTHING
         RETURNING peer_id`,
        [peerId, roundId, expiresAt],
      );
      if (roundResult.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
