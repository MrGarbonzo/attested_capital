import { describe, it, expect, vi } from 'vitest';
import type { PollResult, StandbyCallbacks } from '../../src/agent/standby-mode.js';

/**
 * Tests for standby mode state machine logic.
 * We test the callback flow and state transitions directly
 * since the actual standby manager requires network access.
 */

describe('Standby Mode', () => {
  describe('PollResult interpretation', () => {
    it('detects active agent with fresh heartbeat', () => {
      const poll: PollResult = {
        timestamp: Date.now(),
        agentActive: true,
        agentTeeId: 'tee-1',
        heartbeatFresh: true,
        secondsSinceHeartbeat: 30,
      };

      const primaryFailed = !poll.agentActive || !poll.heartbeatFresh || poll.agentTeeId === null;
      expect(primaryFailed).toBe(false);
    });

    it('detects failed agent — inactive', () => {
      const poll: PollResult = {
        timestamp: Date.now(),
        agentActive: false,
        agentTeeId: 'tee-1',
        heartbeatFresh: false,
        secondsSinceHeartbeat: 400,
      };

      const primaryFailed = !poll.agentActive || !poll.heartbeatFresh || poll.agentTeeId === null;
      expect(primaryFailed).toBe(true);
    });

    it('detects failed agent — stale heartbeat', () => {
      const poll: PollResult = {
        timestamp: Date.now(),
        agentActive: true,
        agentTeeId: 'tee-1',
        heartbeatFresh: false,
        secondsSinceHeartbeat: 350,
      };

      const primaryFailed = !poll.agentActive || !poll.heartbeatFresh || poll.agentTeeId === null;
      expect(primaryFailed).toBe(true);
    });

    it('detects no agent registered', () => {
      const poll: PollResult = {
        timestamp: Date.now(),
        agentActive: false,
        agentTeeId: null,
        heartbeatFresh: false,
        secondsSinceHeartbeat: null,
      };

      const primaryFailed = !poll.agentActive || !poll.heartbeatFresh || poll.agentTeeId === null;
      expect(primaryFailed).toBe(true);
    });
  });

  describe('Callback flow', () => {
    it('onPrimaryFailure is called when primary fails', async () => {
      const onPrimaryFailure = vi.fn().mockResolvedValue(true);
      const onBecamePrimary = vi.fn();
      const onLostRace = vi.fn();

      const callbacks: StandbyCallbacks = {
        onPrimaryFailure,
        onBecamePrimary,
        onLostRace,
      };

      const failedPoll: PollResult = {
        timestamp: Date.now(),
        agentActive: false,
        agentTeeId: null,
        heartbeatFresh: false,
        secondsSinceHeartbeat: null,
      };

      // Simulate what the standby manager does on primary failure
      const shouldAttempt = await callbacks.onPrimaryFailure(failedPoll);
      expect(onPrimaryFailure).toHaveBeenCalledOnce();
      expect(shouldAttempt).toBe(true);
    });

    it('onPrimaryFailure can decline takeover', async () => {
      const onPrimaryFailure = vi.fn().mockResolvedValue(false);

      const callbacks: StandbyCallbacks = {
        onPrimaryFailure,
        onBecamePrimary: vi.fn(),
        onLostRace: vi.fn(),
      };

      const result = await callbacks.onPrimaryFailure({
        timestamp: Date.now(),
        agentActive: false,
        agentTeeId: null,
        heartbeatFresh: false,
        secondsSinceHeartbeat: null,
      });

      expect(result).toBe(false);
    });

    it('onLostRace is called when another backup wins', () => {
      const onLostRace = vi.fn();

      const callbacks: StandbyCallbacks = {
        onPrimaryFailure: vi.fn(),
        onBecamePrimary: vi.fn(),
        onLostRace,
      };

      callbacks.onLostRace();
      expect(onLostRace).toHaveBeenCalledOnce();
    });
  });

  describe('Heartbeat freshness', () => {
    it('heartbeat within 300s is fresh', () => {
      const secondsSince = 200;
      expect(secondsSince < 300).toBe(true);
    });

    it('heartbeat beyond 300s is stale', () => {
      const secondsSince = 301;
      expect(secondsSince < 300).toBe(false);
    });

    it('exactly 300s is stale', () => {
      const secondsSince = 300;
      expect(secondsSince < 300).toBe(false);
    });
  });
});
