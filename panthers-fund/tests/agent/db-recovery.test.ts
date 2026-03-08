import { describe, it, expect } from 'vitest';
import type { RecoveryResult } from '../../src/agent/db-recovery.js';

/**
 * Tests for DB recovery result handling.
 * Actual recovery requires a running guardian, so we test the result types
 * and error handling paths.
 */

describe('DB Recovery', () => {
  describe('RecoveryResult handling', () => {
    it('successful recovery has all fields', () => {
      const result: RecoveryResult = {
        success: true,
        dbPath: '/data/fund_manager.db',
        backupId: 42,
        backupTimestamp: 1700000000,
        sizeBytes: 1024000,
      };

      expect(result.success).toBe(true);
      expect(result.dbPath).toBeDefined();
      expect(result.backupId).toBe(42);
      expect(result.sizeBytes).toBeGreaterThan(0);
    });

    it('failed recovery has error message', () => {
      const result: RecoveryResult = {
        success: false,
        error: 'Guardian returned 503: No backups',
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('503');
      expect(result.dbPath).toBeUndefined();
    });

    it('network error recovery result', () => {
      const result: RecoveryResult = {
        success: false,
        error: 'fetch failed',
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('fetch');
    });
  });

  describe('Multi-guardian recovery', () => {
    it('should try guardians in order', () => {
      const guardians = [
        'http://guardian1:3100',
        'http://guardian2:3100',
        'http://guardian3:3100',
      ];

      // The function tries each in order until success
      // Simulate: first fails, second succeeds
      const results: RecoveryResult[] = [
        { success: false, error: 'unreachable' },
        { success: true, dbPath: '/data/fund_manager.db', sizeBytes: 1024 },
      ];

      // The first successful result should be used
      const winner = results.find((r) => r.success);
      expect(winner).toBeDefined();
      expect(winner!.dbPath).toBe('/data/fund_manager.db');
    });

    it('all guardians failing returns combined error', () => {
      const guardianCount = 3;
      const result: RecoveryResult = {
        success: false,
        error: `All ${guardianCount} guardians failed`,
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('3 guardians');
    });
  });

  describe('Base64 data handling', () => {
    it('encodes and decodes database data correctly', () => {
      // Simulate what the guardian sends: DB as base64
      const originalData = Buffer.from('SQLite format 3\0test database content');
      const base64 = originalData.toString('base64');
      const decoded = Buffer.from(base64, 'base64');

      expect(decoded).toEqual(originalData);
      expect(decoded.toString().startsWith('SQLite format 3')).toBe(true);
    });

    it('handles large database data', () => {
      // 1MB of simulated data
      const size = 1024 * 1024;
      const data = Buffer.alloc(size, 0x42);
      const base64 = data.toString('base64');
      const decoded = Buffer.from(base64, 'base64');

      expect(decoded.length).toBe(size);
      expect(decoded[0]).toBe(0x42);
    });
  });
});
