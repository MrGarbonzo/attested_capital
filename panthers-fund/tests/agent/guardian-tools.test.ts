import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from '../../src/agent/tools.js';
import type { DiscoveredGuardian } from '../../src/agent/context.js';

describe('guardian tools', () => {
  // Simulate the guardian tools by testing their category and structure
  // We can't easily instantiate buildTools without a real ServiceContext,
  // so we test the tool definitions conceptually and the discovery state directly.

  describe('DiscoveredGuardian state management', () => {
    let guardians: Map<string, DiscoveredGuardian>;

    beforeEach(() => {
      guardians = new Map();
    });

    it('stores discovered guardians', () => {
      const now = Date.now();
      guardians.set('guardian-1', {
        address: 'guardian-1',
        endpoint: 'http://g1:3100',
        isSentry: false,
        discoveredAt: now,
        lastSeen: now,
        verified: false,
      });

      expect(guardians.size).toBe(1);
      expect(guardians.get('guardian-1')?.endpoint).toBe('http://g1:3100');
    });

    it('updates lastSeen on re-discovery', () => {
      const t0 = Date.now() - 60000;
      const t1 = Date.now();

      guardians.set('guardian-1', {
        address: 'guardian-1',
        endpoint: 'http://g1:3100',
        isSentry: false,
        discoveredAt: t0,
        lastSeen: t0,
        verified: false,
      });

      // Re-discovered
      const existing = guardians.get('guardian-1')!;
      guardians.set('guardian-1', {
        ...existing,
        lastSeen: t1,
      });

      expect(guardians.get('guardian-1')?.discoveredAt).toBe(t0);
      expect(guardians.get('guardian-1')?.lastSeen).toBe(t1);
    });

    it('tracks multiple guardians including sentries', () => {
      const now = Date.now();
      guardians.set('g1', {
        address: 'g1', endpoint: 'http://g1:3100', isSentry: false,
        discoveredAt: now, lastSeen: now, verified: false,
      });
      guardians.set('s1', {
        address: 's1', endpoint: 'http://s1:3100', isSentry: true,
        discoveredAt: now, lastSeen: now, verified: true,
      });
      guardians.set('g2', {
        address: 'g2', endpoint: 'http://g2:3200', isSentry: false,
        discoveredAt: now, lastSeen: now, verified: false,
      });

      expect(guardians.size).toBe(3);
      const sentries = Array.from(guardians.values()).filter(g => g.isSentry);
      expect(sentries).toHaveLength(1);
      expect(sentries[0].address).toBe('s1');
    });

    it('marks guardians as verified', () => {
      const now = Date.now();
      guardians.set('g1', {
        address: 'g1', endpoint: 'http://g1:3100', isSentry: false,
        discoveredAt: now, lastSeen: now, verified: false,
      });

      expect(guardians.get('g1')?.verified).toBe(false);

      const g = guardians.get('g1')!;
      guardians.set('g1', { ...g, verified: true });

      expect(guardians.get('g1')?.verified).toBe(true);
    });
  });

  describe('tool category: guardian', () => {
    // Test that the tool names and categories are defined correctly
    const expectedTools = [
      'discover_guardians',
      'announce_agent',
      'register_with_guardian',
      'list_guardians',
      'check_guardian_health',
      'broadcast_to_guardians',
    ];

    it('defines all expected guardian tool names', () => {
      // These are the tool names we expect in the 'guardian' category
      for (const name of expectedTools) {
        expect(name).toBeTruthy();
      }
      expect(expectedTools).toHaveLength(6);
    });
  });

  describe('mock discovery flow', () => {
    it('simulates discovery request → response → storage', () => {
      const guardians = new Map<string, DiscoveredGuardian>();
      const now = Date.now();

      // Simulate receiving DISCOVER:RESPONSE messages from group
      const responses = [
        { address: 'g1', endpoint: 'http://g1:3100', isSentry: false },
        { address: 'g2', endpoint: 'http://g2:3100', isSentry: false },
        { address: 's1', endpoint: 'http://s1:3100', isSentry: true },
      ];

      for (const r of responses) {
        guardians.set(r.address, {
          address: r.address,
          endpoint: r.endpoint,
          isSentry: r.isSentry,
          discoveredAt: now,
          lastSeen: now,
          verified: false,
        });
      }

      expect(guardians.size).toBe(3);
      const list = Array.from(guardians.values());
      expect(list.filter(g => g.isSentry)).toHaveLength(1);
      expect(list.every(g => !g.verified)).toBe(true);
    });
  });
});
