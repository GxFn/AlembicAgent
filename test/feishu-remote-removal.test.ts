import { describe, expect, it } from 'vitest';

import { BUILTIN_PROFILES, PRESETS } from '../src/agent/profiles/index.js';
import { AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage, Channel } from '../src/agent/runtime/AgentMessage.js';
import { PresetName } from '../src/agent/service/AgentRouter.js';

const removedChatBridge = ['lar', 'k'].join('');
const removedCommandPreset = ['remote', 'exec'].join('-');
const removedMessageFactory = ['from', 'La', 'rk'].join('');
const removedMessageEvent = ['LA', 'RK_MESSAGE'].join('');

describe('removed external bridge contract', () => {
  it('does not expose removed presets or profiles', () => {
    expect(Object.keys(PRESETS)).not.toContain(removedChatBridge);
    expect(Object.keys(PRESETS)).not.toContain(removedCommandPreset);
    expect(BUILTIN_PROFILES.map((profile) => profile.id)).not.toContain(
      `${removedChatBridge}-chat`
    );
    expect(BUILTIN_PROFILES.map((profile) => profile.id)).not.toContain(removedCommandPreset);
    expect(Object.values(PresetName)).not.toContain(removedChatBridge);
    expect(Object.values(PresetName)).not.toContain(removedCommandPreset);
  });

  it('does not expose removed message channel, factory, or event', () => {
    expect(Object.values(Channel)).not.toContain(removedChatBridge);
    expect(removedMessageFactory in AgentMessage).toBe(false);
    expect(removedMessageEvent in AgentEvents).toBe(false);
  });
});
