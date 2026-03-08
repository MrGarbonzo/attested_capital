import { describe, it, expect } from 'vitest';
import {
  parseProtocolMessage,
  formatAgentAnnounce,
  formatGuardianAnnounce,
  formatDiscoverRequest,
  formatDiscoverResponse,
  formatProposalNew,
  formatProposalResult,
  formatHeartbeatStatus,
} from '../../src/agent/telegram-protocol.js';

describe('telegram-protocol (fund manager copy)', () => {
  describe('format/parse round-trips', () => {
    it('agent announce', () => {
      const data = { endpoint: 'http://agent:3000', teeId: 'tee-abc123', codeHash: 'sha256:deadbeef' };
      const text = formatAgentAnnounce(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'agent_announce', data });
    });

    it('guardian announce', () => {
      const data = { address: 'guardian-1', endpoint: 'http://g1:3100', isSentry: true };
      const text = formatGuardianAnnounce(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'guardian_announce', data });
    });

    it('discover request', () => {
      const text = formatDiscoverRequest();
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'discover_request' });
    });

    it('discover response', () => {
      const data = { address: 'guardian-1', endpoint: 'http://g1:3100', isSentry: false };
      const text = formatDiscoverResponse(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'discover_response', data });
    });

    it('proposal new', () => {
      const data = { id: 'prop-abc123', type: 'strategy_change', thresholdPct: 20, deadline: '2026-03-01T00:00:00.000Z' };
      const text = formatProposalNew(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'proposal_new', data });
    });

    it('proposal result', () => {
      const data = { id: 'prop-abc123', status: 'approved' as const, approvalPct: 85.5 };
      const text = formatProposalResult(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'proposal_result', data });
    });

    it('heartbeat status', () => {
      const data = { active: true, uptime: 3600 };
      const text = formatHeartbeatStatus(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'heartbeat_status', data });
    });
  });

  describe('malformed input', () => {
    it('returns null for empty string', () => {
      expect(parseProtocolMessage('')).toBeNull();
    });

    it('returns null for random text', () => {
      expect(parseProtocolMessage('hello world')).toBeNull();
    });

    it('returns null for incomplete agent announce', () => {
      expect(parseProtocolMessage('[ANNOUNCE:AGENT] endpoint=http://x')).toBeNull();
    });

    it('handles whitespace', () => {
      expect(parseProtocolMessage('  [DISCOVER:REQUEST]  ')).toEqual({ kind: 'discover_request' });
    });
  });
});
